import { getTradeConfig } from '../config/trade.js';

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeSrConfig(tradeConfig) {
  const defaults = {
    enabled: true,
    pivot: { leftBars: 5, rightBars: 0, lookbackBars: 150 },
    filter: { enabled: true, nearRatio: 0.1, maxLevels: 3, pairOuterPriority: true }
  };
  const src = tradeConfig?.sr ?? {};
  const pivot = src?.pivot ?? {};
  const filter = src?.filter ?? {};
  return {
    enabled: src.enabled === undefined ? defaults.enabled : !!src.enabled,
    pivot: {
      leftBars: Math.max(1, Math.min(30, Math.floor(toNumber(pivot.leftBars) ?? defaults.pivot.leftBars))),
      rightBars: Math.max(0, Math.min(10, Math.floor(toNumber(pivot.rightBars) ?? defaults.pivot.rightBars))),
      lookbackBars: Math.max(30, Math.min(500, Math.floor(toNumber(pivot.lookbackBars) ?? defaults.pivot.lookbackBars)))
    },
    filter: {
      enabled: filter.enabled === undefined ? defaults.filter.enabled : !!filter.enabled,
      nearRatio: clamp(toNumber(filter.nearRatio) ?? defaults.filter.nearRatio, 0.01, 0.5),
      maxLevels: Math.max(1, Math.min(12, Math.floor(toNumber(filter.maxLevels) ?? defaults.filter.maxLevels))),
      pairOuterPriority: filter.pairOuterPriority === undefined
        ? defaults.filter.pairOuterPriority
        : !!filter.pairOuterPriority
    }
  };
}

function normalizeBars(payload, lookbackBars) {
  const ioMetrics = payload?.ioMetrics ?? {};
  const srcBars = Array.isArray(ioMetrics?.bar15mState?.bars)
    ? ioMetrics.bar15mState.bars
    : (Array.isArray(ioMetrics?.bar15mBars) ? ioMetrics.bar15mBars : []);
  const normalized = srcBars
    .map((bar) => ({
      tsStart: toNumber(bar?.tsStart),
      high: toNumber(bar?.high),
      low: toNumber(bar?.low),
      close: toNumber(bar?.close)
    }))
    .filter((bar) => Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high >= bar.low)
    .sort((a, b) => (a.tsStart ?? 0) - (b.tsStart ?? 0));

  if (normalized.length <= lookbackBars) return normalized;
  return normalized.slice(normalized.length - lookbackBars);
}

function makeEmptyClusterView(status, reason, payload = null) {
  const mid = toNumber(payload?.market?.midPx);
  return {
    generatedAt: Number.isFinite(Number(payload?.timestamp)) ? Number(payload.timestamp) : Date.now(),
    baseMidPrice: Number.isFinite(mid) ? mid : null,
    nextUp: null,
    nextDown: null,
    clusterCount: 0,
    minClusterCount: 0,
    pathDepth: 0,
    coverage: 0,
    mapStrength: 0,
    mapStatus: 'weak',
    status,
    rawClusterCount: 0,
    outOfChannelRejectedCount: 0,
    filteredClusterCount: 0,
    detection: null,
    filter: null,
    reason,
    promotion: {
      enabled: false,
      reason: 'detection_filter_v1'
    },
    clusters: []
  };
}

export function buildBClusterDetection(payload, structureSnapshot, srConfig) {
  const upperRail = toNumber(structureSnapshot?.rails?.upper);
  const lowerRail = toNumber(structureSnapshot?.rails?.lower);
  if (!Number.isFinite(upperRail) || !Number.isFinite(lowerRail) || upperRail <= lowerRail) {
    return {
      status: 'B1_NOT_READY',
      width: null,
      angle: null,
      upperRail: Number.isFinite(upperRail) ? upperRail : null,
      lowerRail: Number.isFinite(lowerRail) ? lowerRail : null,
      centerRail: null,
      rawClusterCount: 0,
      outOfChannelRejectedCount: 0,
      clusters: [],
      barsUsed: 0,
      leftBars: srConfig.pivot.leftBars,
      rightBars: srConfig.pivot.rightBars
    };
  }

  const width = upperRail - lowerRail;
  const centerRail = (upperRail + lowerRail) / 2;
  const angle = toNumber(
    structureSnapshot?._legacy?.channelSlope ??
    payload?.ioMetrics?.lrcTvState?.slope ??
    payload?.ioMetrics?.lrcState?.slope
  );
  const bars = normalizeBars(payload, srConfig.pivot.lookbackBars);

  const leftBars = srConfig.pivot.leftBars;
  const raw = [];
  let outOfChannelRejectedCount = 0;

  for (let index = leftBars; index < bars.length; index += 1) {
    const current = bars[index];
    const left = bars.slice(index - leftBars, index);
    const maxLeftHigh = Math.max(...left.map((bar) => bar.high));
    const minLeftLow = Math.min(...left.map((bar) => bar.low));

    if (current.high > maxLeftHigh) {
      const price = current.high;
      raw.push({
        price,
        type: 'high',
        age: bars.length - 1 - index,
        distanceFromCenter: Math.abs(price - centerRail),
        tsStart: current.tsStart
      });
    }

    if (current.low < minLeftLow) {
      const price = current.low;
      raw.push({
        price,
        type: 'low',
        age: bars.length - 1 - index,
        distanceFromCenter: Math.abs(price - centerRail),
        tsStart: current.tsStart
      });
    }
  }

  const inChannel = [];
  for (const cluster of raw) {
    if (cluster.price >= lowerRail && cluster.price <= upperRail) {
      inChannel.push(cluster);
    } else {
      outOfChannelRejectedCount += 1;
    }
  }

  return {
    status: inChannel.length > 0 ? 'READY' : 'EMPTY',
    width,
    angle,
    upperRail,
    lowerRail,
    centerRail,
    rawClusterCount: raw.length,
    outOfChannelRejectedCount,
    clusters: inChannel,
    barsUsed: bars.length,
    leftBars: srConfig.pivot.leftBars,
    rightBars: srConfig.pivot.rightBars
  };
}

export function buildBClusterFilter(detectionResult, srConfig) {
  if (!detectionResult || detectionResult.status === 'B1_NOT_READY') {
    return {
      status: 'B1_NOT_READY',
      filteredClusterCount: 0,
      clusters: [],
      nearRatio: srConfig.filter.nearRatio,
      minDistance: null,
      maxLevels: srConfig.filter.maxLevels,
      pairOuterPriority: srConfig.filter.pairOuterPriority
    };
  }

  const detected = Array.isArray(detectionResult.clusters) ? detectionResult.clusters : [];
  const rails = {
    upper: detectionResult.upperRail,
    lower: detectionResult.lowerRail
  };
  const centerRail = detectionResult.centerRail;
  const width = detectionResult.width;
  const filterCfg = srConfig.filter;

  if (!filterCfg.enabled) {
    const passThrough = [...detected];
    return {
      status: passThrough.length > 0 ? 'READY' : 'EMPTY',
      filteredClusterCount: passThrough.length,
      clusters: passThrough,
      nearRatio: filterCfg.nearRatio,
      minDistance: width * filterCfg.nearRatio,
      maxLevels: filterCfg.maxLevels,
      pairOuterPriority: filterCfg.pairOuterPriority
    };
  }

  const minDistance = width * filterCfg.nearRatio;
  const pickPreferredLine = (current, next) => {
    const currentOuter = Math.abs(current.price - centerRail);
    const nextOuter = Math.abs(next.price - centerRail);
    const chooseCurrent = filterCfg.pairOuterPriority
      ? (currentOuter > nextOuter || (currentOuter === nextOuter && current.age <= next.age))
      : true;
    return chooseCurrent ? current : next;
  };

  const collapseNearPairs = (items) => {
    let working = [...items].sort((a, b) => a.price - b.price || a.age - b.age);
    if (working.length <= 1) return working;

    let changed = true;
    while (changed && working.length > 1) {
      changed = false;
      const nextPass = [];
      for (let i = 0; i < working.length; i += 1) {
        const current = working[i];
        const next = working[i + 1];
        if (!next || Math.abs(next.price - current.price) >= minDistance) {
          nextPass.push(current);
          continue;
        }

        nextPass.push(pickPreferredLine(current, next));
        i += 1;
        changed = true;
      }
      working = nextPass.sort((a, b) => a.price - b.price || a.age - b.age);
    }

    return working;
  };

  const paired = [];

  const byType = {
    high: detected.filter((item) => item?.type === 'high'),
    low: detected.filter((item) => item?.type === 'low')
  };

  for (const typeKey of ['high', 'low']) {
    const collapsed = collapseNearPairs(byType[typeKey]);
    paired.push(...collapsed);
  }

  const prioritized = [...paired].sort((a, b) => {
    const distA = Math.abs(a.price - centerRail);
    const distB = Math.abs(b.price - centerRail);
    if (distB !== distA) return distB - distA;

    const edgeDistA = Math.min(Math.abs(rails.upper - a.price), Math.abs(a.price - rails.lower));
    const edgeDistB = Math.min(Math.abs(rails.upper - b.price), Math.abs(b.price - rails.lower));
    if (edgeDistA !== edgeDistB) return edgeDistA - edgeDistB;

    if (a.age !== b.age) return a.age - b.age;
    return (b.tsStart ?? 0) - (a.tsStart ?? 0);
  });

  const clusters = prioritized.slice(0, filterCfg.maxLevels);
  return {
    status: clusters.length > 0 ? 'READY' : 'EMPTY',
    filteredClusterCount: clusters.length,
    clusters,
    nearRatio: filterCfg.nearRatio,
    minDistance,
    maxLevels: filterCfg.maxLevels,
    pairOuterPriority: filterCfg.pairOuterPriority
  };
}

function toClusterViewCluster(cluster, rails, mid, width) {
  const centerPrice = cluster.price;
  const distFromCenter = Math.abs(centerPrice - ((rails.upper + rails.lower) / 2));
  const half = Math.max(1, width / 2);
  const rank = clamp(distFromCenter / half, 0.05, 1.0);
  return {
    clusterId: `bc_${cluster.type}_${Math.round(centerPrice * 100)}`,
    centerPrice,
    widthUsd: 0,
    rank,
    type: cluster.type === 'high' ? 'resistance' : 'support',
    source: 'b_cluster_filter',
    distanceFromNow: Math.abs(centerPrice - mid),
    expectedTravelRatio: Number.isFinite(width) && width > 0
      ? clamp(Math.abs(centerPrice - mid) / width, 0, 10)
      : null,
    age: cluster.age,
    distanceFromCenter: cluster.distanceFromCenter,
    rawType: cluster.type
  };
}

export function buildStructuralSrClusterView(payload, aResult, structureSnapshot, tradeConfig = getTradeConfig()) {
  const cfg = normalizeSrConfig(tradeConfig);
  if (!cfg.enabled) return null;
  if (!structureSnapshot) return makeEmptyClusterView('B1_NOT_READY', 'B1 structure missing', payload);

  const mid = toNumber(payload?.market?.midPx);
  if (!Number.isFinite(mid)) return makeEmptyClusterView('B1_NOT_READY', 'mid unavailable', payload);

  const detected = buildBClusterDetection(payload, structureSnapshot, cfg);
  const filtered = buildBClusterFilter(detected, cfg);

  const rails = {
    upper: detected.upperRail,
    lower: detected.lowerRail
  };
  const width = Number.isFinite(detected.width) ? detected.width : null;
  if (!Number.isFinite(rails.upper) || !Number.isFinite(rails.lower) || !Number.isFinite(width) || width <= 0) {
    return makeEmptyClusterView('B1_NOT_READY', 'B1 rails invalid', payload);
  }

  const clusters = filtered.clusters.map((cluster) => toClusterViewCluster(cluster, rails, mid, width));
  const sortedByPrice = [...clusters].sort((a, b) => a.centerPrice - b.centerPrice);
  const nextUp = sortedByPrice.find((cluster) => cluster.centerPrice > mid) ?? null;
  const nextDown = [...sortedByPrice].reverse().find((cluster) => cluster.centerPrice < mid) ?? null;
  const pathDepth = Number(nextUp != null) + Number(nextDown != null);
  const coverage = clamp(clusters.length / Math.max(1, cfg.filter.maxLevels), 0, 1);
  const mapStrength = clamp((coverage * 0.5) + ((pathDepth / 2) * 0.5), 0, 1);
  const status = filtered.status === 'B1_NOT_READY'
    ? 'B1_NOT_READY'
    : (clusters.length === 0 ? 'EMPTY' : 'READY');

  return {
    generatedAt: Number.isFinite(Number(payload?.timestamp)) ? Number(payload.timestamp) : Date.now(),
    baseMidPrice: mid,
    nextUp,
    nextDown,
    clusterCount: clusters.length,
    minClusterCount: 0,
    pathDepth,
    coverage,
    mapStrength,
    mapStatus: clusters.length > 0 ? 'ok' : 'weak',
    status,
    rawClusterCount: Number(detected.rawClusterCount ?? 0),
    outOfChannelRejectedCount: Number(detected.outOfChannelRejectedCount ?? 0),
    filteredClusterCount: Number(filtered.filteredClusterCount ?? 0),
    detection: {
      width: detected.width,
      angle: detected.angle,
      upperRail: detected.upperRail,
      centerRail: detected.centerRail,
      lowerRail: detected.lowerRail,
      rawClusterCount: detected.rawClusterCount,
      outOfChannelRejectedCount: detected.outOfChannelRejectedCount,
      barsUsed: detected.barsUsed,
      leftBars: detected.leftBars,
      rightBars: detected.rightBars,
      status: detected.status
    },
    filter: {
      filteredClusterCount: filtered.filteredClusterCount,
      nearRatio: filtered.nearRatio,
      minDistance: filtered.minDistance,
      maxLevels: filtered.maxLevels,
      pairOuterPriority: filtered.pairOuterPriority,
      status: filtered.status
    },
    promotion: {
      enabled: false,
      reason: 'detection_filter_v1'
    },
    clusters
  };
}
