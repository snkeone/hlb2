// @ts-nocheck
// logic/decision_b0.js
// B0: Higher-TF SR slicing layer (daily arena -> coarse 1h-scale SR map)

import { getTradeConfig } from '../config/trade.js';

function toNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function resolveArenaRange(aResult, bufferUsd = 0) {
  const topA = toNumber(aResult?.arena?.channelTop);
  const bottomA = toNumber(aResult?.arena?.channelBottom);
  if (Number.isFinite(topA) && Number.isFinite(bottomA) && topA > bottomA) {
    const buffer = Math.max(0, toNumber(bufferUsd, 0));
    return {
      top: topA + buffer,
      bottom: bottomA - buffer,
      source: 'a_arena_1h'
    };
  }
  return null;
}

function normalizeLevels(depthSR) {
  const levels = [];
  const pushLevel = (side, price, thickness = 0, notionalUsd = 0, source = 'depth') => {
    const p = toNumber(price);
    if (!Number.isFinite(p)) return;
    levels.push({
      side,
      price: p,
      thickness: Math.max(0, toNumber(thickness, 0)),
      notionalUsd: Math.max(0, toNumber(notionalUsd, 0)),
      source
    });
  };

  pushLevel('support', depthSR?.supportCenter, depthSR?.supportWidth, 0, 'center');
  pushLevel('resistance', depthSR?.resistanceCenter, depthSR?.resistanceWidth, 0, 'center');

  const supports = Array.isArray(depthSR?.support) ? depthSR.support : [];
  const resistances = Array.isArray(depthSR?.resistance) ? depthSR.resistance : [];
  for (let i = 0; i < supports.length; i += 1) {
    pushLevel(
      'support',
      supports[i],
      depthSR?.supportThickness?.[i],
      depthSR?.supportNotional?.[i],
      'band'
    );
  }
  for (let i = 0; i < resistances.length; i += 1) {
    pushLevel(
      'resistance',
      resistances[i],
      depthSR?.resistanceThickness?.[i],
      depthSR?.resistanceNotional?.[i],
      'band'
    );
  }
  return levels;
}

function clusterBySide(levels, mergeDistanceUsd, maxClustersPerSide) {
  const bySide = {
    support: levels.filter(l => l.side === 'support').sort((a, b) => a.price - b.price),
    resistance: levels.filter(l => l.side === 'resistance').sort((a, b) => a.price - b.price)
  };

  const clusterOneSide = (arr, side) => {
    if (!arr.length) return [];
    const clusters = [];
    let bucket = [arr[0]];
    for (let i = 1; i < arr.length; i += 1) {
      const prev = arr[i - 1];
      const cur = arr[i];
      if (Math.abs(cur.price - prev.price) <= mergeDistanceUsd) {
        bucket.push(cur);
      } else {
        clusters.push(bucket);
        bucket = [cur];
      }
    }
    clusters.push(bucket);

    const reduced = clusters.map((items) => {
      const sumNotional = items.reduce((s, it) => s + Math.max(0, it.notionalUsd), 0);
      const weightedDen = sumNotional > 0 ? sumNotional : items.length;
      const center = sumNotional > 0
        ? items.reduce((s, it) => s + (it.price * Math.max(0, it.notionalUsd)), 0) / weightedDen
        : items.reduce((s, it) => s + it.price, 0) / weightedDen;
      const thickness = items.reduce((m, it) => Math.max(m, Math.max(0, it.thickness)), 0);
      return {
        side,
        centerPrice: center,
        count: items.length,
        thickness,
        notionalUsd: sumNotional,
        minPrice: Math.min(...items.map(it => it.price)),
        maxPrice: Math.max(...items.map(it => it.price))
      };
    });

    // support: high side first (near mid), resistance: low side first (near mid)
    reduced.sort((a, b) => side === 'support' ? (b.centerPrice - a.centerPrice) : (a.centerPrice - b.centerPrice));
    return reduced.slice(0, maxClustersPerSide);
  };

  return {
    support: clusterOneSide(bySide.support, 'support'),
    resistance: clusterOneSide(bySide.resistance, 'resistance')
  };
}

export function generateHigherTfStructure(payload, aResult, tradeConfig = getTradeConfig()) {
  const cfg = tradeConfig?.b0 ?? {};
  if (cfg.enabled === false) return null;
  const ioMetrics = payload?.ioMetrics ?? {};
  const depthSR = ioMetrics?.depthSR ?? {};
  if (depthSR?.ready !== true) return null;

  const maxLevelsPerSide = Math.max(2, Math.floor(toNumber(cfg.maxLevelsPerSide, 12)));
  const maxClustersPerSide = Math.max(1, Math.floor(toNumber(cfg.maxClustersPerSide, 6)));
  const mergeDistanceUsd = clamp(toNumber(cfg.mergeDistanceUsd, 180), 20, 2000);
  const arenaBufferUsd = Math.max(0, toNumber(cfg.arenaBufferUsd, toNumber(cfg.dailyArenaBufferUsd, 20)));
  const range = resolveArenaRange(aResult, arenaBufferUsd);
  if (!range) return null;

  const allLevels = normalizeLevels(depthSR)
    .filter(l => l.price >= range.bottom && l.price <= range.top);

  const supports = allLevels.filter(l => l.side === 'support').slice(0, maxLevelsPerSide);
  const resistances = allLevels.filter(l => l.side === 'resistance').slice(0, maxLevelsPerSide);
  const mergedInput = [...supports, ...resistances];
  if (mergedInput.length < 2) return null;

  const clusters = clusterBySide(mergedInput, mergeDistanceUsd, maxClustersPerSide);
  const candidates = [
    ...clusters.support.map(c => ({
      price: c.centerPrice,
      type: 'support',
      thickness: c.thickness,
      notionalUsd: c.notionalUsd
    })),
    ...clusters.resistance.map(c => ({
      price: c.centerPrice,
      type: 'resistance',
      thickness: c.thickness,
      notionalUsd: c.notionalUsd
    }))
  ].sort((a, b) => a.price - b.price);

  return {
    source: 'b0_1h_sr_slice',
    mergeDistanceUsd,
    arenaBufferUsd,
    arenaRangeSource: range.source,
    candidates,
    clusters,
    createdAt: Date.now()
  };
}

