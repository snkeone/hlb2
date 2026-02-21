/**
 * logic/decision_b2.js
 * 
 * B ロジック層2（b2）: 執行判定モジュール
 * Ver3 実装版
 * 
 * 責務:
 * - StructureSnapshot を受け取る（b1 が生成）
 * - 端付近判定を行う（4基準）
 * - TP・regime 整合を確認
 * - サイズ算出
 * - entry allowed / side=none を返す
 * 
 * 「構造優先」設計:
 * - expectedUsd ではなく構造TP（SR/チャネル）を優先
 * - b1 が作った構造を信じる
 * - 位置判定 + 構造TP確認 + 最低構造距離のみ
 * 
 * 呼び出し元: logic/index.js
 * 呼び出し先: hepler functions (resolveSizeB, etc)
 * 入力: payload, aResult, structureSnapshot (b1 出力)
 */

import { getTradeConfig } from '../config/trade.js';
import { computeLrcWsOrbit } from './lrc_ws_orbit.js';
import { collectFlowImbalanceSensor } from './sensors/flow_imbalance_sensor.js';
import { collectImpactSpreadSensor } from './sensors/impact_spread_sensor.js';
import { collectCtxSizeSensor } from './sensors/ctx_size_sensor.js';
import { evaluateBContainmentGate } from './gates/b2_containment_gate.js';
import { evaluateCtxMicroGate } from './gates/b2_ctx_micro_gate.js';
import { evaluateOiTrapGate } from './gates/b2_oi_trap_gate.js';
import {
  formatEntryFlowInactiveDiagnostics,
  formatEntryFlowBaseDiagnostics,
  formatEntryFlowDivergenceDiagnostics,
  formatEntryFlowInsufficientSampleDiagnostics,
  formatEntryFlowAlignedDiagnostics,
  formatEntryFlowHostileDiagnostics,
  formatEntryFlowFinalDiagnostics
} from './diagnostics/entry_flow_diagnostics.js';
import fs from 'node:fs';
import path from 'node:path';

let routeModeWarned = false;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveCapitalStageProfile(tradeConfig, equityUsd) {
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return null;
  const cfg = tradeConfig?.capitalStages ?? {};
  if (cfg.enabled === false) return null;
  const bandsRaw = Array.isArray(cfg.bands) ? cfg.bands : [];
  if (bandsRaw.length === 0) return null;
  for (const band of bandsRaw) {
    const upTo = band?.upToEquityUsd;
    if (upTo === null || upTo === undefined) return band;
    const upToNum = Number(upTo);
    if (!Number.isFinite(upToNum)) continue;
    if (equityUsd <= upToNum) return band;
  }
  return bandsRaw[bandsRaw.length - 1] ?? null;
}

function resolveExecutionModel(tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.executionModel ?? {};
  const distanceGuardModeRaw = String(cfg.distanceGuardMode ?? 'enforce').toLowerCase();
  const distanceGuardMode = ['enforce', 'shadow', 'off'].includes(distanceGuardModeRaw)
    ? distanceGuardModeRaw
    : 'enforce';
  const rangeModeRaw = String(cfg.rangeMode ?? 'c_bias').toLowerCase();
  const rangeMode = ['c_bias', 'distance', 'skip'].includes(rangeModeRaw) ? rangeModeRaw : 'c_bias';
  return {
    enabled: cfg.enabled === true,
    useDistanceEntry: cfg.useDistanceEntry !== false,
    distanceGuardMode,
    minEntryQuality: clamp(toNumber(cfg.minEntryQuality, 0.25), 0.0, 0.95),
    minMapStrength: clamp(toNumber(cfg.minMapStrength, 0.15), 0.0, 1.0),
    rangeCBiasDeadband: clamp(toNumber(cfg.rangeCBiasDeadband, 0.05), 0.0, 0.4),
    rangeMode,
    requireStructuralPath: cfg.requireStructuralPath !== false,
    srReferenceGuard: {
      enabled: cfg.srReferenceGuard?.enabled !== false,
      windowUsd: Math.max(1, toNumber(cfg.srReferenceGuard?.windowUsd, 80)),
      minRank: clamp(toNumber(cfg.srReferenceGuard?.minRank, 0.1), 0, 1),
      minScore: Math.max(0, toNumber(cfg.srReferenceGuard?.minScore, 0)),
      minNotionalUsd: Math.max(0, toNumber(cfg.srReferenceGuard?.minNotionalUsd, 0)),
      requireBothSides: cfg.srReferenceGuard?.requireBothSides !== false,
      allowEdgeLike: cfg.srReferenceGuard?.allowEdgeLike !== false,
      allowUnknownStrength: cfg.srReferenceGuard?.allowUnknownStrength !== false,
      enforceWhenClustersPresent: cfg.srReferenceGuard?.enforceWhenClustersPresent !== false
    }
  };
}

function resolveSrReferenceClusterGate(srClusterView, mid, supportRefPrice, resistanceRefPrice, executionModel, decidedSide = null) {
  const cfg = executionModel?.srReferenceGuard ?? {};
  if (cfg.enabled === false) {
    return { enabled: false, blocked: false, diagnostics: { enabled: false } };
  }

  const hasClusterView = !!srClusterView && (
    Array.isArray(srClusterView?.clusters) ||
    Number.isFinite(Number(srClusterView?.clusterCount))
  );
  if (!hasClusterView) {
    return {
      enabled: true,
      blocked: true,
      diagnostics: {
        enabled: true,
        reason: 'cluster_map_unavailable',
        clusterCount: null,
        requiredNearby: true
      }
    };
  }

  const clusters = Array.isArray(srClusterView?.clusters) ? srClusterView.clusters : [];
  const clusterCount = Math.max(0, Number(srClusterView?.clusterCount ?? clusters.length));
  const hasAnyCluster = clusterCount > 0 || clusters.length > 0;
  if (!hasAnyCluster) {
    return {
      enabled: true,
      blocked: true,
      diagnostics: {
        enabled: true,
        reason: 'no_cluster_map',
        clusterCount,
        support: { refPrice: Number.isFinite(supportRefPrice) ? supportRefPrice : null, pass: false, candidates: 0, matched: null },
        resistance: { refPrice: Number.isFinite(resistanceRefPrice) ? resistanceRefPrice : null, pass: false, candidates: 0, matched: null }
      }
    };
  }

  const windowUsd = Math.max(1, toNumber(cfg.windowUsd, 80));
  const minRank = clamp(toNumber(cfg.minRank, 0.1), 0, 1);
  const minScore = Math.max(0, toNumber(cfg.minScore, 0));
  const minNotionalUsd = Math.max(0, toNumber(cfg.minNotionalUsd, 0));
  const requireBothSides = cfg.requireBothSides !== false;
  const allowEdgeLike = cfg.allowEdgeLike !== false;
  const allowUnknownStrength = cfg.allowUnknownStrength !== false;

  const normalized = clusters
    .filter((cluster) => Number.isFinite(Number(cluster?.centerPrice)))
    .map((cluster) => ({
      centerPrice: Number(cluster.centerPrice),
      type: String(cluster?.type ?? 'sr').toLowerCase(),
      rank: toNumber(cluster?.rank, null),
      score: toNumber(cluster?.score, null),
      notionalUsd: toNumber(cluster?.notionalUsd, null)
    }));

  const pickNear = (refPrice) => normalized
    .filter((cluster) => Math.abs(cluster.centerPrice - refPrice) <= windowUsd)
    .filter((cluster) => allowEdgeLike || cluster.type !== 'channel_edge')
    .sort((a, b) => Math.abs(a.centerPrice - refPrice) - Math.abs(b.centerPrice - refPrice));

  const isStrong = (cluster) => {
    if (!cluster) return false;
    const hasMetrics = Number.isFinite(cluster.rank) || Number.isFinite(cluster.score) || Number.isFinite(cluster.notionalUsd);
    if (!hasMetrics) return allowUnknownStrength;
    return (
      (Number.isFinite(cluster.rank) && cluster.rank >= minRank) ||
      (Number.isFinite(cluster.score) && cluster.score >= minScore) ||
      (Number.isFinite(cluster.notionalUsd) && cluster.notionalUsd >= minNotionalUsd)
    );
  };

  const supportNear = Number.isFinite(supportRefPrice) ? pickNear(supportRefPrice) : [];
  const resistanceNear = Number.isFinite(resistanceRefPrice) ? pickNear(resistanceRefPrice) : [];
  const supportBest = supportNear.find(isStrong) ?? null;
  const resistanceBest = resistanceNear.find(isStrong) ?? null;
  const supportPass = supportNear.length > 0;
  const resistancePass = resistanceNear.length > 0;
  const sideKey = decidedSide === 'buy' ? 'support' : decidedSide === 'sell' ? 'resistance' : null;
  const passBySide = sideKey === 'support'
    ? supportPass
    : (sideKey === 'resistance' ? resistancePass : null);
  const passByDual = requireBothSides ? (supportPass && resistancePass) : (supportPass || resistancePass);
  const pass = passBySide ?? passByDual;
  const blocked = !pass;

  return {
    enabled: true,
    blocked,
    diagnostics: {
      enabled: true,
      windowUsd,
      minRank,
      minScore,
      minNotionalUsd,
      requireBothSides,
      allowEdgeLike,
      allowUnknownStrength,
      decidedSide: sideKey,
      requiredNearby: true,
      pass,
      support: {
        refPrice: Number.isFinite(supportRefPrice) ? supportRefPrice : null,
        candidates: supportNear.length,
        pass: supportPass,
        matched: supportBest
      },
      resistance: {
        refPrice: Number.isFinite(resistanceRefPrice) ? resistanceRefPrice : null,
        candidates: resistanceNear.length,
        pass: resistancePass,
        matched: resistanceBest
      }
    }
  };
}

function resolveRangeSideFromC(c, deadband = 0.05) {
  const cv = toNumber(c);
  if (!Number.isFinite(cv)) return null;
  if (Math.abs(cv) <= deadband) return null;
  if (cv < 0) return 'buy';
  return 'sell';
}

function resolveArenaBounds(aResult, rails, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.arenaGuard ?? {};
  const enabled = cfg.enabled !== false;
  const arenaTop = toNumber(aResult?.arena?.channelTop);
  const arenaBottom = toNumber(aResult?.arena?.channelBottom);
  const hasArena = Number.isFinite(arenaTop) && Number.isFinite(arenaBottom) && arenaTop > arenaBottom;
  const top = hasArena ? arenaTop : rails.upper;
  const bottom = hasArena ? arenaBottom : rails.lower;
  const width = top - bottom;
  const padRatio = clamp(toNumber(cfg.paddingRatio, 0.08), 0, 0.25);
  const paddingUsd = Number.isFinite(width) && width > 0 ? width * padRatio : 0;
  return {
    enabled,
    hasArena,
    top,
    bottom,
    paddingUsd
  };
}

function computeExecutionSignals(payload, spanUsd, distToUpper, distToLower, edgeThreshold, tradeConfig) {
  // 仕様固定: Phase4の構造評価はWS値を使わない
  const executionModelCfg = tradeConfig?.b2Upgrade?.executionModel ?? {};
  const useDistanceEntry = executionModelCfg.useDistanceEntry !== false;
  const edgeDist = Math.min(Math.max(0, distToUpper), Math.max(0, distToLower));
  const edgeScore = edgeThreshold > 0 ? clamp(1 - edgeDist / edgeThreshold, 0, 1) : 0;
  const channelT = Number.isFinite(spanUsd) && spanUsd > 0
    ? clamp(1 - ((2 * edgeDist) / spanUsd), 0, 1)
    : 0;
  const zoneScore = Number.isFinite(channelT)
    ? clamp(Math.abs(channelT - 0.5) * 2, 0, 1)
    : 0;
  const rawEntryQualityScore = useDistanceEntry ? edgeScore : zoneScore;
  const entryWeight = 1;
  const entryQualityScore = clamp(rawEntryQualityScore * entryWeight, 0, 1);
  const aggressiveness = entryQualityScore >= 0.75 ? 'high' : (entryQualityScore >= 0.45 ? 'normal' : 'low');

  return {
    spreadBps: null,
    velocityBps: null,
    cShock: null,
    edgeScore,
    rawEntryQualityScore,
    entryWeight,
    channelT,
    effectiveEntryQualityScore: entryQualityScore,
    entryQualityScore,
    executionMode: null,
    aggressiveness,
    spanUsd
  };
}

function resolveWsExecutionMode(payload, tradeConfig) {
  const market = payload?.market ?? {};
  const ioMetrics = payload?.ioMetrics ?? {};
  const midPx = toNumber(market?.midPx, 0);
  const bestBid = toNumber(market?.bestBid);
  const bestAsk = toNumber(market?.bestAsk);
  const spreadBps = Number.isFinite(midPx) && midPx > 0 && Number.isFinite(bestBid) && Number.isFinite(bestAsk)
    ? ((bestAsk - bestBid) / midPx) * 10000
    : Number.POSITIVE_INFINITY;
  const velocityBps = Number.isFinite(midPx) && midPx > 0
    ? Math.abs(Number(ioMetrics?.diffs?.midPx ?? 0)) / midPx * 10000
    : Number.POSITIVE_INFINITY;
  const execCfg = tradeConfig?.b2Upgrade?.execution ?? {};
  const makerSpreadMax = Math.max(0.1, toNumber(execCfg.makerMaxSpreadBps, 1.4));
  const makerVelocityMax = Math.max(0.1, toNumber(execCfg.makerMaxVelocityBps, 1.0));
  return (spreadBps <= makerSpreadMax && velocityBps <= makerVelocityMax) ? 'maker' : 'taker';
}

function resolveEntryFlowGate(ioMetrics, tradeConfig, decidedSide) {
  const cfg = tradeConfig?.entryFlowGate ?? {};
  if (cfg.enabled !== true) {
    return { blocked: false, reason: null, diagnostics: null };
  }
  const flowSignals = collectFlowImbalanceSensor(ioMetrics, tradeConfig);
  const mode = flowSignals?.mode ?? 'hostile_only';
  if (mode === 'off') {
    return {
      blocked: false,
      reason: null,
      diagnostics: formatEntryFlowInactiveDiagnostics(mode, 'mode_off')
    };
  }
  if (flowSignals?.available !== true) {
    return {
      blocked: false,
      reason: null,
      diagnostics: formatEntryFlowInactiveDiagnostics(mode, 'no_trade_flow')
    };
  }
  const windowMs = flowSignals.windowMs;
  const minTrades = flowSignals.minTrades;
  const flowPressure = flowSignals.flowPressure;
  const tradeCount = flowSignals.tradeCount;
  const hostileThresholdLong = flowSignals.thresholds?.hostileThresholdLong;
  const hostileThresholdShort = flowSignals.thresholds?.hostileThresholdShort;
  const alignedThresholdLong = flowSignals.thresholds?.alignedThresholdLong;
  const alignedThresholdShort = flowSignals.thresholds?.alignedThresholdShort;
  const diagnostics = formatEntryFlowBaseDiagnostics({
    mode,
    windowMs,
    minTrades,
    tradeCount,
    flowPressure,
    normalizedFlowPressure: flowSignals.normalizedFlowPressure,
    source: flowSignals.source
  });
  const divergenceGuardEnabled = cfg.divergenceGuardEnabled === true;
  if (divergenceGuardEnabled) {
    const fp5 = flowSignals.divergence?.flowPressure5s;
    const fp60 = flowSignals.divergence?.flowPressure60s;
    const w5Count = flowSignals.divergence?.trades5s;
    const w60Count = flowSignals.divergence?.trades60s;
    const minTrades5 = flowSignals.thresholds?.minTrades5;
    const minTrades60 = flowSignals.thresholds?.minTrades60;
    const shortStrongTh = flowSignals.thresholds?.shortStrongTh;
    if (
      w5Count >= minTrades5 &&
      w60Count >= minTrades60 &&
      Number.isFinite(fp5) &&
      Number.isFinite(fp60) &&
      (fp5 * fp60) < 0 &&
      Math.abs(fp5) >= shortStrongTh
    ) {
      return {
        blocked: true,
        reason: 'B: flow divergence (5s vs 60s)',
        diagnostics: formatEntryFlowDivergenceDiagnostics(diagnostics, {
          fp5,
          fp60,
          w5Count,
          w60Count,
          minTrades5,
          minTrades60,
          shortStrongTh
        })
      };
    }
  }
  if (tradeCount < minTrades || !Number.isFinite(flowPressure)) {
    return {
      blocked: false,
      reason: null,
      diagnostics: formatEntryFlowInsufficientSampleDiagnostics(diagnostics)
    };
  }
  if (mode === 'with_trend_only') {
    if (decidedSide === 'buy' && flowPressure < alignedThresholdLong) {
      return {
        blocked: true,
        reason: 'B: flow not aligned for long',
        diagnostics: formatEntryFlowAlignedDiagnostics(diagnostics, alignedThresholdLong, decidedSide)
      };
    }
    if (decidedSide === 'sell' && flowPressure > (-alignedThresholdShort)) {
      return {
        blocked: true,
        reason: 'B: flow not aligned for short',
        diagnostics: formatEntryFlowAlignedDiagnostics(diagnostics, -alignedThresholdShort, decidedSide)
      };
    }
  }
  if (decidedSide === 'buy' && flowPressure <= (-hostileThresholdLong)) {
    return {
      blocked: true,
      reason: 'B: flow hostile for long',
      diagnostics: formatEntryFlowHostileDiagnostics(diagnostics, -hostileThresholdLong)
    };
  }
  if (decidedSide === 'sell' && flowPressure >= hostileThresholdShort) {
    return {
      blocked: true,
      reason: 'B: flow hostile for short',
      diagnostics: formatEntryFlowHostileDiagnostics(diagnostics, hostileThresholdShort)
    };
  }
  return {
    blocked: false,
    reason: null,
    diagnostics: formatEntryFlowFinalDiagnostics(
      diagnostics,
      decidedSide,
      hostileThresholdLong,
      hostileThresholdShort
    )
  };
}

const tpCapSelfCalCache = {
  loadedAtMs: 0,
  sourceMtimeMs: 0,
  sourcePath: null,
  sampleSize: 0,
  maxScanLines: 0,
  minSampleSize: 0,
  ratios: []
};

function computeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if ((sorted.length % 2) === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function extractCaptureRatioFromTradeRow(row) {
  if (!row || typeof row !== 'object') return NaN;
  const direct = toNumber(row.captureRatio, NaN);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const capturedMoveUsd = toNumber(row.capturedMoveUsd, NaN);
  const plannedMoveUsd = toNumber(row.plannedMoveUsd, NaN);
  if (Number.isFinite(capturedMoveUsd) && Number.isFinite(plannedMoveUsd) && plannedMoveUsd > 0) {
    const ratio = capturedMoveUsd / plannedMoveUsd;
    if (Number.isFinite(ratio) && ratio > 0) return ratio;
  }
  return NaN;
}

function loadRecentCaptureRatiosFromLog(filePath, sampleSize, maxScanLines) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return [];
    const lines = raw.split('\n');
    const ratios = [];
    let scanned = 0;
    for (let i = lines.length - 1; i >= 0 && ratios.length < sampleSize && scanned < maxScanLines; i -= 1) {
      const line = String(lines[i] ?? '').trim();
      if (!line) continue;
      scanned += 1;
      try {
        const row = JSON.parse(line);
        const ratio = extractCaptureRatioFromTradeRow(row);
        if (Number.isFinite(ratio) && ratio > 0) {
          ratios.push(clamp(ratio, 0.01, 3.0));
        }
      } catch {
        // skip malformed line
      }
    }
    return ratios;
  } catch {
    return [];
  }
}

function resolveTpCapSelfCalStats(tradeConfig) {
  const tpCapCfg = tradeConfig?.wsAdaptive?.tpCap ?? {};
  const cfg = tpCapCfg?.selfCalibrate ?? {};
  if (cfg.enabled !== true) {
    return {
      active: false,
      medianCaptureRatio: NaN,
      sampleCount: 0,
      diagnostics: { enabled: false }
    };
  }
  const sampleSize = Math.max(3, Math.floor(toNumber(cfg.sampleSize, 20)));
  const minSampleSize = Math.max(1, Math.min(sampleSize, Math.floor(toNumber(cfg.minSampleSize, 6))));
  const cacheTtlMs = Math.max(1000, Math.floor(toNumber(cfg.cacheTtlMs, 300000)));
  const maxScanLines = Math.max(sampleSize, Math.floor(toNumber(cfg.maxScanLines, 400)));
  const logFilePath = String(cfg.logFilePath || 'logs/trades.jsonl');
  const fullPath = path.resolve(process.cwd(), logFilePath);
  let stat = null;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return {
      active: false,
      medianCaptureRatio: NaN,
      sampleCount: 0,
      diagnostics: {
        enabled: true,
        active: false,
        reason: 'log_not_found',
        logFilePath
      }
    };
  }
  const now = Date.now();
  const sourceMtimeMs = Math.floor(toNumber(stat?.mtimeMs, 0));
  const isCacheValid = (
    tpCapSelfCalCache.sourcePath === fullPath &&
    tpCapSelfCalCache.sourceMtimeMs === sourceMtimeMs &&
    tpCapSelfCalCache.sampleSize === sampleSize &&
    tpCapSelfCalCache.minSampleSize === minSampleSize &&
    tpCapSelfCalCache.maxScanLines === maxScanLines &&
    (now - tpCapSelfCalCache.loadedAtMs) <= cacheTtlMs
  );
  let ratios = [];
  if (isCacheValid) {
    ratios = Array.isArray(tpCapSelfCalCache.ratios) ? tpCapSelfCalCache.ratios.slice() : [];
  } else {
    ratios = loadRecentCaptureRatiosFromLog(fullPath, sampleSize, maxScanLines);
    tpCapSelfCalCache.loadedAtMs = now;
    tpCapSelfCalCache.sourceMtimeMs = sourceMtimeMs;
    tpCapSelfCalCache.sourcePath = fullPath;
    tpCapSelfCalCache.sampleSize = sampleSize;
    tpCapSelfCalCache.minSampleSize = minSampleSize;
    tpCapSelfCalCache.maxScanLines = maxScanLines;
    tpCapSelfCalCache.ratios = ratios.slice();
  }
  const sampleCount = ratios.length;
  const medianCaptureRatio = computeMedian(ratios);
  const active = sampleCount >= minSampleSize && Number.isFinite(medianCaptureRatio);
  return {
    active,
    medianCaptureRatio,
    sampleCount,
    diagnostics: {
      enabled: true,
      active,
      sampleCount,
      minSampleSize,
      sampleSize,
      cacheTtlMs,
      logFilePath,
      medianCaptureRatio: Number.isFinite(medianCaptureRatio) ? medianCaptureRatio : null
    }
  };
}

function resolveDynamicTpCapUsd(ioMetrics, market, tradeConfig) {
  const cfg = tradeConfig?.wsAdaptive?.tpCap ?? {};
  if (cfg.enabled === false) {
    return { capUsd: null, diagnostics: { enabled: false } };
  }
  const bar1h = ioMetrics?.bar1hState ?? {};
  const spanHigh = toNumber(bar1h.high);
  const spanLow = toNumber(bar1h.low);
  const spanUsd = Number.isFinite(spanHigh) && Number.isFinite(spanLow) && spanHigh > spanLow
    ? (spanHigh - spanLow)
    : null;
  if (!Number.isFinite(spanUsd) || spanUsd <= 0) {
    return {
      capUsd: null,
      diagnostics: { enabled: true, active: false, reason: 'no_bar1h_span' }
    };
  }
  const baseRatio = clamp(toNumber(cfg.baseSpanRatio, 0.25), 0.05, 1.2);
  const lowSpanThresholdUsd = Math.max(10, toNumber(cfg.lowSpanThresholdUsd, 500));
  const lowSpanRatio = clamp(toNumber(cfg.lowSpanRatio, 0.35), baseRatio, 1.4);
  const ratio = spanUsd <= lowSpanThresholdUsd ? lowSpanRatio : baseRatio;
  const minCapUsd = Math.max(10, toNumber(cfg.minCapUsd, 120));
  const maxCapUsd = Math.max(minCapUsd, toNumber(cfg.maxCapUsd, 450));
  const volatilityWeight = clamp(toNumber(cfg.volatilityWeight, 0.25), 0, 1.0);
  const volatilityRefBps = Math.max(0.1, toNumber(cfg.volatilityRefBps, 120));
  const bar15m = ioMetrics?.bar15mState ?? {};
  const bar15mHigh = toNumber(bar15m.high);
  const bar15mLow = toNumber(bar15m.low);
  const midPx = toNumber(market?.midPx);
  const bar15mRangeBps = Number.isFinite(bar15mHigh) && Number.isFinite(bar15mLow) && Number.isFinite(midPx) && midPx > 0
    ? ((bar15mHigh - bar15mLow) / midPx) * 10000
    : 0;
  const volNorm = clamp(bar15mRangeBps / volatilityRefBps, 0, 2.0);
  const volMul = 1 + ((volNorm - 1) * volatilityWeight);
  const rawCapUsd = spanUsd * ratio * volMul;
  const baseCapUsd = clamp(rawCapUsd, minCapUsd, maxCapUsd);
  const selfCalStats = resolveTpCapSelfCalStats(tradeConfig);
  let capUsd = baseCapUsd;
  let selfCalDiag = selfCalStats?.diagnostics ?? { enabled: false };
  if (selfCalStats?.active) {
    const scCfg = cfg.selfCalibrate ?? {};
    const baseOffset = clamp(toNumber(scCfg.baseOffset, 0.3), 0, 2.0);
    const slope = clamp(toNumber(scCfg.slope, 0.8), 0, 4.0);
    const minMultiplier = clamp(toNumber(scCfg.minMultiplier, 0.4), 0.1, 2.0);
    const maxMultiplier = Math.max(minMultiplier, clamp(toNumber(scCfg.maxMultiplier, 1.2), minMultiplier, 3.0));
    const multiplier = clamp(baseOffset + (selfCalStats.medianCaptureRatio * slope), minMultiplier, maxMultiplier);
    capUsd = clamp(baseCapUsd * multiplier, minCapUsd, maxCapUsd);
    selfCalDiag = {
      ...(selfCalStats.diagnostics ?? {}),
      active: true,
      baseOffset,
      slope,
      minMultiplier,
      maxMultiplier,
      multiplier,
      capBefore: baseCapUsd,
      capAfter: capUsd
    };
  }
  return {
    capUsd,
    diagnostics: {
      enabled: true,
      active: true,
      spanUsd,
      ratio,
      baseRatio,
      lowSpanRatio,
      lowSpanThresholdUsd,
      bar15mRangeBps,
      volatilityRefBps,
      volatilityWeight,
      volMul,
      rawCapUsd,
      baseCapUsd,
      minCapUsd,
      maxCapUsd,
      capUsd,
      selfCalibrate: selfCalDiag
    }
  };
}

function resolveFlowSizeScalar(ioMetrics, decidedSide, tradeConfig) {
  const cfg = tradeConfig?.wsAdaptive?.sizeScalars?.flow ?? {};
  if (cfg.enabled === false) return { scalar: 1, diagnostics: { enabled: false } };
  const flow = ioMetrics?.tradeFlow;
  if (!flow || typeof flow !== 'object') {
    return { scalar: 1, diagnostics: { enabled: true, active: false, reason: 'no_trade_flow' } };
  }
  const windowMs = Math.max(1000, Math.floor(toNumber(cfg.windowMs, toNumber(flow.windowMs, 30000))));
  const minTrades = Math.max(1, Math.floor(toNumber(cfg.minTrades, toNumber(flow.minTradesForSignal, 8))));
  const windows = flow?.windows ?? {};
  const bucket = windows[String(windowMs)] ?? windows[windowMs] ?? null;
  const tradeCount = Math.max(0, Math.floor(toNumber(bucket?.tradeCount, toNumber(flow.tradeCount, 0))));
  const flowPressure = toNumber(bucket?.flowPressure, toNumber(flow.flowPressure, 0));
  const maxBoost = clamp(toNumber(cfg.maxBoost, 1.10), 1.0, 1.5);
  const minScalar = 1.0;
  const boostSlope = Math.max(0, toNumber(cfg.boostSlope, 0.25));
  if (tradeCount < minTrades || !Number.isFinite(flowPressure)) {
    return {
      scalar: 1,
      diagnostics: {
        enabled: true,
        active: false,
        reason: 'insufficient_sample',
        tradeCount,
        minTrades,
        windowMs
      }
    };
  }
  const alignedPressure = decidedSide === 'buy' ? flowPressure : -flowPressure;
  let scalar = 1;
  if (alignedPressure >= 0) {
    scalar = 1 + Math.min(maxBoost - 1, alignedPressure * boostSlope);
  } else {
    // no reduction policy: keep baseline at 1.0 on hostile side
    scalar = 1;
  }
  const divergenceGuardEnabled = cfg.divergenceGuardEnabled === true;
  let divergencePenaltyApplied = false;
  let divergenceDiag = null;
  if (divergenceGuardEnabled) {
    const w5 = windows['5000'] ?? windows[5000] ?? null;
    const w60 = windows['60000'] ?? windows[60000] ?? null;
    const w5Count = Math.max(0, Math.floor(toNumber(w5?.tradeCount, 0)));
    const w60Count = Math.max(0, Math.floor(toNumber(w60?.tradeCount, 0)));
    const minTrades5 = Math.max(1, Math.floor(toNumber(cfg.divergenceMinTrades5s, 3)));
    const minTrades60 = Math.max(minTrades5, Math.floor(toNumber(cfg.divergenceMinTrades60s, 15)));
    const shortStrengthThreshold = clamp(toNumber(cfg.divergenceShortStrength, 0.3), 0.05, 0.95);
    const fp5 = toNumber(w5?.flowPressure);
    const fp60 = toNumber(w60?.flowPressure);
    const divergent = Number.isFinite(fp5) && Number.isFinite(fp60) && (fp5 * fp60) < 0;
    if (w5Count >= minTrades5 && w60Count >= minTrades60 && divergent && Math.abs(fp5) >= shortStrengthThreshold) {
      const penaltyMul = clamp(toNumber(cfg.divergencePenaltyMul, 0.85), 0.4, 1.0);
      // no reduction policy: keep baseline at 1.0 even under divergence
      scalar = Math.max(1, scalar);
      divergencePenaltyApplied = true;
      divergenceDiag = { fp5, fp60, w5Count, w60Count, penaltyMul };
    }
  }
  scalar = clamp(scalar, 1.0, maxBoost);
  return {
    scalar,
    diagnostics: {
      enabled: true,
      active: true,
      windowMs,
      minTrades,
      tradeCount,
      flowPressure,
      alignedPressure,
      minScalar,
      maxBoost,
      divergencePenaltyApplied,
      divergence: divergenceDiag
    }
  };
}

function resolveImpactSizeScalar(market, tradeConfig) {
  const cfg = tradeConfig?.wsAdaptive?.sizeScalars?.impact ?? {};
  if (cfg.enabled === false) return { scalar: 1, diagnostics: { enabled: false } };
  const impactSignals = collectImpactSpreadSensor(market, tradeConfig);
  if (impactSignals?.ok !== true) {
    return {
      scalar: 1,
      diagnostics: { enabled: true, active: false, reason: 'no_impact_prices' }
    };
  }
  const impactSpreadBps = impactSignals.outputs?.impactSpreadBps;
  const goodSpreadBps = impactSignals.outputs?.goodSpreadBps;
  const badSpreadBps = impactSignals.outputs?.badSpreadBps;
  const minScalar = impactSignals.outputs?.minScalar;
  const maxBoost = impactSignals.outputs?.maxBoost;
  const spreadPosition01 = impactSignals.normalized?.spreadPosition01;
  let scalar = 1;
  if (impactSpreadBps <= goodSpreadBps) {
    scalar = maxBoost;
  } else if (impactSpreadBps >= badSpreadBps) {
    scalar = 1.0;
  } else {
    scalar = maxBoost + (1.0 - maxBoost) * clamp(spreadPosition01, 0, 1);
  }
  scalar = clamp(scalar, 1.0, maxBoost);
  return {
    scalar,
    diagnostics: {
      enabled: true,
      active: true,
      impactSpreadBps,
      goodSpreadBps,
      badSpreadBps,
      minScalar,
      maxBoost,
      spreadPosition01
    }
  };
}

function resolveAccelSizeScalar(ioMetrics, decidedSide, tradeConfig) {
  const cfg = tradeConfig?.wsAdaptive?.sizeScalars?.acceleration ?? {};
  if (cfg.enabled === false) return { scalar: 1, diagnostics: { enabled: false } };
  const flow = ioMetrics?.tradeFlow;
  if (!flow || typeof flow !== 'object') {
    return { scalar: 1, diagnostics: { enabled: true, active: false, reason: 'no_trade_flow' } };
  }
  const windowMs = Math.max(1000, Math.floor(toNumber(cfg.windowMs, toNumber(flow.windowMs, 30000))));
  const minTrades = Math.max(1, Math.floor(toNumber(cfg.minTrades, toNumber(flow.minTradesForSignal, 8))));
  const windows = flow?.windows ?? {};
  const bucket = windows[String(windowMs)] ?? windows[windowMs] ?? null;
  const tradeCount = Math.max(0, Math.floor(toNumber(bucket?.tradeCount, toNumber(flow.tradeCount, 0))));
  const flowPressure = toNumber(bucket?.flowPressure, toNumber(flow.flowPressure, 0));
  const acceleration = toNumber(bucket?.acceleration, toNumber(flow.acceleration, 0));
  if (tradeCount < minTrades || !Number.isFinite(acceleration) || !Number.isFinite(flowPressure)) {
    return {
      scalar: 1,
      diagnostics: {
        enabled: true,
        active: false,
        reason: 'insufficient_sample',
        tradeCount,
        minTrades,
        windowMs
      }
    };
  }
  const minScalar = 1.0;
  const maxBoost = clamp(toNumber(cfg.maxBoost, 1.08), 1.0, 1.2);
  const boostSlope = Math.max(0, toNumber(cfg.boostSlope, 0.15));
  const alignedPressure = decidedSide === 'buy' ? flowPressure : -flowPressure;
  const supportiveScore = Math.max(0, alignedPressure) * (1 + Math.max(0, acceleration));
  const hostileScore = Math.max(0, -alignedPressure) * (1 + Math.max(0, acceleration));
  const decayPenalty = Math.max(0, -acceleration) * Math.max(0, alignedPressure);
  let scalar = 1 + (supportiveScore * boostSlope);
  scalar = clamp(scalar, 1.0, maxBoost);
  return {
    scalar,
    diagnostics: {
      enabled: true,
      active: true,
      windowMs,
      minTrades,
      tradeCount,
      flowPressure,
      alignedPressure,
      acceleration,
      supportiveScore,
      hostileScore,
      decayPenalty,
      minScalar,
      maxBoost
    }
  };
}

function resolveCtxSizeScalar(market, decidedSide, tradeConfig) {
  const cfg = tradeConfig?.wsAdaptive?.sizeScalars?.ctx ?? {};
  if (cfg.enabled === false) return { scalar: 1, diagnostics: { enabled: false } };
  const ctxSignals = collectCtxSizeSensor(market, decidedSide, tradeConfig);
  const funding = toNumber(ctxSignals?.inputs?.funding);
  const premium = toNumber(ctxSignals?.inputs?.premium);
  const minScalar = 1.0;
  const maxBoost = clamp(toNumber(cfg.maxBoost, 1.05), 1.0, 1.2);
  const hostileScore = toNumber(ctxSignals?.outputs?.hostileScore, 0);
  const favorableScore = toNumber(ctxSignals?.outputs?.favorableScore, 0);
  const favorableBoostSlope = Math.max(0, toNumber(cfg.favorableBoostSlope, 0.03));
  let scalar = 1 + (favorableScore * favorableBoostSlope);
  scalar = clamp(scalar, 1.0, maxBoost);
  return {
    scalar,
    diagnostics: {
      enabled: true,
      active: true,
      funding,
      premium,
      hostileScore,
      favorableScore,
      minScalar,
      maxBoost
    }
  };
}

function resolveSizeScalar(entryQualityScore, tradeConfig) {
  const sizeCfg = tradeConfig?.b2Upgrade?.adaptiveSize ?? {};
  if (sizeCfg.enabled === false) return 1.0;
  const minScalar = clamp(toNumber(sizeCfg.minScalar, 1.0), 1.0, 2.0);
  const maxScalar = clamp(toNumber(sizeCfg.maxScalar, 1.25), 1.0, 2.0);
  return minScalar + (maxScalar - minScalar) * clamp(entryQualityScore, 0, 1);
}

function resolveFeeEdgeThresholds(payload, executionSignals, feeEdgeGuard) {
  const equityUsd = Number(payload?.accountEquity);
  const tradeConfig = getTradeConfig();
  const stage = resolveCapitalStageProfile(tradeConfig, equityUsd);
  const stageMinNetUsd = Math.max(0, toNumber(stage?.feeMinNetUsd, 0));
  const baseMinNetUsd = Math.max(1.0, toNumber(feeEdgeGuard?.minNetUsd, 1.0), stageMinNetUsd);
  const baseMinNetPer100 = Math.max(0, toNumber(feeEdgeGuard?.minNetPer100Notional, 0.02));
  const dyn = feeEdgeGuard?.dynamic ?? {};
  if (dyn.enabled === false) {
    return {
      minNetUsd: baseMinNetUsd,
      minNetPer100: baseMinNetPer100,
      session: 'none',
      sessionMul: 1,
      stressMul: 1
    };
  }
  const tzOffsetMin = Math.floor(toNumber(dyn.tzOffsetMin, 540));
  const ts = Number(payload?.timestamp);
  const utcMs = Number.isFinite(ts) ? ts : Date.now();
  const localHour = new Date(utcMs + (tzOffsetMin * 60000)).getUTCHours();
  let session = 'asia';
  if (localHour >= 8 && localHour < 16) session = 'eu';
  if (localHour >= 16 || localHour < 1) session = 'us';
  const sessionMulCfg = dyn.sessionMul ?? {};
  const sessionMul = clamp(
    toNumber(sessionMulCfg[session], toNumber(sessionMulCfg.asia, 1.0)),
    0.5,
    2.0
  );
  const stressCfg = dyn.stress ?? {};
  const spreadRef = Math.max(0.1, toNumber(stressCfg.spreadBpsRef, 0.6));
  const velocityRef = Math.max(0.1, toNumber(stressCfg.velocityBpsRef, 0.7));
  const maxMul = clamp(toNumber(stressCfg.maxMul, 1.2), 1.0, 3.0);
  const spreadRatio = Math.max(0, toNumber(executionSignals?.spreadBps, 0) / spreadRef);
  const velocityRatio = Math.max(0, toNumber(executionSignals?.velocityBps, 0) / velocityRef);
  const stressRatio = Math.max(spreadRatio, velocityRatio);
  const stressMul = clamp(1 + Math.max(0, stressRatio - 1) * 0.15, 1.0, maxMul);
  const netMul = sessionMul * stressMul;
  return {
    minNetUsd: baseMinNetUsd * netMul,
    minNetPer100: baseMinNetPer100 * netMul,
    session,
    sessionMul,
    stressMul
  };
}

function resolveStructureQualityScalar(structureSnapshot, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.structureQuality ?? {};
  if (cfg.enabled === false) {
    return { scalar: 1.0, quality: null, source: String(structureSnapshot?.structureSource ?? 'unknown') };
  }
  const qualityRaw = Number(structureSnapshot?.structureQuality);
  const quality = Number.isFinite(qualityRaw) ? clamp(qualityRaw, 0, 1) : null;
  const source = String(structureSnapshot?.structureSource ?? 'unknown');
  const minScalar = clamp(toNumber(cfg.minScalar, 1.0), 1.0, 2.0);
  const maxScalar = clamp(toNumber(cfg.maxScalar, 1.0), 0.8, 2.0);
  const fallbackQuality = clamp(toNumber(cfg.fallbackQuality, 0.5), 0, 1);
  const q = quality ?? fallbackQuality;
  const scalar = minScalar + (maxScalar - minScalar) * q;
  return { scalar: clamp(scalar, 1.0, 2.0), quality, source };
}

function resolveStartupSizeScalar(ioMetrics, tradeConfig) {
  const cfg = tradeConfig?.startup?.restartAssist ?? {};
  if (cfg.enabled === false) return 1.0;
  if (ioMetrics?.bar1hState?.ready === true) return 1.0;
  const mode = String(ioMetrics?.startupProfile?.mode ?? '').toLowerCase();
  if (mode === 'hot') return clamp(toNumber(cfg.hotSizeScalar, 1.0), 1.0, 2.0);
  if (mode === 'warm') return clamp(toNumber(cfg.warmSizeScalar, 0.85), 1.0, 2.0);
  if (mode === 'cold') return clamp(toNumber(cfg.coldSizeScalar, 0.65), 1.0, 2.0);
  return 1.0;
}

function resolveStartupEntryGuard(ioMetrics, tradeConfig) {
  const cfg = tradeConfig?.startupGuard ?? {};
  const enabled = cfg.enabled !== false;
  const noOrderMs = Math.max(0, toNumber(cfg.noOrderMs, 1800000));
  const windowMs = Math.max(0, toNumber(cfg.windowMs, 5400000));
  const elapsedRaw = Number(ioMetrics?.elapsedMs);
  const hasElapsed = Number.isFinite(elapsedRaw) && elapsedRaw >= 0;
  const elapsedMs = hasElapsed ? elapsedRaw : 0;
  const inTest = process.env.TEST_MODE === '1';
  const applyInTestMode = cfg.applyInTestMode !== false;
  const applies = enabled && hasElapsed && windowMs > 0 && (!inTest || applyInTestMode);
  const active = applies && elapsedMs <= windowMs;
  const noOrderActive = active && elapsedMs <= noOrderMs;
  const restrictedActive = active && !noOrderActive;
  if (!active) {
    return {
      active: false,
      phase: 'normal',
      noOrderActive: false,
      restrictedActive: false,
      sizeScalar: 1.0,
      minMapStrengthAdd: 0,
      minPathDepthAdd: 0,
      liveBlockUntilAStable: cfg.liveBlockUntilAStable === true,
      elapsedMs,
      noOrderMs,
      windowMs
    };
  }
  return {
    active: true,
    phase: noOrderActive ? 'no_order' : 'restricted',
    noOrderActive,
    restrictedActive,
    sizeScalar: restrictedActive ? clamp(toNumber(cfg.sizeScalar, 0.9), 1.0, 2.0) : 1.0,
    minMapStrengthAdd: restrictedActive ? clamp(toNumber(cfg.minMapStrengthAdd, 0.05), 0, 0.3) : 0,
    minPathDepthAdd: restrictedActive ? Math.max(0, Math.min(3, Math.floor(toNumber(cfg.minPathDepthAdd, 1)))) : 0,
    liveBlockUntilAStable: cfg.liveBlockUntilAStable === true,
    elapsedMs,
    noOrderMs,
    windowMs
  };
}

function normalizeDirection(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'UP' || v === 'LONG' || v === 'BUY') return 'UP';
  if (v === 'DOWN' || v === 'SHORT' || v === 'SELL') return 'DOWN';
  if (v === 'RANGE') return 'RANGE';
  return 'NONE';
}

function directionFromC(rawC, deadband = 0.2) {
  const c = toNumber(rawC);
  if (!Number.isFinite(c)) return 'NONE';
  if (c >= deadband) return 'UP';
  if (c <= -deadband) return 'DOWN';
  return 'RANGE';
}

function resolveBTrendDirection(payload, tradeConfig) {
  const ioMetrics = payload?.ioMetrics ?? {};
  const bar15m = ioMetrics?.bar15mState ?? {};
  const bar1h = ioMetrics?.bar1hState ?? {};
  const lrcTv = ioMetrics?.lrcTvState ?? {};
  const lrcA = ioMetrics?.lrcAState ?? {};
  const dir15m = normalizeDirection(
    bar15m.direction ??
    lrcTv.trendState ??
    lrcTv.trend
  );
  const dir1h = normalizeDirection(
    bar1h.direction ??
    lrcA.trendState ??
    lrcA.trend
  );

  let combined = 'RANGE';
  const dir15mIsDirectional = dir15m === 'UP' || dir15m === 'DOWN';
  const dir1hIsDirectional = dir1h === 'UP' || dir1h === 'DOWN';
  if (dir15mIsDirectional && dir1hIsDirectional) {
    // 15mを最終執行の主軸として優先
    combined = dir15m;
  } else if (dir15mIsDirectional) {
    combined = dir15m;
  } else if (dir1hIsDirectional) {
    combined = dir1h;
  }

  return { dir15m, dir1h, combined };
}

function sideToDirection(side) {
  if (side === 'buy') return 'UP';
  if (side === 'sell') return 'DOWN';
  return 'NONE';
}

function slopeToDirection(rawSlope) {
  const slope = toNumber(rawSlope);
  if (!Number.isFinite(slope)) return 'NONE';
  if (slope > 0) return 'UP';
  if (slope < 0) return 'DOWN';
  return 'RANGE';
}

export function resolveDirectionalAngleBoost(side, bTrend, aResult, payload, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.angleDirectionBoost ?? {};
  const enabled = cfg.enabled === true;
  if (!enabled) {
    return {
      multiplier: 1.0,
      sideDir: sideToDirection(side),
      bDir: 'NONE',
      aDir: 'NONE',
      bAligned: false,
      aAlignedWithB: false,
      reason: 'disabled'
    };
  }

  const sideDir = sideToDirection(side);
  if (sideDir !== 'UP' && sideDir !== 'DOWN') {
    return {
      multiplier: 1.0,
      sideDir,
      bDir: 'NONE',
      aDir: 'NONE',
      bAligned: false,
      aAlignedWithB: false,
      reason: 'no_side_direction'
    };
  }

  const ioMetrics = payload?.ioMetrics ?? {};
  const bSlopeDir = slopeToDirection(ioMetrics?.lrcTvState?.slope ?? ioMetrics?.lrcState?.slope);
  const bDirFallback = normalizeDirection(
    bTrend?.combined ??
    bTrend?.dir15m ??
    ioMetrics?.bar15mState?.direction
  );
  const bDir = (bSlopeDir === 'UP' || bSlopeDir === 'DOWN') ? bSlopeDir : bDirFallback;

  const aSlopeDir = slopeToDirection(aResult?.aTrendAngle?.h1Slope ?? aResult?.aTrendAngle?.dailySlope);
  const aDirFallback = normalizeDirection(
    aResult?.h1Bias ??
    aResult?.dailyBias ??
    aResult?.regime
  );
  const aDir = (aSlopeDir === 'UP' || aSlopeDir === 'DOWN') ? aSlopeDir : aDirFallback;

  const bAlignedBoost = clamp(toNumber(cfg.bAlignedBoost, 1.0), 1.0, 2.0);
  const aAlignedExtraBoost = clamp(toNumber(cfg.aAlignedExtraBoost, 1.0), 1.0, 2.0);
  const angle15mMagnitudeEnabled = cfg.angle15mMagnitudeEnabled === true;
  const angle15mRefNormalizedSlope = Math.max(0.01, toNumber(cfg.angle15mRefNormalizedSlope, 2.0));
  const angle15mMaxBoost = clamp(toNumber(cfg.angle15mMaxBoost, 1.15), 1.0, 3.0);
  const angle15mNormSlope = Math.abs(toNumber(ioMetrics?.lrcTvState?.normalizedSlope, 0));

  let multiplier = 1.0;
  const bAligned = bDir === sideDir;
  const aAlignedWithB = bAligned && aDir === sideDir;
  if (bAligned) {
    multiplier *= bAlignedBoost;
    if (aAlignedWithB) {
      multiplier *= aAlignedExtraBoost;
    }
  }
  let angle15mMagnitudeBoost = 1.0;
  if (angle15mMagnitudeEnabled && bAligned) {
    const normRatio = clamp(angle15mNormSlope / angle15mRefNormalizedSlope, 0, 1);
    angle15mMagnitudeBoost = 1 + (angle15mMaxBoost - 1) * normRatio;
    multiplier *= angle15mMagnitudeBoost;
  }

  return {
    multiplier,
    sideDir,
    bDir,
    aDir,
    bAligned,
    aAlignedWithB,
    angle15mNormSlope,
    angle15mMagnitudeBoost,
    reason: bAligned ? (aAlignedWithB ? 'b_and_a_aligned' : 'b_aligned_only') : 'no_alignment'
  };
}

export function resolveClusterWallPowerBoost(side, payload, srClusterView, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.clusterWallBoost ?? {};
  if (cfg.enabled === false) {
    return {
      multiplier: 1.0,
      reason: 'disabled'
    };
  }

  const sideDir = sideToDirection(side);
  if (sideDir !== 'UP' && sideDir !== 'DOWN') {
    return {
      multiplier: 1.0,
      reason: 'no_side_direction'
    };
  }

  const market = payload?.market ?? {};
  const ioMetrics = payload?.ioMetrics ?? {};
  const mid = toNumber(market?.midPx);
  if (!Number.isFinite(mid) || mid <= 0) {
    return {
      multiplier: 1.0,
      reason: 'no_mid'
    };
  }

  const maxBoost = clamp(toNumber(cfg.maxBoost, 1.18), 1.0, 3.0);
  const clusterWeight = clamp(toNumber(cfg.clusterWeight, 0.55), 0, 1);
  const wallWeight = clamp(toNumber(cfg.wallWeight, 0.45), 0, 1);
  const weightSum = Math.max(1e-6, clusterWeight + wallWeight);
  const normalizedClusterWeight = clusterWeight / weightSum;
  const normalizedWallWeight = wallWeight / weightSum;

  const clusters = Array.isArray(srClusterView?.clusters) ? srClusterView.clusters : [];
  const clusterCount = Math.max(0, Math.floor(toNumber(srClusterView?.clusterCount, clusters.length)));
  const mapStrength = clamp(toNumber(srClusterView?.mapStrength, 0), 0, 1);
  const pathDepth = Math.max(0, Math.floor(toNumber(srClusterView?.pathDepth, 0)));
  const maxClusters = Math.max(1, Math.floor(toNumber(cfg.maxClusters, 7)));
  const maxPathDepth = Math.max(1, Math.floor(toNumber(cfg.maxPathDepth, 4)));
  const clusterCountNorm = clamp(clusterCount / maxClusters, 0, 1);
  const pathDepthNorm = clamp(pathDepth / maxPathDepth, 0, 1);

  const mapStrengthWeight = clamp(toNumber(cfg.mapStrengthWeight, 0.5), 0, 1);
  const pathDepthWeight = clamp(toNumber(cfg.pathDepthWeight, 0.3), 0, 1);
  const clusterCountWeight = clamp(toNumber(cfg.clusterCountWeight, 0.2), 0, 1);
  const clusterSubWeightSum = Math.max(1e-6, mapStrengthWeight + pathDepthWeight + clusterCountWeight);
  const clusterScore = clamp(
    (
      (mapStrength * mapStrengthWeight) +
      (pathDepthNorm * pathDepthWeight) +
      (clusterCountNorm * clusterCountWeight)
    ) / clusterSubWeightSum,
    0,
    1
  );

  const depthSR = ioMetrics?.depthSR ?? {};
  const wallRef = side === 'buy'
    ? resolveNearestSupport(depthSR, mid)
    : resolveNearestResistance(depthSR, mid);
  const wallPrice = toNumber(wallRef?.price);
  const wallNotionalUsd = toNumber(wallRef?.notionalUsd);
  const wallDistanceUsd = Number.isFinite(wallPrice) ? Math.abs(mid - wallPrice) : NaN;
  const nearWindowUsd = Math.max(1, toNumber(cfg.nearWindowUsd, 120));
  const minWallUsd = Math.max(0, toNumber(cfg.minWallUsd, 70000));
  const wallSaturationUsd = Math.max(minWallUsd + 1, toNumber(cfg.wallSaturationUsd, 250000));
  const wallNear = Number.isFinite(wallDistanceUsd) && wallDistanceUsd <= nearWindowUsd;
  let wallScore = 0;
  if (wallNear && Number.isFinite(wallNotionalUsd) && wallNotionalUsd >= minWallUsd) {
    wallScore = clamp((wallNotionalUsd - minWallUsd) / Math.max(1, wallSaturationUsd - minWallUsd), 0, 1);
  }

  const totalScore = clamp(
    (clusterScore * normalizedClusterWeight) + (wallScore * normalizedWallWeight),
    0,
    1
  );
  const multiplier = clamp(1 + (totalScore * (maxBoost - 1.0)), 1.0, maxBoost);

  return {
    multiplier,
    reason: 'ok',
    totalScore,
    clusterScore,
    wallScore,
    clusterCount,
    mapStrength,
    pathDepth,
    wallNotionalUsd: Number.isFinite(wallNotionalUsd) ? wallNotionalUsd : null,
    wallDistanceUsd: Number.isFinite(wallDistanceUsd) ? wallDistanceUsd : null,
    wallNear,
    nearWindowUsd,
    minWallUsd,
    wallSaturationUsd,
    maxBoost
  };
}

function resolveAbAlignmentBoost(aRegime, bRegime, side, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.abTrendBoost ?? {};
  const enabled = cfg.enabled === true;
  if (!enabled) return 1.0;

  const sideDir = sideToDirection(side);
  const aDir = normalizeDirection(aRegime);
  const bDir = normalizeDirection(bRegime);
  if ((bDir !== 'UP' && bDir !== 'DOWN') || sideDir !== bDir) {
    return 1.0;
  }

  const bothAlignedBoost = clamp(toNumber(cfg.bothAlignedBoost, 1.0), 1.0, 2.0);
  if (aDir === bDir) return bothAlignedBoost;
  return 1.0;
}

function resolveACenterStrengthMul(cRaw, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.aCenterControl ?? {};
  const enabled = cfg.enabled === true;
  if (!enabled) return 1.0;

  const c = toNumber(cRaw);
  if (!Number.isFinite(c)) return 1.0;

  const centerBand = clamp(toNumber(cfg.centerBand, 0.15), 0.01, 0.8);
  const centerMul = clamp(toNumber(cfg.centerMul, 1.0), 0.5, 1.0);
  if (Math.abs(c) <= centerBand) return centerMul;
  return 1.0;
}

function frameAlignmentScore(frameDir, sideDir) {
  if (frameDir === 'NONE' || frameDir === 'RANGE' || sideDir === 'NONE') return 0;
  return frameDir === sideDir ? 1 : -1;
}

function resolveHigherTfControl(payload, regime, side, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.higherTfControl ?? {};
  const enabled = cfg.enabled !== false;
  const applyOnRegimeOnly = cfg.applyOnRegimeOnly !== false;
  const isDirectionalRegime = regime === 'UP' || regime === 'DOWN';
  if (!enabled || (applyOnRegimeOnly && !isDirectionalRegime)) {
    return {
      enabled,
      applied: false,
      alignScore: 0,
      sizeMul: 1,
      tpMul: 1,
      block: false,
      readyFrames: 0
    };
  }

  const sideDir = sideToDirection(side);
  const ioMetrics = payload?.ioMetrics ?? {};
  const bar15m = ioMetrics?.bar15mState ?? {};
  const bar1h = ioMetrics?.bar1hState ?? {};
  const lrcTv = ioMetrics?.lrcTvState ?? {};
  const lrcA = ioMetrics?.lrcAState ?? {};

  // bar state に direction が無いケースがあるため、LRC の trend 系を優先フォールバックする。
  const dir15m = normalizeDirection(
    bar15m.direction ??
    lrcTv.trendState ??
    lrcTv.trend
  );
  const dir1h = normalizeDirection(
    bar1h.direction ??
    lrcA.trendState ??
    lrcA.trend
  );
  const ready15m = bar15m.ready === true || lrcTv.ready === true;
  const ready1h = bar1h.ready === true || lrcA.ready === true;
  const minReadyFrames = Math.max(0, toNumber(cfg.minReadyFrames, 1));
  const readyFrames = (ready15m ? 1 : 0) + (ready1h ? 1 : 0);

  if (readyFrames < minReadyFrames) {
    return {
      enabled,
      applied: false,
      alignScore: 0,
      sizeMul: 1,
      tpMul: 1,
      block: false,
      readyFrames,
      dir15m,
      dir1h
    };
  }

  const w15mRaw = clamp(toNumber(cfg.weight15m, 0.65), 0, 1);
  const w1hRaw = clamp(toNumber(cfg.weight1h, 0.35), 0, 1);
  const w15m = ready15m ? w15mRaw : 0;
  const w1h = ready1h ? w1hRaw : 0;
  const wSum = w15m + w1h;
  const n15m = frameAlignmentScore(dir15m, sideDir);
  const n1h = frameAlignmentScore(dir1h, sideDir);
  const alignScore = wSum > 0 ? ((n15m * w15m + n1h * w1h) / wSum) : 0;

  const sizeBoostMax = clamp(toNumber(cfg.sizeBoostMax, 1.30), 1.0, 2.5);
  const sizePenaltyMin = clamp(toNumber(cfg.sizePenaltyMin, 1.0), 1.0, 2.0);
  const tpBoostMax = clamp(toNumber(cfg.tpBoostMax, 1.20), 1.0, 2.0);
  const tpPenaltyMin = clamp(toNumber(cfg.tpPenaltyMin, 1.0), 1.0, 2.0);
  const pos = Math.max(0, alignScore);
  const neg = Math.max(0, -alignScore);
  const sizeMul = clamp((1 + pos * (sizeBoostMax - 1)) * (1 - neg * (1 - sizePenaltyMin)), 1.0, 3);
  const tpMul = clamp((1 + pos * (tpBoostMax - 1)) * (1 - neg * (1 - tpPenaltyMin)), 1.0, 3);

  const blockOnConflict = cfg.blockOnConflict === true;
  const blockThreshold = clamp(toNumber(cfg.blockThreshold, -0.7), -1.0, 0);
  const block = blockOnConflict && alignScore <= blockThreshold;

  return {
    enabled,
    applied: true,
    alignScore,
    sizeMul,
    tpMul,
    block,
    blockThreshold,
    readyFrames,
    dir15m,
    dir1h
  };
}

function resolveViewpointStepUsd(mid, arenaBounds, ioMetrics, tradeConfig) {
  const cfg = tradeConfig?.viewpoint ?? {};
  const minStepUsd = Math.max(1, toNumber(cfg.minStepUsd, 120));
  const arenaStepRatio = clamp(toNumber(cfg.arenaStepRatio, 0.12), 0.02, 0.8);
  const bar15mWeight = clamp(toNumber(cfg.bar15mRangeWeight, 0.9), 0.1, 3.0);
  const top = toNumber(arenaBounds?.top);
  const bottom = toNumber(arenaBounds?.bottom);
  const arenaSpan = Number.isFinite(top) && Number.isFinite(bottom) && top > bottom ? (top - bottom) : null;
  const bar15m = ioMetrics?.bar15mState ?? {};
  const bar15mRange = Number.isFinite(bar15m?.high) && Number.isFinite(bar15m?.low) && bar15m.high > bar15m.low
    ? (bar15m.high - bar15m.low)
    : null;
  const arenaStep = Number.isFinite(arenaSpan) ? arenaSpan * arenaStepRatio : 0;
  const bar15mStep = Number.isFinite(bar15mRange) ? bar15mRange * bar15mWeight : 0;
  return Math.max(minStepUsd, arenaStep, bar15mStep);
}

function resolveNearSrRetryStepUsd(stepUsd, tradeConfig) {
  const cfg = tradeConfig?.viewpoint ?? {};
  const retryFactor = clamp(toNumber(cfg.nearRetryFactor, 0.6), 0.2, 0.95);
  const retryMinUsd = Math.max(1, toNumber(cfg.nearRetryMinUsd, 20));
  const base = Number.isFinite(stepUsd) && stepUsd > 0 ? stepUsd : retryMinUsd;
  return Math.min(base, Math.max(retryMinUsd, base * retryFactor));
}

function resolveClusterTpPlan(decidedSide, mid, stepUsd, srClusterView, fallbackEdge) {
  const clustersRaw = Array.isArray(srClusterView?.clusters) ? srClusterView.clusters : [];
  const clusters = clustersRaw
    .filter(cluster => Number.isFinite(Number(cluster?.centerPrice)))
    .map(cluster => ({
      price: Number(cluster.centerPrice),
      type: String(cluster?.type ?? 'sr').toLowerCase()
    }));
  if (clusters.length === 0) return null;

  const mapTpSource = (type) => {
    if (type === 'channel_edge' || type === 'outer_range') return 'channel_edge';
    return 'sr_next';
  };

  if (decidedSide === 'buy') {
    const upward = clusters
      .filter(cluster => cluster.price >= (mid + stepUsd))
      .sort((a, b) => a.price - b.price);
    if (upward.length > 0) {
      const next = upward[0];
      const second = upward[1] ?? null;
      return {
        targetPrice: next.price,
        tpSource: mapTpSource(next.type),
        ladder: {
          tp1: next.price,
          tp2: second?.price ?? null,
          edge: Number.isFinite(fallbackEdge?.upper) ? fallbackEdge.upper : null
        }
      };
    }
  }

  if (decidedSide === 'sell') {
    const downward = clusters
      .filter(cluster => cluster.price <= (mid - stepUsd))
      .sort((a, b) => b.price - a.price);
    if (downward.length > 0) {
      const next = downward[0];
      const second = downward[1] ?? null;
      return {
        targetPrice: next.price,
        tpSource: mapTpSource(next.type),
        ladder: {
          tp1: next.price,
          tp2: second?.price ?? null,
          edge: Number.isFinite(fallbackEdge?.lower) ? fallbackEdge.lower : null
        }
      };
    }
  }

  return null;
}

function isEdgeLikeType(typeRaw) {
  const type = String(typeRaw ?? '').toLowerCase();
  return type === 'channel_edge' || type === 'outer_range' || type === 'rail';
}

function uniqueSortedPrices(values, direction = 'asc') {
  const uniq = [...new Set(
    values
      .map(v => Number(v))
      .filter(v => Number.isFinite(v))
      .map(v => Number(v.toFixed(6)))
  )];
  uniq.sort((a, b) => direction === 'desc' ? (b - a) : (a - b));
  return uniq;
}

function buildChannelSrLineMap(structureSnapshot, srClusterView, channelTop, channelBottom) {
  const inChannel = (price) => {
    if (!Number.isFinite(price)) return false;
    if (Number.isFinite(channelTop) && price > channelTop) return false;
    if (Number.isFinite(channelBottom) && price < channelBottom) return false;
    return true;
  };

  const clusterLevels = Array.isArray(srClusterView?.clusters) ? srClusterView.clusters : [];
  const channelMid = (Number.isFinite(channelTop) && Number.isFinite(channelBottom) && channelTop > channelBottom)
    ? (channelTop + channelBottom) / 2
    : null;

  const supports = [];
  const resistances = [];
  const edgeSupports = [];
  const edgeResistances = [];

  for (const cluster of clusterLevels) {
    const price = Number(cluster?.centerPrice);
    if (!inChannel(price)) continue;
    const type = String(cluster?.type ?? '').toLowerCase();
    if (isEdgeLikeType(type)) {
      if (Number.isFinite(channelMid)) {
        if (price <= channelMid) edgeSupports.push(price);
        else edgeResistances.push(price);
      }
      continue;
    }
    if (type === 'support') {
      supports.push(price);
      continue;
    }
    if (type === 'resistance') {
      resistances.push(price);
      continue;
    }
    if (Number.isFinite(channelMid)) {
      if (price <= channelMid) supports.push(price);
      else resistances.push(price);
    }
  }

  return {
    supports: uniqueSortedPrices(supports, 'asc'),
    resistances: uniqueSortedPrices(resistances, 'asc'),
    edgeSupports: uniqueSortedPrices(edgeSupports, 'asc'),
    edgeResistances: uniqueSortedPrices(edgeResistances, 'asc')
  };
}

function resolveSrBracketFromLines(mid, channelSrLineMap, rails, srClusterView = null) {
  const supports = Array.isArray(channelSrLineMap?.supports) ? channelSrLineMap.supports : [];
  const resistances = Array.isArray(channelSrLineMap?.resistances) ? channelSrLineMap.resistances : [];
  const nextSupport = Number(srClusterView?.nextDown?.centerPrice);
  const nextResistance = Number(srClusterView?.nextUp?.centerPrice);
  const lowerLine = supports
    .filter((price) => Number.isFinite(price) && price < mid)
    .sort((a, b) => b - a)[0];
  const upperLine = resistances
    .filter((price) => Number.isFinite(price) && price > mid)
    .sort((a, b) => a - b)[0];

  const supportFromCluster = Number.isFinite(nextSupport) && nextSupport < mid;
  const resistanceFromCluster = Number.isFinite(nextResistance) && nextResistance > mid;

  const supportRefPrice = supportFromCluster
    ? nextSupport
    : (Number.isFinite(lowerLine) ? lowerLine : rails.lower);
  const resistanceRefPrice = resistanceFromCluster
    ? nextResistance
    : (Number.isFinite(upperLine) ? upperLine : rails.upper);

  return {
    supportRefPrice,
    resistanceRefPrice,
    source: {
      support: supportFromCluster
        ? 'sr_cluster_nextDown'
        : (Number.isFinite(lowerLine) ? 'sr_line_below' : 'rails_lower'),
      resistance: resistanceFromCluster
        ? 'sr_cluster_nextUp'
        : (Number.isFinite(upperLine) ? 'sr_line_above' : 'rails_upper')
    },
    srLines: {
      supports,
      resistances,
      supportCount: supports.length,
      resistanceCount: resistances.length,
    }
  };
}

function resolveNearestStructureRefs(mid, structureSnapshot, srClusterView, rails) {
  const nextSupport = Number(srClusterView?.nextDown?.centerPrice);
  const nextResistance = Number(srClusterView?.nextUp?.centerPrice);

  const supportRefPrice = Number.isFinite(nextSupport) && nextSupport < mid
    ? nextSupport
    : rails.lower;
  const resistanceRefPrice = Number.isFinite(nextResistance) && nextResistance > mid
    ? nextResistance
    : rails.upper;

  return {
    supportRefPrice,
    resistanceRefPrice,
    source: {
      support: Number.isFinite(nextSupport) && nextSupport < mid ? 'sr_cluster_nextDown' : 'rails_lower',
      resistance: Number.isFinite(nextResistance) && nextResistance > mid ? 'sr_cluster_nextUp' : 'rails_upper'
    }
  };
}

function resolveEdgeNearThresholdUsd(channelTop, channelBottom) {
  if (!Number.isFinite(channelTop) || !Number.isFinite(channelBottom) || channelTop <= channelBottom) return 8;
  const span = channelTop - channelBottom;
  return clamp(Math.min(40, span * 0.10), 8, 80);
}

function resolveEdgeFallbackGuard(tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.executionModel?.edgeFallback ?? {};
  return {
    enabled: cfg.enabled !== false,
    minMapStrength: clamp(toNumber(cfg.minMapStrength, 0.5), 0.0, 1.0),
    minPathDepth: Math.max(0, Math.floor(toNumber(cfg.minPathDepth, 1)))
  };
}

function canUseEdgeFallbackAsPrimary(decidedSide, mid, channelTop, channelBottom, supports, resistances, srClusterView, tradeConfig) {
  const edgeNearThresholdUsd = resolveEdgeNearThresholdUsd(channelTop, channelBottom);
  const guard = resolveEdgeFallbackGuard(tradeConfig);

  // SR mapが有効な局面では、edge fallbackの一次TPを品質条件で制限する
  if (guard.enabled && Number(srClusterView?.clusterCount) > 0) {
    const mapStatus = String(srClusterView?.mapStatus ?? 'unknown').toLowerCase();
    const mapStrength = toNumber(srClusterView?.mapStrength);
    const pathDepth = Math.max(0, Math.floor(toNumber(srClusterView?.pathDepth, 0)));
    if (mapStatus === 'weak' || mapStatus === 'none') return false;
    if (Number.isFinite(mapStrength) && mapStrength < guard.minMapStrength) return false;
    if (pathDepth < guard.minPathDepth) return false;
  }

  if (decidedSide === 'buy') {
    const nearLowerEdge = Number.isFinite(channelBottom) && (mid - channelBottom) <= edgeNearThresholdUsd;
    const hasSupportNearLowerEdge = supports.some(p => Math.abs(p - channelBottom) <= edgeNearThresholdUsd * 1.5);
    return nearLowerEdge && hasSupportNearLowerEdge;
  }
  if (decidedSide === 'sell') {
    const nearUpperEdge = Number.isFinite(channelTop) && (channelTop - mid) <= edgeNearThresholdUsd;
    const hasResistanceNearUpperEdge = resistances.some(p => Math.abs(channelTop - p) <= edgeNearThresholdUsd * 1.5);
    return nearUpperEdge && hasResistanceNearUpperEdge;
  }
  return false;
}

function resolveTpPlan(decidedSide, mid, structureSnapshot, arenaBounds, ioMetrics, tradeConfig, srClusterView = null, options = {}, tpBandDiagnostics = null) {
  const channelTop = Number.isFinite(arenaBounds?.top) ? Number(arenaBounds.top) : Number(structureSnapshot?.rails?.upper);
  const channelBottom = Number.isFinite(arenaBounds?.bottom) ? Number(arenaBounds.bottom) : Number(structureSnapshot?.rails?.lower);
  const channelMid = (Number.isFinite(channelTop) && Number.isFinite(channelBottom) && channelTop > channelBottom)
    ? (channelTop + channelBottom) / 2
    : null;
  const halfSpan = (Number.isFinite(channelTop) && Number.isFinite(channelBottom) && channelTop > channelBottom)
    ? (channelTop - channelBottom) / 2
    : null;
  const viewpointCfg = tradeConfig?.viewpoint ?? {};
  const tpNormalMaxT = clamp(toNumber(viewpointCfg.tpNormalMaxT, 0.786), 0.1, 1.0);
  const diagnostics = tpBandDiagnostics && typeof tpBandDiagnostics === 'object' ? tpBandDiagnostics : null;
  const channelTFromPrice = (price) => {
    if (!Number.isFinite(price) || !Number.isFinite(channelMid) || !Number.isFinite(halfSpan) || halfSpan <= 0) return null;
    return clamp(Math.abs(price - channelMid) / halfSpan, 0, 1);
  };
  const isWithinNormalTpBand = (price) => {
    const t = channelTFromPrice(price);
    return Number.isFinite(t) ? t <= tpNormalMaxT : true;
  };
  const stepUsd = resolveViewpointStepUsd(mid, arenaBounds, ioMetrics, tradeConfig);

  // 先にチャネル全域のSRラインを構築し、その後に近傍選択へ進む
  const channelSrLineMap = buildChannelSrLineMap(structureSnapshot, srClusterView, channelTop, channelBottom);
  const supports = channelSrLineMap.supports;
  const resistances = channelSrLineMap.resistances;

  if (diagnostics) {
    diagnostics.tpNormalMaxT = tpNormalMaxT;
    diagnostics.stepUsd = stepUsd;
    diagnostics.decidedSide = decidedSide;
    diagnostics.channel = {
      top: Number.isFinite(channelTop) ? channelTop : null,
      bottom: Number.isFinite(channelBottom) ? channelBottom : null,
      mid: Number.isFinite(channelMid) ? channelMid : null,
      halfSpan: Number.isFinite(halfSpan) ? halfSpan : null
    };
    diagnostics.candidateCounts = {
      supports: Array.isArray(supports) ? supports.length : 0,
      resistances: Array.isArray(resistances) ? resistances.length : 0
    };
  }

  if (decidedSide === 'buy') {
    const resistanceTargetsRaw = uniqueSortedPrices(
      resistances.filter(p => p >= (mid + stepUsd)),
      'asc'
    );
    const resistanceTargets = uniqueSortedPrices(
      resistances.filter(p => p >= (mid + stepUsd) && isWithinNormalTpBand(p)),
      'asc'
    );
    if (diagnostics) {
      const rawFirst = resistanceTargetsRaw[0];
      const rawFirstT = Number.isFinite(rawFirst) ? channelTFromPrice(rawFirst) : null;
      diagnostics.tpBand = {
        side: 'buy',
        rawCandidateCount: resistanceTargetsRaw.length,
        filteredCandidateCount: resistanceTargets.length,
        firstRawCandidatePx: Number.isFinite(rawFirst) ? rawFirst : null,
        firstRawCandidateT: rawFirstT,
        candidateT: rawFirstT
      };
    }
    const nextRes = resistanceTargets[0];
    const secondRes = resistanceTargets[1];

    if (Number.isFinite(nextRes)) {
      const mapStrength = toNumber(srClusterView?.mapStrength, 0);
      const pathDepth = Math.max(0, Math.floor(toNumber(srClusterView?.pathDepth, 0)));
      const tpPhase = Number.isFinite(secondRes) && mapStrength >= 0.65 && pathDepth >= 2 ? 'CONTINUATION' : 'REACTION';
      return {
        targetPrice: nextRes,
        tpSource: 'sr_next',
        tpPhase,
        meta: {
          stepUsd,
          srCandidateCount: resistanceTargets.length,
          retryUsed: false
        },
        ladder: {
          tp1: nextRes,
          tp2: Number.isFinite(secondRes) ? secondRes : (Number.isFinite(channelTop) ? channelTop : null),
          edge: Number.isFinite(channelTop) ? channelTop : null
        }
      };
    }
    return null;
  } else if (decidedSide === 'sell') {
    const supportTargetsRaw = uniqueSortedPrices(
      supports.filter(p => p <= (mid - stepUsd)),
      'desc'
    );
    const supportTargets = uniqueSortedPrices(
      supports.filter(p => p <= (mid - stepUsd) && isWithinNormalTpBand(p)),
      'desc'
    );
    if (diagnostics) {
      const rawFirst = supportTargetsRaw[0];
      const rawFirstT = Number.isFinite(rawFirst) ? channelTFromPrice(rawFirst) : null;
      diagnostics.tpBand = {
        side: 'sell',
        rawCandidateCount: supportTargetsRaw.length,
        filteredCandidateCount: supportTargets.length,
        firstRawCandidatePx: Number.isFinite(rawFirst) ? rawFirst : null,
        firstRawCandidateT: rawFirstT,
        candidateT: rawFirstT
      };
    }
    const nextSup = supportTargets[0];
    const secondSup = supportTargets[1];

    if (Number.isFinite(nextSup)) {
      const mapStrength = toNumber(srClusterView?.mapStrength, 0);
      const pathDepth = Math.max(0, Math.floor(toNumber(srClusterView?.pathDepth, 0)));
      const tpPhase = Number.isFinite(secondSup) && mapStrength >= 0.65 && pathDepth >= 2 ? 'CONTINUATION' : 'REACTION';
      return {
        targetPrice: nextSup,
        tpSource: 'sr_next',
        tpPhase,
        meta: {
          stepUsd,
          srCandidateCount: supportTargets.length,
          retryUsed: false
        },
        ladder: {
          tp1: nextSup,
          tp2: Number.isFinite(secondSup) ? secondSup : (Number.isFinite(channelBottom) ? channelBottom : null),
          edge: Number.isFinite(channelBottom) ? channelBottom : null
        }
      };
    }
    return null;
  }

  return null;
}

function resolveMinStructuralTpDistanceUsd(tradeConfig, arenaBounds) {
  const cfg = tradeConfig?.structuralDistance ?? {};
  const enabled = cfg?.enabled !== false;
  if (!enabled) return 0;
  const absFloor = Math.max(0, toNumber(cfg.minStructuralDistanceUsd, 8));
  const useArenaSpan = cfg?.preferChannelSpan !== false;
  const ratio = clamp(toNumber(cfg.minStructuralDistanceRatio, 0.18), 0.02, 0.8);
  if (!useArenaSpan) return absFloor;
  const top = toNumber(arenaBounds?.top);
  const bottom = toNumber(arenaBounds?.bottom);
  const span = Number.isFinite(top) && Number.isFinite(bottom) && top > bottom ? (top - bottom) : null;
  if (!Number.isFinite(span) || span <= 0) return absFloor;
  const bySpan = span * ratio;
  return Math.max(absFloor, bySpan);
}

function resolveStretchedTarget(decidedSide, mid, candidatePx, tpPlan) {
  const edgePx = Number(tpPlan?.ladder?.edge);
  let out = Number(candidatePx);
  if (!Number.isFinite(out)) return Number(tpPlan?.targetPrice);
  if (Number.isFinite(edgePx)) {
    if (decidedSide === 'buy') out = Math.min(out, edgePx);
    if (decidedSide === 'sell') out = Math.max(out, edgePx);
  }
  if (decidedSide === 'buy' && out <= mid) return Number(tpPlan?.targetPrice);
  if (decidedSide === 'sell' && out >= mid) return Number(tpPlan?.targetPrice);
  return out;
}

function resolveLadderAttackScalar(tpPlan, mid, targetPrice, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.ladderAttack ?? {};
  if (cfg.enabled === false) return { scalar: 1.0, reason: 'disabled' };
  const source = String(tpPlan?.tpSource ?? 'unknown');
  if (cfg.requireSrNext !== false && source !== 'sr_next') {
    return { scalar: 1.0, reason: 'tp_source_not_sr_next' };
  }
  const tp1 = Number(targetPrice);
  const tp2 = Number(tpPlan?.ladder?.tp2);
  if (!Number.isFinite(mid) || !Number.isFinite(tp1) || !Number.isFinite(tp2)) {
    return { scalar: 1.0, reason: 'tp_ladder_missing' };
  }
  const d1 = Math.abs(tp1 - mid);
  const d2 = Math.abs(tp2 - mid);
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= d1) {
    return { scalar: 1.0, reason: 'tp2_not_farther' };
  }
  const ratio = d2 / d1;
  const minRatio = clamp(toNumber(cfg.minTp2DistanceRatio, 1.25), 1.0, 4.0);
  if (ratio < minRatio) {
    return { scalar: 1.0, reason: 'ratio_below_min', ratio, minRatio };
  }
  const slope = clamp(toNumber(cfg.distanceSlope, 0.35), 0.05, 2.0);
  const boostMax = clamp(toNumber(cfg.boostMax, 1.22), 1.0, 2.5);
  const bonus = Math.max(0, ratio - 1) * slope;
  const scalar = clamp(1 + bonus, 1.0, boostMax);
  return { scalar, reason: 'ok', ratio, minRatio };
}

function resolveThinOrderBookGate(ioMetrics, mid, decidedSide, tradeConfig) {
  const cfg = tradeConfig?.depthGuards ?? {};
  if (cfg.enabled !== true) {
    return { enabled: false, blocked: false, diagnostics: { enabled: false } };
  }

  const minSrNotionalUsd = Math.max(0, toNumber(cfg.minSrNotionalUsd, 0));
  const minTpNotionalUsd = Math.max(0, toNumber(cfg.minTpNotionalUsd, 0));
  const requireBothSides = cfg.requireBothSides !== false;
  const depthSR = ioMetrics?.depthSR ?? {};
  const nearestSupport = resolveNearestSupport(depthSR, mid);
  const nearestResistance = resolveNearestResistance(depthSR, mid);
  const entryRef = decidedSide === 'buy' ? nearestSupport : nearestResistance;
  const tpRef = decidedSide === 'buy' ? nearestResistance : nearestSupport;
  const srNotionalUsd = toNumber(entryRef?.notionalUsd, NaN);
  const tpNotionalUsd = toNumber(tpRef?.notionalUsd, NaN);
  const srReady = Number.isFinite(srNotionalUsd);
  const tpReady = Number.isFinite(tpNotionalUsd);
  const srPass = !minSrNotionalUsd || (srReady && srNotionalUsd >= minSrNotionalUsd);
  const tpPass = !minTpNotionalUsd || (tpReady && tpNotionalUsd >= minTpNotionalUsd);
  const blocked = requireBothSides ? !(srPass && tpPass) : (!srPass && !tpPass);

  return {
    enabled: true,
    blocked,
    diagnostics: {
      enabled: true,
      decidedSide,
      minSrNotionalUsd,
      minTpNotionalUsd,
      requireBothSides,
      srNotionalUsd: srReady ? srNotionalUsd : null,
      tpNotionalUsd: tpReady ? tpNotionalUsd : null,
      srPass,
      tpPass
    }
  };
}

/**
 * B ロジック層2（b2）メイン関数
 * 
 * @param {Object} payload - IO packet
 * @param {Object} aResult - A層の判定結果（allow/regime/etc）
 * @param {Object} structureSnapshot - b1 が生成した StructureSnapshot
 * @returns {Object} Decision {state, side, reason, ...}
 */
export function decideTradeB2(payload, aResult, structureSnapshot, srClusterView = null) {
  // Note: A.allow チェックは logic/index.js で実施済み（二重チェック不要）
  //       この関数は A.allow=true の時のみ呼ばれる

  // ガード0: 保有中は判定をスキップ
  if (payload?.engineState?.openPosition) {
    return {
      state: 'RANGE',
      side: 'none',
      reason: 'holding_position',
      source: 'B',
    };
  }

  // ガード1: StructureSnapshot の存在確認
  if (!structureSnapshot) {
    return {
      state: 'RANGE',
      side: 'none',
      reason: 'no_local_channel',
      source: 'B',
    };
  }

  // ガード2: StructureSnapshot のバリデーション
  // ← #7修正: Number.isFinite で厳密判定（0/負値レール対応）
  if (!structureSnapshot.rails || 
      !Number.isFinite(structureSnapshot.rails.upper) || 
      !Number.isFinite(structureSnapshot.rails.lower)) {
    return {
      state: 'RANGE',
      side: 'none',
      reason: 'no_local_channel',
      source: 'B',
    };
  }

  const { market = {}, ioMetrics = {} } = payload;
  const mid = market?.midPx ?? null;
  const regime = aResult?.regime ?? 'NONE';
  const tradeConfig = getTradeConfig();
  const bTrend = resolveBTrendDirection(payload, tradeConfig);
  const bRegime = bTrend.combined;
  const decisionState = (bRegime === 'UP' || bRegime === 'DOWN') ? bRegime : 'RANGE';
  const equityUsd = Number(payload?.accountEquity);
  const capitalStage = resolveCapitalStageProfile(tradeConfig, equityUsd);
  const executionModel = resolveExecutionModel(tradeConfig);
  const executionModelActive = executionModel.enabled && Number(srClusterView?.clusterCount) > 0;

  // ガード3: mid の存在確認
  if (!Number.isFinite(mid) || mid <= 0) {
    try {
      console.warn(`[B2] invalid mid price: ${mid}`);
    } catch (_) {}
    return {
      state: decisionState,
      side: 'none',
      reason: 'B: no mid price',
      source: 'B',
    };
  }

  // ─────────────────────────────────────────────
  // Phase 1: 構造ログ出力（診断用）
  // ─────────────────────────────────────────────
  const phase1Log = {
    structureSnapshot: {
      basis: structureSnapshot.basis,
      structureSource: structureSnapshot.structureSource ?? null,
      structureQuality: structureSnapshot.structureQuality ?? null,
      rails: structureSnapshot.rails,
      spanUsd: structureSnapshot.spanUsd,
      candidateCount: structureSnapshot.candidates?.length ?? 0,
      hash: structureSnapshot.hash,
      version: structureSnapshot.version,
    },
    srClusters: {
      count: Number(srClusterView?.clusterCount ?? 0),
      nextUp: Number.isFinite(Number(srClusterView?.nextUp?.centerPrice)) ? Number(srClusterView.nextUp.centerPrice) : null,
      nextDown: Number.isFinite(Number(srClusterView?.nextDown?.centerPrice)) ? Number(srClusterView.nextDown.centerPrice) : null,
      pathDepth: Number(srClusterView?.pathDepth ?? 0),
      mapStrength: Number.isFinite(Number(srClusterView?.mapStrength)) ? Number(srClusterView.mapStrength) : null,
      mapStatus: String(srClusterView?.mapStatus ?? 'unknown'),
      status: String(srClusterView?.status ?? 'UNKNOWN'),
      detection: srClusterView?.detection ?? null,
      filter: srClusterView?.filter ?? null,
      filteredLines: Array.isArray(srClusterView?.clusters)
        ? srClusterView.clusters
          .map((cluster) => ({
            type: String(cluster?.type ?? '').toLowerCase(),
            price: Number.isFinite(Number(cluster?.centerPrice)) ? Number(cluster.centerPrice) : null,
            distanceFromNow: Number.isFinite(Number(cluster?.distanceFromNow)) ? Number(cluster.distanceFromNow) : null,
            rank: Number.isFinite(Number(cluster?.rank)) ? Number(cluster.rank) : null
          }))
          .filter((line) => Number.isFinite(line.price))
        : [],
      rawClusterCount: Number.isFinite(Number(srClusterView?.rawClusterCount)) ? Number(srClusterView.rawClusterCount) : null,
      filteredClusterCount: Number.isFinite(Number(srClusterView?.filteredClusterCount)) ? Number(srClusterView.filteredClusterCount) : null,
      outOfChannelRejectedCount: Number.isFinite(Number(srClusterView?.outOfChannelRejectedCount)) ? Number(srClusterView.outOfChannelRejectedCount) : null
    },
    regimeAtSnapshot: structureSnapshot._legacy?.regime ?? null,
    currentRegime: regime,
    bRegime,
  };

  // ─────────────────────────────────────────────
  // Phase 2: 位置判定（端付近）
  // ─────────────────────────────────────────────
  const { upper, lower } = structureSnapshot.rails;
  const globalSpanUsd = Number.isFinite(upper) && Number.isFinite(lower) && upper > lower
    ? (upper - lower)
    : null;
  if (!Number.isFinite(globalSpanUsd) || globalSpanUsd <= 0) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'no_local_channel',
      source: 'B',
      phase1: phase1Log
    };
  }
  const arenaBounds = {
    enabled: false,
    hasArena: false,
    top: upper,
    bottom: lower,
    paddingUsd: 0
  };

  const channelSrLineMap = buildChannelSrLineMap(structureSnapshot, srClusterView, upper, lower);
  const srRef = resolveSrBracketFromLines(mid, channelSrLineMap, { upper, lower }, srClusterView);
  const supportRefPrice = srRef.supportRefPrice;
  const resistanceRefPrice = srRef.resistanceRefPrice;

  // 上側/下側SRまでの距離
  const distToUpper = resistanceRefPrice - mid;
  const distToLower = mid - supportRefPrice;
  const srRefSpanUsd = resistanceRefPrice - supportRefPrice;
  const spanUsd = globalSpanUsd;
  if (
    !Number.isFinite(distToUpper) ||
    !Number.isFinite(distToLower) ||
    !Number.isFinite(spanUsd) ||
    spanUsd <= 0
  ) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'no_local_channel',
      source: 'B',
      phase1: phase1Log,
      phase2: {
        spanGuard: {
          distToUpper,
          distToLower,
          spanUsd,
          srRefSpanUsd,
          supportRefPrice,
          resistanceRefPrice
        }
      }
    };
  }

  // 端付近の基準（Ver3 Part 7.3）
  // 1. 外縁側判定: distTo* が spanUsd の15%以内
  const edgeCfg = tradeConfig?.b2Upgrade?.edgeControl ?? {};
  const edgeBaseRatio = clamp(toNumber(edgeCfg.baseRatio, 0.15), 0.05, 0.30);
  const minEdgeThresholdUsd = Math.max(1, toNumber(edgeCfg.minThresholdUsd, 8));
  const maxEdgeThresholdUsd = Math.max(minEdgeThresholdUsd, toNumber(edgeCfg.maxThresholdUsd, 5000));
  const dynamicThresholdRaw = spanUsd * edgeBaseRatio;
  const EDGE_PROXIMITY_THRESHOLD = clamp(dynamicThresholdRaw, minEdgeThresholdUsd, maxEdgeThresholdUsd);
  const nearUpper = Number.isFinite(distToUpper) && distToUpper <= EDGE_PROXIMITY_THRESHOLD && distToUpper > 0;
  const nearLower = Number.isFinite(distToLower) && distToLower <= EDGE_PROXIMITY_THRESHOLD && distToLower > 0;

  // 2. 向かう先一意判定: 中央に近すぎないか（span の35-65% 帯を「中央」と定義）
  // ← #8修正: 比率（0-1）で比較する（USD値ではなく）
  const centerLower = 0.35;  // 35%
  const centerUpper = 0.65;  // 65%
  const channelT = Number.isFinite(spanUsd) && spanUsd > 0 ? ((mid - lower) / spanUsd) : Number.NaN;
  const positionRatio = channelT;
  const isAtCenter = Number.isFinite(positionRatio) && positionRatio >= centerLower && positionRatio <= centerUpper;

  // 3. 戻る以外の解釈なし判定: 端と反対側の理由づけが不可能か
  // （簡略: 端に近ければ戻る以外の解釈がない）
  const isNearEdge = nearUpper || nearLower;

  // 4. 往復の絵が即座に描けるか
  // （構造snapshot が存在し、rails が有効 = OK）
  const canVisualizeTradePath = true; // structureSnapshot の存在=可視化可能

  // P0方針: CENTER は明確にブロック。BOTTOM/TOP は判定継続。
  const atEdgeByZone = !isAtCenter;
  let atEdge = atEdgeByZone && canVisualizeTradePath;
  if (executionModelActive && !executionModel.useDistanceEntry) {
    atEdge = true;
  }

  // Phase 2 ログ
  const phase2Log = {
    position: {
      mid,
      distToUpper,
      distToLower,
      spanUsd,
      channelUpper: upper,
      channelLower: lower,
      channelCenter: Number.isFinite(upper) && Number.isFinite(lower)
        ? ((upper + lower) / 2)
        : null,
    },
    edgeProximity: {
      threshold: EDGE_PROXIMITY_THRESHOLD,
      nearUpper,
      nearLower,
      atEdge,
      atEdgeByDistance: isNearEdge && !isAtCenter,
      atEdgeByZone,
      distanceEntryDisabled: executionModelActive && !executionModel.useDistanceEntry,
    },
    centerLine: {
      isAtCenter,
      positionRatio,
    },
    srReference: {
      supportPrice: supportRefPrice,
      resistancePrice: resistanceRefPrice,
      source: srRef.source
    },
    srLineMap: {
      supportCount: srRef.srLines.supportCount,
      resistanceCount: srRef.srLines.resistanceCount,
      supports: srRef.srLines.supports,
      resistances: srRef.srLines.resistances
    },
    spanModel: {
      mode: 'global_rails',
      globalSpanUsd,
      srRefSpanUsd
    }
  };

  const srReferenceClusterGate = resolveSrReferenceClusterGate(
    srClusterView,
    mid,
    supportRefPrice,
    resistanceRefPrice,
    executionModel,
    null
  );
  phase2Log.srReferenceClusterGate = srReferenceClusterGate.diagnostics;

  // 端ではない → side=none
  if (!atEdge) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'B: mid position',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
    };
  }

  // ─────────────────────────────────────────────
  // Phase 3: 方向判定（SR近接ベース）
  // ─────────────────────────────────────────────
  // 方針:
  // - 方向は「現在地と上下SRの距離」で決める（B責務）
  // - A/B角度はゲートではなく強弱（size/tp補正）で使う
  let decidedSide = null;
  if (nearLower && nearUpper) {
    if (Number.isFinite(distToLower) && Number.isFinite(distToUpper) && distToLower !== distToUpper) {
      decidedSide = distToLower < distToUpper ? 'buy' : 'sell';
    }
  } else if (nearLower) {
    decidedSide = 'buy';
  } else if (nearUpper) {
    decidedSide = 'sell';
  }
  // P0方針: B2方向は rails 内の距離情報のみで決める（regime/c fallback禁止）
  if (!decidedSide && Number.isFinite(distToLower) && Number.isFinite(distToUpper) && distToLower !== distToUpper) {
    decidedSide = distToLower < distToUpper ? 'buy' : 'sell';
  }
  if (!decidedSide) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'B: mid position',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log
    };
  }
  phase2Log.directionDecision = {
    basis: 'sr_proximity',
    regime: decisionState,
    aRegime: regime,
    bRegime,
    bTrend,
    nearLower,
    nearUpper,
    distToLower,
    distToUpper,
    decidedSide
  };

  const containmentGate = evaluateBContainmentGate(ioMetrics, aResult, tradeConfig);
  phase2Log.containmentGate = containmentGate.diagnostics;
  const containmentBlocked = containmentGate.blocked === true;

  // side不成立（同距離など）→ side=none
  const srReferenceClusterGateFinal = resolveSrReferenceClusterGate(
    srClusterView,
    mid,
    supportRefPrice,
    resistanceRefPrice,
    executionModel,
    decidedSide
  );
  phase2Log.srReferenceClusterGate = srReferenceClusterGateFinal.diagnostics;
  const srReferenceClusterBlocked = srReferenceClusterGateFinal.blocked === true;

  const startupEntryGuard = resolveStartupEntryGuard(ioMetrics, tradeConfig);
  const spanFloorUnmet = Array.isArray(ioMetrics?.constraints) && ioMetrics.constraints.includes('bar1h_span_floor_unmet');
  const testModeRaw = String(process.env.TEST_MODE ?? '');
  const modeRaw = String(process.env.MODE ?? '').toLowerCase();
  const isTestRoute = testModeRaw === '1' || modeRaw === 'test';
  const isLiveRoute = testModeRaw === '0' || modeRaw === 'live';
  // If route env is ambiguous, default to live-safe behavior.
  const routeMode = isTestRoute ? 'test' : isLiveRoute ? 'live' : 'live_safe';
  if (routeMode === 'live_safe' && !routeModeWarned) {
    routeModeWarned = true;
    try {
      console.warn('[B2] TEST_MODE/MODE is ambiguous; routeMode=live_safe is applied.');
    } catch (_) {}
  }
  const aCode = String(aResult?._gateDiag?.code ?? '').toUpperCase();
  const aStable = aCode === 'A_NORMAL';
  const adaptiveSwitching = Array.isArray(ioMetrics?.constraints) && ioMetrics.constraints.includes('bar1h_adaptive_switching');

  // Effective guard:
  // LIVE: A安定まで no-order、adaptive切替中は weak-order
  // TEST: A安定前も adaptive切替中も weak-order
  const liveLikeRoute = routeMode !== 'test';
  const noOrderByStartupWindow = startupEntryGuard.noOrderActive;
  const noOrderByAStability =
    liveLikeRoute &&
    !aStable &&
    (startupEntryGuard.liveBlockUntilAStable || routeMode === 'live_safe');
  const restrictedByStartupWindow = startupEntryGuard.restrictedActive;
  const restrictedByAdaptiveSwitch = adaptiveSwitching;
  const restrictedByTestAStability = routeMode === 'test' && !aStable;
  const effectiveStartupGuard = {
    ...startupEntryGuard,
    routeMode,
    startupWindowActive: startupEntryGuard.active,
    noOrderByStartupWindow,
    noOrderByAStability,
    restrictedByStartupWindow,
    restrictedByAdaptiveSwitch,
    restrictedByTestAStability,
    noOrderActive: liveLikeRoute && (noOrderByStartupWindow || noOrderByAStability),
    restrictedActive: restrictedByStartupWindow || restrictedByAdaptiveSwitch || restrictedByTestAStability
  };
  if (effectiveStartupGuard.noOrderActive) {
    effectiveStartupGuard.phase = 'no_order';
  }
  // 仕様簡素化: startup/span-floor 由来の追加ブロックは無効化（診断情報のみ保持）
  if (effectiveStartupGuard.restrictedActive) {
    effectiveStartupGuard.phase = 'restricted';
    effectiveStartupGuard.sizeScalar = 1.0;
    effectiveStartupGuard.minMapStrengthAdd = 0;
    effectiveStartupGuard.minPathDepthAdd = 0;
  }

  const entryFlowGate = resolveEntryFlowGate(ioMetrics, tradeConfig, decidedSide);
  const ctxMicroGate = evaluateCtxMicroGate(payload?.market ?? {}, tradeConfig, decidedSide);
  const oiPriceTrapGate = evaluateOiTrapGate(payload, tradeConfig, decidedSide);

  const wsGateBlockReason = entryFlowGate.blocked
    ? (entryFlowGate.reason || 'B: flow gate blocked')
    : (ctxMicroGate.blocked
      ? (ctxMicroGate.reason || 'B: ctx gate blocked')
      : (oiPriceTrapGate.blocked
        ? (oiPriceTrapGate.reason || 'B: oi-price trap gate blocked')
        : null));

  if (executionModelActive && false) {
    const mapStrength = toNumber(srClusterView?.mapStrength);
    const minMapStrength = clamp(
      Math.max(
        toNumber(executionModel.minMapStrength, 0.15),
        toNumber(capitalStage?.mapMinStrength, 0)
      ) + (effectiveStartupGuard.restrictedActive ? effectiveStartupGuard.minMapStrengthAdd : 0),
      0,
      1
    );
    if (Number.isFinite(mapStrength) && mapStrength < minMapStrength) {
      return {
        state: decisionState,
        side: 'none',
        reason: 'B: weak structural map',
        source: 'B',
        phase1: phase1Log,
        phase2: phase2Log,
        phase4: {
          decidedSide,
          mapStrength,
          minMapStrength,
          startupGuard: effectiveStartupGuard
        }
      };
    }
  }

  if (executionModelActive && executionModel.requireStructuralPath && false) {
    const hasClusterPath = decidedSide === 'buy'
      ? Number.isFinite(Number(srClusterView?.nextUp?.centerPrice)) && Number(srClusterView.nextUp.centerPrice) > mid
      : Number.isFinite(Number(srClusterView?.nextDown?.centerPrice)) && Number(srClusterView.nextDown.centerPrice) < mid;
    const currentPathDepth = Math.max(0, Math.floor(toNumber(srClusterView?.pathDepth, 0)));
    const minPathDepth = effectiveStartupGuard.restrictedActive
      ? Math.max(1, 1 + effectiveStartupGuard.minPathDepthAdd)
      : 1;
    const hasPath = hasClusterPath && currentPathDepth >= minPathDepth;
    if (!hasPath) {
      return {
        state: decisionState,
        side: 'none',
        reason: 'B: no structural path',
        source: 'B',
        phase1: phase1Log,
        phase2: phase2Log,
        phase4: {
          decidedSide,
          startupGuard: effectiveStartupGuard,
          currentPathDepth,
          minPathDepth
        }
      };
    }
  }

  // ─────────────────────────────────────────────
  // Phase 4: TP 確認
  // ─────────────────────────────────────────────
  // TP 目標を決定（思想準拠: SR間優先、無ければ no_near_sr）
  const tpBandDiagnostics = {};
  const tpPlan = resolveTpPlan(
    decidedSide,
    mid,
    structureSnapshot,
    arenaBounds,
    ioMetrics,
    tradeConfig,
    srClusterView,
    {
      supportRefPrice,
      resistanceRefPrice,
      srRef
    },
    tpBandDiagnostics
  );
  if (!tpPlan) {
    if (wsGateBlockReason) {
      return {
        state: decisionState,
        side: 'none',
        reason: wsGateBlockReason,
        source: 'B',
        phase1: phase1Log,
        phase2: phase2Log,
        phase4: {
          decidedSide,
          startupGuard: effectiveStartupGuard,
          flowGate: entryFlowGate.diagnostics,
          ctxGate: ctxMicroGate.diagnostics,
          oiTrapGate: oiPriceTrapGate.diagnostics
        }
      };
    }
    return {
      state: decisionState,
      side: 'none',
      reason: 'no_near_sr',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        decidedSide,
        tpBandDiagnostics
      }
    };
  }
  let targetPrice = Number(tpPlan?.targetPrice);
  const tpSource = String(tpPlan?.tpSource ?? 'unknown').toLowerCase();
  const entryPolicy = tradeConfig?.entryPolicy ?? {};
  const enforceStructuralTpSource = entryPolicy?.enforceStructuralTpSource === true;
  const enforceMinStructuralTpDistance = entryPolicy?.enforceMinStructuralTpDistance === true;

  // TP距離確認（基準距離）
  let tpDistance = Math.abs(targetPrice - mid);
  if (!Number.isFinite(targetPrice) || !Number.isFinite(tpDistance) || tpDistance <= 0) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'no_near_sr',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        decidedSide,
        tpBandDiagnostics
      }
    };
  }

  if (wsGateBlockReason) {
    return {
      state: decisionState,
      side: 'none',
      reason: wsGateBlockReason,
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        decidedSide,
        startupGuard: effectiveStartupGuard,
        flowGate: entryFlowGate.diagnostics,
        ctxGate: ctxMicroGate.diagnostics,
        oiTrapGate: oiPriceTrapGate.diagnostics
      }
    };
  }
  // Root policy: only structural TP sources are tradable.
  if (
    enforceStructuralTpSource &&
    tpSource !== 'sr_next'
  ) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'B: no structural tp',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        decidedSide,
        rejectedTpSource: tpSource,
        targetPrice,
        tpDistance,
        tpPlanMeta: tpPlan?.meta ?? null
      }
    };
  }
  const minStructuralTpDistanceUsd = resolveMinStructuralTpDistanceUsd(tradeConfig, arenaBounds);
  const shouldEnforceDistanceGuard = executionModelActive && executionModel.distanceGuardMode === 'enforce';
  const shouldShadowDistanceGuard = executionModelActive && executionModel.distanceGuardMode === 'shadow';
  let phase4Log = {
    decidedSide,
    flowGate: entryFlowGate.diagnostics ?? null,
    ctxGate: ctxMicroGate.diagnostics ?? null,
    oiTrapGate: oiPriceTrapGate.diagnostics ?? null,
    tpBandDiagnostics,
    structuralSoftGuards: {
      containmentBlocked,
      srReferenceClusterBlocked,
      containment: containmentGate.diagnostics ?? null,
      srReferenceClusterGate: srReferenceClusterGateFinal.diagnostics ?? null
    }
  };

  if (
    enforceMinStructuralTpDistance &&
    shouldEnforceDistanceGuard &&
    Number.isFinite(minStructuralTpDistanceUsd) &&
    minStructuralTpDistanceUsd > 0 &&
    tpDistance < minStructuralTpDistanceUsd
  ) {
    return {
      state: decisionState,
      side: 'none',
      reason: 'edge_negative',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        decidedSide,
        tpSource,
        targetPrice,
        tpDistance,
        minStructuralTpDistanceUsd
      }
    };
  }
  if (
    enforceMinStructuralTpDistance &&
    shouldShadowDistanceGuard &&
    Number.isFinite(minStructuralTpDistanceUsd) &&
    minStructuralTpDistanceUsd > 0 &&
    tpDistance < minStructuralTpDistanceUsd
  ) {
    phase4Log = {
      ...phase4Log,
      shadowDistanceGuard: {
        triggered: true,
        tpDistance,
        minStructuralTpDistanceUsd
      }
    };
  }

  const dynamicTpCap = resolveDynamicTpCapUsd(ioMetrics, payload?.market ?? {}, tradeConfig);
  let tpCapDiag = dynamicTpCap.diagnostics ?? null;
  const capFloorUsd = (
    enforceMinStructuralTpDistance &&
    shouldEnforceDistanceGuard &&
    Number.isFinite(minStructuralTpDistanceUsd) &&
    minStructuralTpDistanceUsd > 0
  )
    ? minStructuralTpDistanceUsd
    : 0;
  if (Number.isFinite(dynamicTpCap.capUsd) && dynamicTpCap.capUsd > 0) {
    const effectiveCapUsd = capFloorUsd > 0
      ? Math.max(dynamicTpCap.capUsd, capFloorUsd)
      : dynamicTpCap.capUsd;
    if (tpDistance > effectiveCapUsd) {
      targetPrice = decidedSide === 'buy'
        ? (mid + effectiveCapUsd)
        : (mid - effectiveCapUsd);
      tpDistance = Math.abs(targetPrice - mid);
      tpCapDiag = {
        ...(dynamicTpCap.diagnostics ?? {}),
        applied: true,
        capFloorUsd,
        effectiveCapUsd
      };
    } else {
      tpCapDiag = {
        ...(dynamicTpCap.diagnostics ?? {}),
        applied: false,
        capFloorUsd,
        effectiveCapUsd
      };
    }
  }

  // TPストレッチ（勝ち幅だけ伸ばす。損失側の判定距離は維持）
  const tpStretchRaw = Number(tradeConfig?.b2?.tpStretch ?? 1.0);
  let tpStretch = Number.isFinite(tpStretchRaw) ? Math.max(1.0, Math.min(2.0, tpStretchRaw)) : 1.0;
  const regimeUpper = String(decisionState || '').toUpperCase();
  const disableRangeTpStretch = tradeConfig?.b2?.rangeTpStretchDisabled === true;
  if (tpSource === 'sr_next_retry') {
    // Retry経路は近接TPの救済用途。過伸長で誤って通すことを防ぐ。
    tpStretch = 1.0;
  }
  if (disableRangeTpStretch && regimeUpper === 'RANGE') {
    // RANGE局面ではTPを遠ざけすぎない（設計思想を維持しつつ stretch を無効化）
    tpStretch = 1.0;
  }
  const tpStretchHoldMsRaw = Number(tradeConfig?.b2?.tpStretchHoldMs ?? 0);
  let tpStretchHoldMs = Number.isFinite(tpStretchHoldMsRaw) ? Math.max(0, tpStretchHoldMsRaw) : 0;
  let tpDistanceStretched = tpDistance * tpStretch;
  let targetPriceStretchedRaw = decidedSide === 'buy'
    ? mid + tpDistanceStretched
    : mid - tpDistanceStretched;
  let targetPriceStretched = resolveStretchedTarget(decidedSide, mid, targetPriceStretchedRaw, tpPlan);
  tpDistanceStretched = Math.abs(targetPriceStretched - mid);

  phase4Log = {
    ...phase4Log,
    decidedSide,
    targetPrice,
    tpDistance,
    tpSource,
    tpPhase: String(tpPlan?.tpPhase ?? 'REACTION'),
    stepUsd: toNumber(tpPlan?.meta?.stepUsd, null),
    retryStepUsd: toNumber(tpPlan?.meta?.retryStepUsd, null),
    srCandidateCount: Number.isFinite(Number(tpPlan?.meta?.srCandidateCount)) ? Number(tpPlan.meta.srCandidateCount) : null,
    retryUsed: tpPlan?.meta?.retryUsed === true,
    tpStretch,
    tpStretchHoldMs,
    targetPriceStretched,
    tpDistanceStretched,
    dynamicTpCap: tpCapDiag,
  };

  // ─────────────────────────────────────────────
  // ─────────────────────────
  // firepower 決定（A.trend_strength に基づく）
  // ─────────────────────────
  // 設計思想: baseFirepower は trend_strength の確信度を表す
  // weak:   傾きはあるが上位足と未一致 → 0.75
  // normal: 傾きあり・構造成立 → 1.0
  // strong: 上位足+SR+傾き一致 → 1.3
  // 
  // directionalFirepower は別途（計算順: baseFirepower → directional補正 → 最終）
  const trend_strength = aResult?.trend_strength ?? 'normal';
  // ← Ver3修正: ハードコード baseFirepowerMap を削除、config から動的に取得
  const firepower = Number(tradeConfig?.firepower?.[trend_strength] ?? 1.0);
  // 方向はBが決定。Aは強さ補正のみ:
  // - A/B同方向時のブースト（>=1.0）
  // - A中心帯（|c|小）だけ弱め（<=1.0）
  const cForAStrength = Number.isFinite(toNumber(payload?.c))
    ? payload?.c
    : ioMetrics?.c;
  const abAlignmentBoost = resolveAbAlignmentBoost(regime, bRegime, decidedSide, tradeConfig);
  const aCenterStrengthMul = resolveACenterStrengthMul(cForAStrength, tradeConfig);
  const angleDirectionBoost = resolveDirectionalAngleBoost(decidedSide, bTrend, aResult, payload, tradeConfig);
  const clusterWallBoost = resolveClusterWallPowerBoost(decidedSide, payload, srClusterView, tradeConfig);
  const directionalFirepower = abAlignmentBoost * aCenterStrengthMul * angleDirectionBoost.multiplier * clusterWallBoost.multiplier;
  const executionSignals = computeExecutionSignals(payload, spanUsd, distToUpper, distToLower, EDGE_PROXIMITY_THRESHOLD, tradeConfig);
  if (executionModelActive && executionSignals.entryQualityScore < executionModel.minEntryQuality) {
    const entryQualityScore = Number(executionSignals.entryQualityScore);
    const minEntryQuality = Number(executionModel.minEntryQuality);
    const effectiveEntryQualityScore = Number.isFinite(toNumber(executionSignals.effectiveEntryQualityScore))
      ? Number(executionSignals.effectiveEntryQualityScore)
      : (Number.isFinite(entryQualityScore) ? entryQualityScore : null);
    const channelT = Number.isFinite(toNumber(executionSignals.channelT))
      ? Number(executionSignals.channelT)
      : null;
    const rawEntryQualityScore = Number.isFinite(toNumber(executionSignals.rawEntryQualityScore))
      ? Number(executionSignals.rawEntryQualityScore)
      : null;
    const entryWeight = Number.isFinite(toNumber(executionSignals.entryWeight))
      ? Number(executionSignals.entryWeight)
      : null;
    const scoreDelta = (Number.isFinite(entryQualityScore) && Number.isFinite(minEntryQuality))
      ? (entryQualityScore - minEntryQuality)
      : null;
    return {
      state: decisionState,
      side: 'none',
      reason: 'execution_invalid',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        ...phase4Log,
        executionModel,
        entryQualityScore,
        executionQuality: {
          rawEntryQualityScore,
          entryWeight,
          channelT,
          entryQualityScore,
          minEntryQuality,
          effectiveEntryQualityScore,
          scoreDelta
        }
      }
    };
  }
  const orbit = {
    score: 0,
    edgeRatioMul: 1,
    sizeScalarMul: 1,
    tpStretchMul: 1,
    forceMaker: false,
    diagnostics: { enabled: false, reason: 'disabled_by_spec' }
  };
  const higherTf = {
    block: false,
    sizeMul: 1,
    tpMul: 1,
    diagnostics: { enabled: false, reason: 'disabled_by_spec' }
  };
  const higherTfConflictIgnored = false;
  const tpStretchBase = tpStretch;
  const tpStretchOrbitMul = 1.0;
  const tpStretchHigherTfMul = 1.0;
  tpStretch = (disableRangeTpStretch && regimeUpper === 'RANGE')
    ? 1.0
    : clamp(tpStretchBase, 1.0, 2.2);
  tpDistanceStretched = tpDistance * tpStretch;
  targetPriceStretchedRaw = decidedSide === 'buy' ? (mid + tpDistanceStretched) : (mid - tpDistanceStretched);
  targetPriceStretched = resolveStretchedTarget(decidedSide, mid, targetPriceStretchedRaw, tpPlan);
  tpDistanceStretched = Math.abs(targetPriceStretched - mid);
  phase4Log = {
    ...phase4Log,
    aRegime: regime,
    bRegime,
    decisionState,
    cForAStrength: toNumber(cForAStrength, null),
    abAlignmentBoost,
    aCenterStrengthMul,
    angleDirectionBoost: angleDirectionBoost.multiplier,
    angleDirectionBoostDiag: {
      sideDir: angleDirectionBoost.sideDir,
      bDir: angleDirectionBoost.bDir,
      aDir: angleDirectionBoost.aDir,
      bAligned: angleDirectionBoost.bAligned,
      aAlignedWithB: angleDirectionBoost.aAlignedWithB,
      angle15mNormSlope: toNumber(angleDirectionBoost.angle15mNormSlope, null),
      angle15mMagnitudeBoost: toNumber(angleDirectionBoost.angle15mMagnitudeBoost, null),
      reason: angleDirectionBoost.reason
    },
    clusterWallBoost: clusterWallBoost.multiplier,
    clusterWallBoostDiag: {
      reason: clusterWallBoost.reason,
      totalScore: toNumber(clusterWallBoost.totalScore, null),
      clusterScore: toNumber(clusterWallBoost.clusterScore, null),
      wallScore: toNumber(clusterWallBoost.wallScore, null),
      clusterCount: Number.isFinite(Number(clusterWallBoost.clusterCount)) ? Number(clusterWallBoost.clusterCount) : null,
      mapStrength: toNumber(clusterWallBoost.mapStrength, null),
      pathDepth: Number.isFinite(Number(clusterWallBoost.pathDepth)) ? Number(clusterWallBoost.pathDepth) : null,
      wallNotionalUsd: toNumber(clusterWallBoost.wallNotionalUsd, null),
      wallDistanceUsd: toNumber(clusterWallBoost.wallDistanceUsd, null),
      wallNear: clusterWallBoost.wallNear === true,
      nearWindowUsd: toNumber(clusterWallBoost.nearWindowUsd, null),
      minWallUsd: toNumber(clusterWallBoost.minWallUsd, null),
      wallSaturationUsd: toNumber(clusterWallBoost.wallSaturationUsd, null),
      maxBoost: toNumber(clusterWallBoost.maxBoost, null)
    },
    directionalFirepowerCombined: directionalFirepower,
    tpStretchBase,
    tpStretchOrbitMul,
    tpStretchHigherTfMul,
    tpStretch,
    targetPriceStretched,
    tpDistanceStretched,
    higherTf,
    higherTfConflictIgnored
  };
  const qualitySizeScalar = resolveSizeScalar(executionSignals.entryQualityScore, tradeConfig);
  const structureQualityControl = resolveStructureQualityScalar(structureSnapshot, tradeConfig);
  const structureQualityScalar = clamp(structureQualityControl.scalar ?? 1, 1.0, 2.0);
  const startupSizeScalar = resolveStartupSizeScalar(ioMetrics, tradeConfig);
  const orbitSizeScalar = 1.0;
  const higherTfSizeScalar = 1.0;
  const ladderAttack = { scalar: 1.0, reason: 'disabled_by_spec' };
  const ladderAttackScalar = 1.0;
  const startupGuardSizeScalar = 1.0;
  const flowSize = resolveFlowSizeScalar(ioMetrics, decidedSide, tradeConfig);
  const impactSize = resolveImpactSizeScalar(payload?.market ?? {}, tradeConfig);
  const accelSize = resolveAccelSizeScalar(ioMetrics, decidedSide, tradeConfig);
  const ctxSize = resolveCtxSizeScalar(payload?.market ?? {}, decidedSide, tradeConfig);
  const flowSizeScalar = clamp(flowSize.scalar ?? 1, 1.0, 2.0);
  const impactSizeScalar = clamp(impactSize.scalar ?? 1, 1.0, 2.0);
  const accelSizeScalar = clamp(accelSize.scalar ?? 1, 1.0, 2.0);
  const ctxSizeScalar = clamp(ctxSize.scalar ?? 1, 1.0, 2.0);
  const wsSizeScalar = flowSizeScalar * impactSizeScalar * accelSizeScalar * ctxSizeScalar;
  const sizeScalar = qualitySizeScalar
    * structureQualityScalar
    * startupSizeScalar
    * startupGuardSizeScalar
    * orbitSizeScalar
    * higherTfSizeScalar
    * ladderAttackScalar
    * wsSizeScalar;
  phase4Log = {
    ...phase4Log,
    wsSize: {
      flowScalar: flowSizeScalar,
      impactScalar: impactSizeScalar,
      accelScalar: accelSizeScalar,
      ctxScalar: ctxSizeScalar,
      combined: wsSizeScalar,
      flowDiagnostics: flowSize.diagnostics ?? null,
      impactDiagnostics: impactSize.diagnostics ?? null,
      accelDiagnostics: accelSize.diagnostics ?? null,
      ctxDiagnostics: ctxSize.diagnostics ?? null
    }
  };
  const feeEdgeGuard = tradeConfig?.feeEdgeGuard ?? {};
  const expectancyRealizationFactor = clamp(toNumber(feeEdgeGuard.expectancyRealizationFactor, 1.0), 0.1, 1.0);
  
  // Phase 5: サイズ算出（resolveSizeB + firepower 乗算）
  // ─────────────────────────────────────────────
  // ← Ver3修正: firepower をサイズ計算に渡す
  // size = (riskBudget / tpDistance) × firepower
  // ← 2026-02-02修正: USD→Coin変換を実装（mid を渡す）
  const {
    sizeCoin: sizeCoinInitial,
    notionalUsd: notionalUsdInitial,
    rawNotionalUsd,
    minNotionalUsd,
    maxNotionalUsd,
    skipReason
  } = resolveNotionalSize(
    payload,
    aResult,
    decidedSide,
    tpDistance,
    tradeConfig,
    firepower,  // ← 追加: firepower を渡す
    directionalFirepower,  // ← 追加: directionalFirepower を渡す
    mid,  // ← 追加: mid を渡す（USD→Coin変換用）
    sizeScalar
  );

  if (skipReason) {
    return {
      state: decisionState,
      side: 'none',
      size: 0,
      notionalUsd: 0,
      firepower: firepower,
      sizeFactors: {
        firepower: firepower,
        directional: directionalFirepower,
        edgeScore: executionSignals.entryQualityScore,
        adaptiveSizeScalar: qualitySizeScalar,
        structureQualityScalar,
        structureQuality: structureQualityControl.quality,
        structureSource: structureQualityControl.source,
        startupSizeScalar,
        startupGuardSizeScalar,
        flowSizeScalar,
        impactSizeScalar,
        accelSizeScalar,
        ctxSizeScalar,
        wsSizeScalar,
        ladderAttackScalar,
        expectancyRealizationFactor,
        startupMode: ioMetrics?.startupProfile?.mode ?? null,
        startupGuardActive: effectiveStartupGuard.restrictedActive,
        combined: firepower * directionalFirepower * sizeScalar
      },
      reason: skipReason,
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: phase4Log,
    };
  }

  // Fee-aware net edge guard is now controlled by config.
  const feeEdgeEnabled = feeEdgeGuard.enabled !== false;
  const entryMode = orbit.forceMaker ? 'maker' : executionSignals.executionMode;
  const exitMode = String(feeEdgeGuard.exitMode ?? 'taker').toLowerCase() === 'maker' ? 'maker' : 'taker';
  const makerBps = Math.max(0, toNumber(tradeConfig?.fees?.makerBps, 1.44));
  const takerBps = Math.max(0, toNumber(tradeConfig?.fees?.takerBps, 4.32));
  const entryBps = entryMode === 'maker' ? makerBps : takerBps;
  const exitBps = exitMode === 'maker' ? makerBps : takerBps;
  const feeRate = (entryBps + exitBps) / 10000;
  const edgePerUsdNotional = Math.max(0, ((tpDistance / mid) * expectancyRealizationFactor) - feeRate);
  const edgePer100Notional = edgePerUsdNotional * 100;
  let sizeCoin = sizeCoinInitial;
  let notionalUsd = notionalUsdInitial;
  let feeEdgeBoostMul = 1.0;
  let feeEdgeBoosted = false;
  let estimatedGrossUsd = Math.max(0, tpDistance * sizeCoin * expectancyRealizationFactor);
  let estimatedFeeUsd = Math.max(0, notionalUsd * feeRate);
  let estimatedNetUsd = estimatedGrossUsd - estimatedFeeUsd;
  let estimatedNetPer100 = notionalUsd > 0 ? (estimatedNetUsd / notionalUsd) * 100 : 0;
  const feeThresholds = resolveFeeEdgeThresholds(payload, executionSignals, feeEdgeGuard);
  const minNetUsd = feeThresholds.minNetUsd;
  const minNetPer100 = feeThresholds.minNetPer100;
  const strictMinNetFloor = feeEdgeGuard.strictMinNetFloor !== false;

  // feeEdgeGuard 有効時は、最終ロットが stage/lot の floor を割らないようにする。
  if (
    feeEdgeEnabled &&
    Number.isFinite(minNotionalUsd) &&
    minNotionalUsd > 0 &&
    Number.isFinite(notionalUsd) &&
    Number.isFinite(mid) &&
    mid > 0 &&
    notionalUsd < minNotionalUsd
  ) {
    const flooredNotional = Number.isFinite(maxNotionalUsd)
      ? Math.min(Math.max(minNotionalUsd, notionalUsd), maxNotionalUsd)
      : Math.max(minNotionalUsd, notionalUsd);
    if (Number.isFinite(flooredNotional) && flooredNotional > notionalUsd) {
      notionalUsd = flooredNotional;
      sizeCoin = notionalUsd / mid;
      estimatedGrossUsd = Math.max(0, tpDistance * sizeCoin * expectancyRealizationFactor);
      estimatedFeeUsd = Math.max(0, notionalUsd * feeRate);
      estimatedNetUsd = estimatedGrossUsd - estimatedFeeUsd;
      estimatedNetPer100 = notionalUsd > 0 ? (estimatedNetUsd / notionalUsd) * 100 : 0;
    }
  }

  // 単価改善: feeEdgeGuard が有効なら、先にサイズ増で純益ライン到達を試す。
  const autoSizeBoost = feeEdgeGuard.autoSizeBoost !== false;
  const allowRetryAutoBoost = feeEdgeGuard.allowRetryAutoBoost === true;
  const maxSizeBoostMul = clamp(toNumber(feeEdgeGuard.maxSizeBoostMul, 2.5), 1.0, 6.0);
  let requiredNotionalForMinNet = null;
  if (
    feeEdgeEnabled &&
    autoSizeBoost &&
    (tpSource !== 'sr_next_retry' || allowRetryAutoBoost) &&
    (estimatedNetUsd < minNetUsd || estimatedNetPer100 < minNetPer100) &&
    Number.isFinite(notionalUsd) &&
    notionalUsd > 0 &&
    Number.isFinite(edgePerUsdNotional) &&
    edgePerUsdNotional > 0 &&
    Number.isFinite(maxNotionalUsd) &&
    maxNotionalUsd > notionalUsd
  ) {
    const requiredForMinNetUsd = minNetUsd > 0 ? (minNetUsd / edgePerUsdNotional) : notionalUsd;
    const requiredNotional = Math.max(notionalUsd, requiredForMinNetUsd);
    requiredNotionalForMinNet = requiredNotional;
    const cappedByMul = notionalUsd * maxSizeBoostMul;
    const boostedNotional = strictMinNetFloor
      ? Math.min(maxNotionalUsd, requiredNotional)
      : Math.min(maxNotionalUsd, cappedByMul, requiredNotional);
    const boostedSize = boostedNotional > 0 ? (boostedNotional / mid) : 0;
    const boostedGross = Math.max(0, tpDistance * boostedSize * expectancyRealizationFactor);
    const boostedFee = Math.max(0, boostedNotional * feeRate);
    const boostedNet = boostedGross - boostedFee;
    const boostedNetPer100 = boostedNotional > 0 ? (boostedNet / boostedNotional) * 100 : 0;

    if (boostedNotional > notionalUsd && Number.isFinite(boostedSize) && boostedSize > 0) {
      sizeCoin = boostedSize;
      notionalUsd = boostedNotional;
      estimatedGrossUsd = boostedGross;
      estimatedFeeUsd = boostedFee;
      estimatedNetUsd = boostedNet;
      estimatedNetPer100 = boostedNetPer100;
      const boostBaseNotional = Math.max(1e-6, Number.isFinite(notionalUsdInitial) ? notionalUsdInitial : 0);
      const boostMulCap = strictMinNetFloor ? 12.0 : maxSizeBoostMul;
      feeEdgeBoostMul = clamp(boostedNotional / boostBaseNotional, 1.0, boostMulCap);
      feeEdgeBoosted = true;
    }
  }

  if (feeEdgeEnabled && (estimatedNetUsd < minNetUsd || estimatedNetPer100 < minNetPer100)) {
    return {
      state: decisionState,
      side: 'none',
      size: 0,
      notionalUsd: 0,
      firepower: firepower,
      sizeFactors: {
        firepower: firepower,
        directional: directionalFirepower,
        edgeScore: executionSignals.entryQualityScore,
        adaptiveSizeScalar: qualitySizeScalar,
        structureQualityScalar,
        structureQuality: structureQualityControl.quality,
        structureSource: structureQualityControl.source,
        startupSizeScalar,
        startupGuardSizeScalar,
        flowSizeScalar,
        impactSizeScalar,
        accelSizeScalar,
        ctxSizeScalar,
        wsSizeScalar,
        ladderAttackScalar,
        startupMode: ioMetrics?.startupProfile?.mode ?? null,
        startupGuardActive: effectiveStartupGuard.restrictedActive,
        combined: firepower * directionalFirepower * sizeScalar
      },
      reason: 'edge_negative',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        ...phase4Log,
        tpSource: tpPlan?.tpSource ?? 'unknown',
        tpLadder: tpPlan?.ladder ?? null,
        feeEdgeGuard: {
          enabled: true,
          estimatedGrossUsd,
          estimatedFeeUsd,
          estimatedNetUsd,
          estimatedNetPer100,
          minNetUsd,
          minNetPer100,
          expectancyRealizationFactor,
          dynamic: {
            session: feeThresholds.session,
            sessionMul: feeThresholds.sessionMul,
            stressMul: feeThresholds.stressMul
          },
          strictMinNetFloor,
          requiredNotionalForMinNet,
          entryMode,
          exitMode,
          edgePer100Notional,
          rawNotionalUsd,
          minNotionalUsd,
          maxNotionalUsd
        }
      }
    };
  }

  const thinOrderBookGate = resolveThinOrderBookGate(ioMetrics, mid, decidedSide, tradeConfig);
  if (thinOrderBookGate.blocked) {
    return {
      state: decisionState,
      side: 'none',
      size: 0,
      notionalUsd: 0,
      firepower: firepower,
      reason: 'B: thin order book',
      source: 'B',
      phase1: phase1Log,
      phase2: phase2Log,
      phase4: {
        ...phase4Log,
        depthGuard: thinOrderBookGate.diagnostics
      }
    };
  }
  
  // ─────────────────────────
  // Phase 6: エントリー許可
  // ─────────────────────────
  const supportPrice = Number.isFinite(supportRefPrice) ? supportRefPrice : Number(structureSnapshot?.rails?.lower);
  const resistancePrice = Number.isFinite(resistanceRefPrice) ? resistanceRefPrice : Number(structureSnapshot?.rails?.upper);
  const distToSupport = Number.isFinite(supportPrice) ? Math.max(0, mid - supportPrice) : null;
  const distToResistance = Number.isFinite(resistancePrice) ? Math.max(0, resistancePrice - mid) : null;
  const supportUpper = toNumber(payload?.ioMetrics?.depthSR?.supportUpper);
  const resistanceLower = toNumber(payload?.ioMetrics?.depthSR?.resistanceLower);
  const structuralDistanceUsd = Number.isFinite(supportUpper) && Number.isFinite(resistanceLower)
    ? Math.max(0, resistanceLower - supportUpper)
    : null;
  const structuralPairType = Number.isFinite(structuralDistanceUsd) ? 'depth_band_gap' : null;
  const distanceReason = Number.isFinite(structuralDistanceUsd) ? 'depth_sr_gap' : 'unavailable';

  const entryDecision = {
    state: decisionState,
    side: decidedSide,
    size: sizeCoin,  // ← 2026-02-02修正: コイン数量（firepower が乗算済み）
    notionalUsd: notionalUsd,  // ← 2026-02-02追加: USD ノーショナル（監視用）
    firepower: firepower,  // ← 参考情報として記録
    sizeFactors: {
      firepower: firepower,
      directional: directionalFirepower,
      edgeScore: executionSignals.entryQualityScore,
      adaptiveSizeScalar: qualitySizeScalar,
      structureQualityScalar,
      structureQuality: structureQualityControl.quality,
      structureSource: structureQualityControl.source,
      startupSizeScalar,
      startupGuardSizeScalar,
      orbitSizeScalar,
      higherTfSizeScalar,
      flowSizeScalar,
      impactSizeScalar,
      accelSizeScalar,
      ctxSizeScalar,
      wsSizeScalar,
      ladderAttackScalar,
      feeEdgeBoostMul,
      expectancyRealizationFactor,
      startupMode: ioMetrics?.startupProfile?.mode ?? null,
      startupGuardActive: effectiveStartupGuard.restrictedActive,
      combined: firepower * directionalFirepower * sizeScalar
    },
    reason: `B: entry allowed (${decidedSide} at edge, target=${targetPrice.toFixed(2)}, firepower=${firepower.toFixed(2)})`,
    source: 'B',
    entryProfile: {
      mode: entryMode,
      aggressiveness: executionSignals.aggressiveness,
      entryQualityScore: executionSignals.entryQualityScore,
      spreadBps: executionSignals.spreadBps,
      velocityBps: executionSignals.velocityBps,
      feeEdgeBoosted,
      higherTf
    },
    tpPx: targetPrice,
    tpDistanceUsd: tpDistance,
    tpPxRail: targetPrice,
    tpPxStretch: targetPriceStretched,
    tpStretchRatio: tpStretch,
    tpStretchHoldMs: tpStretchHoldMs,
    structuralDistanceUsd,
    structuralPairType,
    distanceReason,
    expectedUsd: Number.isFinite(estimatedNetUsd) ? estimatedNetUsd : null,
    // P1修正: 観測用フィールド追加
    midPrice: mid,
    supportPrice,
    resistancePrice,
    distToSupport,
    distToResistance,
    bandLower: supportPrice,
    bandUpper: resistancePrice,
    phase1: phase1Log,
    phase2: phase2Log,
    phase4: phase4Log,
    tpSource: tpPlan?.tpSource ?? 'unknown',
    tpPhase: tpPlan?.tpPhase ?? 'REACTION',
    tpLadder: tpPlan?.ladder ?? null,
    ladderAttack,
    orbit: {
      score: orbit.score,
      edgeRatioMul: orbit.edgeRatioMul,
      sizeScalarMul: orbit.sizeScalarMul,
      tpStretchMul: orbit.tpStretchMul,
      forceMaker: orbit.forceMaker,
      diagnostics: orbit.diagnostics
    },
    depthGuard: thinOrderBookGate.diagnostics,
    // Ver2 互換フィールド（診断用）
    _legacy: {
      structureSnapshot: {
        hash: structureSnapshot.hash,
        basis: structureSnapshot.basis,
      },
    },
  };

  return entryDecision;
}

/**
 * directionalFirepower を算出
 * @param {Object} tradeConfig - trade config
 * @param {string} regime - 'UP' | 'DOWN' | 'RANGE'
 * @param {string} side - 'buy' | 'sell'
 * @returns {number} directionalFirepower
 */
function resolveDirectionalFirepower(tradeConfig, regime, side) {
  const cfg = tradeConfig?.directionalFirepower ?? {};
  if (!cfg.enabled) {
    return 1.0;
  }
  const trendKeyRaw = typeof regime === 'string' ? regime.toLowerCase() : 'range';
  const trendKey = (trendKeyRaw === 'up' || trendKeyRaw === 'down') ? trendKeyRaw : 'range';
  const sideKeyRaw = typeof side === 'string' ? side.toLowerCase() : 'buy';
  const sideKey = sideKeyRaw === 'sell' ? 'short' : 'long';
  const factor = cfg?.[trendKey]?.[sideKey];
  return Number(factor ?? 1.0);
}

/**
 * ノーショナルサイズを算出（2026-02-02修正: USD→Coin変換を実装）
 * 
 * @param {Object} payload - IO packet
 * @param {Object} aResult - A判定結果
 * @param {string} side - buy/sell
 * @param {number} tpDistance - TP まで の距離
 * @param {Object} tradeConfig - trade config
 * @param {number} firepower - base firepower
 * @param {number} directionalFirepower - directional firepower
 * @param {number} mid - 現在の mid price（USD→Coin 変換用）
 * @returns {Object} { sizeCoin: number, notionalUsd: number }
 */
/**
 * resolveNotionalSize: ロット計算エンジン
 * （テスト用に export）
 * 
 * @param {Object} payload 
 * @param {Object} aResult 
 * @param {string} side - 'buy' | 'sell'
 * @param {number} tpDistance - TP までの距離（USD）
 * @param {Object} tradeConfig - config/trade.js から来た値
 * @param {number} firepower - baseFirepower 値
 * @param {number} directionalFirepower - 方向別倍率
 * @param {number} mid - midPrice
 * @param {number} sizeScalar - エッジ品質連動サイズ倍率
 * @returns {Object} { sizeCoin, notionalUsd, skipReason? }
 */
export function resolveNotionalSize(payload, aResult, side, tpDistance, tradeConfig, firepower, directionalFirepower, mid, sizeScalar = 1.0) {
  const lotCfg = tradeConfig?.lot ?? {};
  const lotMode = String(lotCfg.mode ?? 'EQUITY_RATIO').toUpperCase();

  // equity から配分を計算（accountEquity フィールドから取得）
  const accountEquity = payload?.accountEquity;
  const equityUsd = Number(accountEquity);
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) {
    return { sizeCoin: 0, notionalUsd: 0, skipReason: 'B: no equity' };
  }

  // リスク率（デフォルト 2%）
  const riskRatio = Number(tradeConfig?.riskRatio ?? 0.02);
  const riskBudget = equityUsd * riskRatio;

  // ← Ver3修正: firepower × directionalFirepower を乗算
  // size = (riskBudget / tpDistance) × firepower × directionalFirepower
  const baseFirepower = Number(firepower ?? 1.0);
  const dirFirepower = Number(directionalFirepower ?? 1.0);
  if (!Number.isFinite(tpDistance) || tpDistance <= 0) {
    return { sizeCoin: 0, notionalUsd: 0, skipReason: 'B: invalid tpDistance' };
  }
  const safeSizeScalar = Number.isFinite(sizeScalar) ? Math.max(1.0, Math.min(2.0, sizeScalar)) : 1.0;
  const rawNotional = (riskBudget / tpDistance) * baseFirepower * dirFirepower * safeSizeScalar;

  // ← 資産比率クランプ（min/max は equity 比率で決定）
  let minNotional;
  let maxNotional;
  if (lotMode === 'FIXED_USD') {
    const minFixed = Number(lotCfg.minNotionalUsd ?? tradeConfig?.minNotionalUsd ?? 0);
    const maxFixed = Number(lotCfg.maxNotionalUsd ?? tradeConfig?.maxNotionalUsd ?? minFixed);
    minNotional = Number.isFinite(minFixed) ? minFixed : 0;
    maxNotional = Number.isFinite(maxFixed) ? maxFixed : minNotional;
  } else {
    const stage = resolveCapitalStageProfile(tradeConfig, equityUsd);
    const stageActive = Boolean(stage);
    // Equity scaling model:
    // - up to cap: use full equity
    // - above cap: increase effective equity with reduced slope (k)
    const effectiveCapUsdRaw = Number(lotCfg.effectiveEquityCapUsd ?? 0);
    const effectiveCapUsd = Number.isFinite(effectiveCapUsdRaw) && effectiveCapUsdRaw > 0 ? effectiveCapUsdRaw : 0;
    const effectiveSlopeRaw = Number(lotCfg.effectiveEquitySlopeAboveCap ?? 0.3);
    const effectiveSlope = Number.isFinite(effectiveSlopeRaw)
      ? Math.max(0, Math.min(1, effectiveSlopeRaw))
      : 0.3;
    const effectiveEquityUsd = stageActive
      ? equityUsd
      : (effectiveCapUsd > 0 && equityUsd > effectiveCapUsd
        ? (effectiveCapUsd + (equityUsd - effectiveCapUsd) * effectiveSlope)
        : equityUsd);

    const lowBand = lotCfg?.lowEquityBand ?? {};
    const useLowBand = lowBand.enabled === true
      && Number.isFinite(Number(lowBand.thresholdUsd))
      && equityUsd <= Number(lowBand.thresholdUsd);
    const minRatioRaw = Number(
      Number.isFinite(Number(stage?.lotMinRatio))
        ? stage.lotMinRatio
        : (useLowBand
        ? (lowBand.minNotionalRatio ?? lotCfg.minNotionalRatio ?? 0.40)
        : (lotCfg.minNotionalRatio ?? 0.40))
    );
    const maxRatioRaw = Number(
      Number.isFinite(Number(stage?.lotMaxRatio))
        ? stage.lotMaxRatio
        : (useLowBand
        ? (lowBand.maxNotionalRatio ?? lotCfg.maxNotionalRatio ?? 0.90)
        : (lotCfg.maxNotionalRatio ?? 0.90))
    );
    const minRatio = Number.isFinite(minRatioRaw) ? minRatioRaw : 0.40;
    const maxRatio = Number.isFinite(maxRatioRaw) ? maxRatioRaw : 0.90;
    if (minRatio > maxRatio) {
      return {
        sizeCoin: 0,
        notionalUsd: 0,
        skipReason: 'B: invalid lot ratio config'
      };
    }
    const minRatioSafe = Math.max(0, Math.min(minRatio, maxRatio));
    const maxRatioSafe = Math.max(minRatioSafe, maxRatio);
    minNotional = effectiveEquityUsd * minRatioSafe;
    maxNotional = effectiveEquityUsd * maxRatioSafe;
  }

  // ← 攻撃フェーズ判定: firepower >= threshold で min クランプを外す
  const attackFirepowerThreshold = Number(lotCfg.attackFirepowerThreshold ?? 2.0);
  const isAttackPhase = baseFirepower >= attackFirepowerThreshold;
  const notionalUsd = isAttackPhase
    ? Math.min(maxNotional, rawNotional)  // 攻撃フェーズ: min を外す
    : Math.max(minNotional, Math.min(maxNotional, rawNotional));  // 通常フェーズ: min/max で両端クランプ

  // USD → Coin 変換（sizeCoin = notionalUsd / mid）
  const sizeCoin = (mid > 0) ? notionalUsd / mid : 0;

  return {
    sizeCoin,
    notionalUsd,
    rawNotionalUsd: rawNotional,
    minNotionalUsd: minNotional,
    maxNotionalUsd: maxNotional
  };
}

/**
 * Ver2 互換: 近傍 Support を取得
 * （b2 で b1 の構造を信じているため、ここは参考実装のみ）
 * 
 * @param {Object} depthSR - depth SR state
 * @param {number} mid - current mid price
 * @returns {Object} {price, thickness, notionalUsd}
 */
function resolveNearestSupport(depthSR, mid) {
  if (!depthSR?.support || depthSR.support.length === 0) {
    return null;
  }

  // mid より下で、最も近い support を選定
  const candidates = depthSR.support
    .map((price, idx) => ({
      price,
      thickness: depthSR.supportThickness?.[idx] ?? 0,
      notionalUsd: depthSR.supportNotional?.[idx] ?? 0,
    }))
    .filter(c => c.price < mid)
    .sort((a, b) => b.price - a.price); // 近い順

  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Ver2 互換: 近傍 Resistance を取得
 * 
 * @param {Object} depthSR - depth SR state
 * @param {number} mid - current mid price
 * @returns {Object} {price, thickness, notionalUsd}
 */
function resolveNearestResistance(depthSR, mid) {
  if (!depthSR?.resistance || depthSR.resistance.length === 0) {
    return null;
  }

  // mid より上で、最も近い resistance を選定
  const candidates = depthSR.resistance
    .map((price, idx) => ({
      price,
      thickness: depthSR.resistanceThickness?.[idx] ?? 0,
      notionalUsd: depthSR.resistanceNotional?.[idx] ?? 0,
    }))
    .filter(c => c.price > mid)
    .sort((a, b) => (a.price - mid) - (b.price - mid)); // 近い順

  return candidates.length > 0 ? candidates[0] : null;
}
