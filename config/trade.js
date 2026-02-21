import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_TRADE_CONFIG = {
  leverage: 1,
  symbols: ['BTC'],
  lot: {
    min: 0.05,
    max: 1.00,
    mode: 'EQUITY_RATIO',
    minNotionalRatio: 0.30,
    maxNotionalRatio: 0.90,
    attackFirepowerThreshold: 2.0,
    effectiveEquityCapUsd: 5000,
    effectiveEquitySlopeAboveCap: 0.3,
    lowEquityBand: {
      enabled: true,
      thresholdUsd: 500,
      minNotionalRatio: 0.7,
      maxNotionalRatio: 0.9
    }
  },
  compatibility: {
    legacyKeysEnabled: true
  },
  depthGuards: {
    enabled: false,
    minSrNotionalUsd: 1_000_000,
    minTpNotionalUsd: 2_000_000,
    requireBothSides: true
  },
  depthRecheck: {
    enabled: true,
    mode: 'reject',
    windowUsd: 50,
    minSrNotionalUsd: 1_000_000,
    minTpNotionalUsd: 2_000_000,
    minSlNotionalUsd: 1_000_000
  },
  entryRateMonitor: {
    enabled: true,
    lineAlertEnabled: true,
    emailSignalEnabled: true,
    minEntryRate: 0.02,
    maxEntryRate: 0.10,
    minEvaluated: 50,
    alertCooldownMs: 30 * 60 * 1000
  },
  tuningPresets: {
    applyOnLoad: false,
    active: 'custom',
    profiles: {
      conservative: {
        minBandDistanceUsd: 500,
        minExpectedUsd: 4.0
      },
      balanced: {
        minBandDistanceUsd: 400,
        minExpectedUsd: 3.0
      },
      aggressive: {
        minBandDistanceUsd: 300,
        minExpectedUsd: 2.0
      }
    }
  },
  capitalStages: {
    enabled: true,
    bands: [
      { name: 's1', upToEquityUsd: 500, lotMinRatio: 0.7, lotMaxRatio: 0.9, feeMinNetUsd: 1.0, mapMinStrength: 0.30 },
      { name: 's2', upToEquityUsd: 2000, lotMinRatio: 0.6, lotMaxRatio: 0.9, feeMinNetUsd: 1.0, mapMinStrength: 0.45 },
      { name: 's3', upToEquityUsd: 5000, lotMinRatio: 0.6, lotMaxRatio: 0.8, feeMinNetUsd: 1.0, mapMinStrength: 0.60 },
      { name: 's4', upToEquityUsd: 10000, lotMinRatio: 0.5, lotMaxRatio: 0.7, feeMinNetUsd: 1.2, mapMinStrength: 0.65 },
      { name: 's5', upToEquityUsd: null, lotMinRatio: 0.5, lotMaxRatio: 0.7, feeMinNetUsd: 1.5, mapMinStrength: 0.70 }
    ]
  },
  lrc: {
    len: 100,
    devlen: 2.0,
    k: 1.0
  },
  slopeThresholdsByLen: {
    4: { flat: 0.5, normal: 0.8 },
    default: { flat: 1.0, normal: 2.0 }
  },
  directionalFirepower: {
    enabled: false,
    up: { long: 1.0, short: 1.0 },
    down: { long: 1.0, short: 1.0 },
    range: { long: 1.0, short: 1.0 }
  },
  firepower: {
    weak: 1.0,      // default=1.0（減衰なし）
    normal: 1.0,
    STRONG: 1.0     // default=1.0（加点は運用で明示ON）
  },
  riskGuards: {
    enabled: true,
    hardSlCooldownMs: 120000,
    reduceSizeAfterLoss: true,
    reduceSizeFactor: 0.7,
    reduceSizeWindowMs: 180000,
    awayAutoHaltEnabled: false,
    awayHardSlStreak: 2,
    awayNetWindowTrades: 10,
    awayMinTrades: 6,
    awayMinNetPerTradeUsd: -0.2,
    awayApplyInTestMode: false
  },
  performanceGuards: {
    enabled: true,
    maxDrawdownPct: 12.0,
    kpiWindowTrades: 30,
    minAvgNetUsd: -0.05,
    minAvgWinUsd: 0.45,
    minWinRate: 0.28,
    lockOnTrigger: true,
    autoResume: true,
    resumeCooldownMs: 3600000
  },
  lossTimeout: {
    enabled: true,
    eps: 0,
    ms: 240000,
    softRatio: 0.4,
    softTimeoutMs: 120000,
    hardRatio: 0.6,
    dynamicRealtime: {
      enabled: true,
      maxSpreadBps: 1.0,
      maxVelocityBps: 1.2,
      maxCShock: 0.25,
      minTimeoutMs: 45000,
      maxTimeoutMs: 300000,
      rangeTimeoutMul: 0.92,
      trendTimeoutMul: 1.03,
      stressTimeoutMul: 0.78,
      rangeSoftMul: 0.95,
      trendSoftMul: 1.02,
      stressSoftMul: 0.9,
      rangeHardMul: 0.95,
      trendHardMul: 1.03,
      stressHardMul: 0.9,
      stressExitEnabled: true,
      stressExitMinHoldMs: 15000,
      stressExitMinAdverseRatio: 0.08,
      earlyExitMinHoldMs: 45000,
      earlyExitProgressMax: 0.22
    }
  },
  b2: {
    tpStretch: 1.0,
    tpStretchHoldMs: 0,
    rangeTpStretchDisabled: false,
    hybridMode: {
      enabled: true
    },
    tpSplit: {
      enabled: true,
      closeRatio: 0.5,
      minRemainRatio: 0.2,
      tp2Trail: {
        enabled: true,
        velocityRefBps: 0.8,
        maxBoostMul: 1.35,
        minMul: 0.7,
        spreadPenaltyRefBps: 1.0,
        spreadPenaltyMul: 0.9,
        updateCooldownMs: 1500,
        trendMul: 1.05,
        rangeMul: 0.92
      }
    }
  },
  fees: {
    makerBps: 1.5,
    takerBps: 4.5,
    tpExitMode: 'auto'
  },
  feeEdgeGuard: {
    enabled: false,
    minNetUsd: 1.0,
    minNetPer100Notional: 0.02,
    exitMode: 'taker',
    strictMinNetFloor: true,
    autoSizeBoost: true,
    maxSizeBoostMul: 2.5,
    expectancyRealizationFactor: 1.0,
    dynamic: {
      enabled: true,
      tzOffsetMin: 540,
      sessionMul: {
        asia: 1.0,
        eu: 1.08,
        us: 1.12
      },
      stress: {
        spreadBpsRef: 0.6,
        velocityBpsRef: 0.7,
        maxMul: 1.2
      }
    }
  },
  metaGate: {
    enabled: true,
    maxSpreadBps: 2.5,
    maxSpreadJumpBps: 0.8,
    maxPriceVelocityBps: 1.8,
    maxCShock: 0.6,
    toxicityThreshold: 1.25,
    holdMs: 2500
  },
  startup: {
    fastStart: {
      enabled: false,
      maxElapsedMs: 240000,
      requireDepthReady: true,
      requireLrcTvReady: true
    },
    restartAssist: {
      enabled: true,
      hotRestartMaxGapMs: 180000,
      warmRestartMaxGapMs: 1800000,
      hotSizeScalar: 1.0,
      warmSizeScalar: 0.85,
      coldSizeScalar: 0.65
    }
  },
  startupGuard: {
    enabled: true,
    noOrderMs: 1800000,
    windowMs: 5400000,
    sizeScalar: 0.9,
    minMapStrengthAdd: 0.05,
    minPathDepthAdd: 1,
    freezeAutoTuneApplyMs: 5400000,
    applyInTestMode: true,
    liveBlockUntilAStable: false
  },
  b2Upgrade: {
    executionModel: {
      enabled: false,
      useDistanceEntry: true,
      distanceGuardMode: 'enforce',
      minEntryQuality: 0.25,
      minMapStrength: 0.15,
      edgeFallback: {
        enabled: true,
        minMapStrength: 0.5,
        minPathDepth: 1
      },
      rangeMode: 'c_bias',
      requireStructuralPath: true,
      srReferenceGuard: {
        enabled: true,
        windowUsd: 80,
        minRank: 0.1,
        minScore: 0,
        minNotionalUsd: 0,
        requireBothSides: false,
        allowEdgeLike: true,
        allowUnknownStrength: true,
        enforceWhenClustersPresent: true
      }
    },
    arenaGuard: {
      enabled: true,
      paddingRatio: 0.08
    },
    edgeControl: {
      baseRatio: 0.15,
      minThresholdUsd: 8,
      maxThresholdUsd: 5000
    },
    execution: {
      maxSpreadBps: 2.5,
      maxVelocityBps: 2.0,
      maxCShock: 0.7,
      makerMaxSpreadBps: 1.4,
      makerMaxVelocityBps: 1.0
    },
    adaptiveSize: {
      enabled: true,
      minScalar: 0.85,
      maxScalar: 1.25
    },
    structureQuality: {
      enabled: true,
      minScalar: 0.75,
      maxScalar: 1.0,
      fallbackQuality: 0.5
    },
    ladderAttack: {
      enabled: true,
      requireSrNext: true,
      minTp2DistanceRatio: 1.25,
      distanceSlope: 0.35,
      boostMax: 1.22
    },
    higherTfControl: {
      enabled: true,
      applyOnRegimeOnly: true,
      minReadyFrames: 1,
      blockOnConflict: false,
      blockThreshold: -0.7,
      sizeBoostMax: 1.30,
      sizePenaltyMin: 0.75,
      tpBoostMax: 1.20,
      tpPenaltyMin: 0.90,
      weight15m: 0.65,
      weight1h: 0.35
    },
    angleDirectionBoost: {
      enabled: true,
      bAlignedBoost: 1.08,
      aAlignedExtraBoost: 1.08
    },
    abTrendBoost: {
      enabled: true,
      bothAlignedBoost: 1.15
    },
    aCenterControl: {
      enabled: true,
      centerBand: 0.15,
      centerMul: 0.9
    },
    clusterWallBoost: {
      enabled: true,
      maxBoost: 1.18,
      clusterWeight: 0.55,
      wallWeight: 0.45,
      mapStrengthWeight: 0.5,
      pathDepthWeight: 0.3,
      clusterCountWeight: 0.2,
      maxClusters: 7,
      maxPathDepth: 4,
      nearWindowUsd: 120,
      minWallUsd: 70000,
      wallSaturationUsd: 250000
    },
    srClusterBridge: {
      enabled: true,
      maxClusters: 7,
      mergeGapUsd: 60,
      minDistanceUsd: 5,
      minClusterCount: 1,
      cacheTtlMs: 2500,
      invalidateMidDriftUsd: 120,
      promotion: {
        enabled: true,
        linkBandRatio: 0.08,
        linkBandMaxUsd: 30,
        minBounceAbsUsd: 12,
        minBounceRatio: 0.03,
        nearNoiseUsd: 12,
        minTouches: 2
      }
    }
  },
  lrcWsOrbit: {
    enabled: false,
    zoneBoostMax: 0.20,
    zonePenaltyMax: 0.25,
    edgeRatioBoostMax: 0.22,
    edgeRatioPenaltyMax: 0.18,
    tpStretchBoostMax: 0.12,
    tpStretchPenaltyMax: 0.08,
    microSpreadBpsRef: 0.8,
    microVelocityBpsRef: 0.8,
    microShockRef: 0.25
  },
  // minBandDistanceUsd: config/trade.json から必須導入（デフォルト削除・config 必須化）
  // minExpectedUsd: config/trade.json から必須導入（デフォルト削除・config 必須化）
  rangeFilter: {
    lookbackMin: 15,
    minRangeUsd: 20
  },
  bar1h: {
    lookbackBars: 4,
    adaptive: {
      enabled: false,
      startLookbackBars: 3,
      expandedLookbackBars: 6,
      expandStepBars: 1,
      lowSpanUsd: 1700,
      highSpanUsd: 2400,
      minFinalSpanUsd: 1600,
      switchCooldownMs: 1800000,
      weakOrderMsAfterSwitch: 1800000
    }
  },
  b1: {
    snapshotRefreshSec: 20,
    maxSrCandidates: 6,
    dailyArenaBufferUsd: 20,
    strictB1Flow: true,
    minOverlapRatio: 0.7,
    structureRecognition: {
      minDepthSpanUsd: 100,
      minDepthSpanRatioOfB15m: 0.03,
      minDepthSpanCapUsd: 220
    },
    higherTfValidation: {
      enabled: true,
      minSpanRatioOf1h: 0.3,
      minSpanUsd: 120,
      clampToBarRange: false,
      prefer: 'intersection'
    }
  },
  b0: {
    enabled: true,
    mergeDistanceUsd: 180,
    maxLevelsPerSide: 12,
    maxClustersPerSide: 6,
    dailyArenaBufferUsd: 20
  },
  sr: {
    enabled: true,
    pivot: {
      leftBars: 5,
      rightBars: 0,
      lookbackBars: 150
    },
    filter: {
      enabled: true,
      nearRatio: 0.10,
      maxLevels: 3,
      pairOuterPriority: true
    }
  },
  viewpoint: {
    minStepUsd: 90,
    arenaStepRatio: 0.12,
    tpNormalMaxT: 0.786,
    bar15mRangeWeight: 0.6,
    nearRetryFactor: 0.6,
    nearRetryMinUsd: 20
  },
  feedHealthThresholds: {
    NETWORK: { warnMs: 15000, ngMs: 30000 },
    WS: { warnMs: 15000, ngMs: 30000 },
    IO: { warnMs: 20000, ngMs: 40000 },
    decision_a: { warnMs: 25000, ngMs: 45000 },
    decision_b: { warnMs: 25000, ngMs: 45000 },
    engine: { warnMs: 30000, ngMs: 60000 },
    update: { warnMs: 30000, ngMs: 60000 }
  }
};

let cachedTradeConfig = { ...DEFAULT_TRADE_CONFIG };
let loaded = false;
let warned = false;
let lastHash = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE_PATH = path.join(__dirname, 'trade.json');

function toNumberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(num, min, max) {
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function normalizeSymbols(raw, fallback) {
  const src = Array.isArray(raw) ? raw : fallback;
  const list = Array.isArray(src) ? src : [];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    const s = String(item).trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out.length > 0 ? out : (Array.isArray(fallback) ? [...fallback] : []);
}

function normalizeTradeConfig(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const leverage = clamp(toNumberOr(data.leverage, DEFAULT_TRADE_CONFIG.leverage), 1, 40);
  const symbols = normalizeSymbols(data.symbols, DEFAULT_TRADE_CONFIG.symbols);
  const lot = data.lot && typeof data.lot === 'object' ? data.lot : {};
  const min = clamp(toNumberOr(lot.min, DEFAULT_TRADE_CONFIG.lot.min), 0, 1);
  const max = clamp(toNumberOr(lot.max, DEFAULT_TRADE_CONFIG.lot.max), 0, 1);
  const lotModeRaw = lot.mode ?? DEFAULT_TRADE_CONFIG.lot.mode;
  const lotMode = String(lotModeRaw || 'EQUITY_RATIO').toUpperCase();
  const minNotionalRatioRaw = toNumberOr(lot.minNotionalRatio, DEFAULT_TRADE_CONFIG.lot.minNotionalRatio);
  const maxNotionalRatioRaw = toNumberOr(lot.maxNotionalRatio, DEFAULT_TRADE_CONFIG.lot.maxNotionalRatio);
  const minNotionalRatio = clamp(minNotionalRatioRaw, 0, 1);
  const maxNotionalRatio = clamp(maxNotionalRatioRaw, 0, 1);
  const attackFirepowerThresholdRaw = toNumberOr(lot.attackFirepowerThreshold, DEFAULT_TRADE_CONFIG.lot.attackFirepowerThreshold);
  const attackFirepowerThreshold = Math.max(1.0, attackFirepowerThresholdRaw);
  const effectiveEquityCapUsdRaw = toNumberOr(lot.effectiveEquityCapUsd, DEFAULT_TRADE_CONFIG.lot.effectiveEquityCapUsd);
  const effectiveEquityCapUsd = Math.max(0, effectiveEquityCapUsdRaw);
  const effectiveEquitySlopeAboveCapRaw = toNumberOr(
    lot.effectiveEquitySlopeAboveCap,
    DEFAULT_TRADE_CONFIG.lot.effectiveEquitySlopeAboveCap
  );
  const effectiveEquitySlopeAboveCap = clamp(effectiveEquitySlopeAboveCapRaw, 0, 1);
  const lowEquityBandRaw = lot.lowEquityBand && typeof lot.lowEquityBand === 'object'
    ? lot.lowEquityBand
    : {};
  const lowEquityBandDef = DEFAULT_TRADE_CONFIG.lot.lowEquityBand;
  const lowBandMinRaw = toNumberOr(lowEquityBandRaw.minNotionalRatio, lowEquityBandDef.minNotionalRatio);
  const lowBandMaxRaw = toNumberOr(lowEquityBandRaw.maxNotionalRatio, lowEquityBandDef.maxNotionalRatio);
  const lowBandMin = clamp(lowBandMinRaw, 0, 1);
  const lowBandMax = clamp(lowBandMaxRaw, 0, 1);
  const lowEquityBand = {
    enabled: lowEquityBandRaw.enabled === undefined ? !!lowEquityBandDef.enabled : !!lowEquityBandRaw.enabled,
    thresholdUsd: Math.max(0, toNumberOr(lowEquityBandRaw.thresholdUsd, lowEquityBandDef.thresholdUsd)),
    minNotionalRatio: Math.min(lowBandMin, lowBandMax),
    maxNotionalRatio: Math.max(lowBandMin, lowBandMax)
  };
  const capitalStagesRaw = data.capitalStages && typeof data.capitalStages === 'object'
    ? data.capitalStages
    : {};
  const capitalStagesDef = DEFAULT_TRADE_CONFIG.capitalStages;
  const bandsRaw = Array.isArray(capitalStagesRaw.bands) ? capitalStagesRaw.bands : capitalStagesDef.bands;
  const normalizedBands = bandsRaw
    .map((band, idx) => {
      const b = band && typeof band === 'object' ? band : {};
      const minRatio = clamp(toNumberOr(b.lotMinRatio, 0.6), 0, 1);
      const maxRatio = clamp(toNumberOr(b.lotMaxRatio, 0.9), 0, 1);
      const upToRaw = b.upToEquityUsd;
      const upToEquityUsd = upToRaw === null || upToRaw === undefined
        ? null
        : Math.max(0, toNumberOr(upToRaw, Number.POSITIVE_INFINITY));
      return {
        name: String(b.name ?? `stage_${idx + 1}`),
        upToEquityUsd,
        lotMinRatio: Math.min(minRatio, maxRatio),
        lotMaxRatio: Math.max(minRatio, maxRatio),
        feeMinNetUsd: Math.max(0, toNumberOr(b.feeMinNetUsd, 1.0)),
        mapMinStrength: clamp(toNumberOr(b.mapMinStrength, 0), 0, 1)
      };
    })
    .filter(b => b.upToEquityUsd === null || Number.isFinite(b.upToEquityUsd))
    .sort((a, b) => {
      const ax = a.upToEquityUsd === null ? Number.POSITIVE_INFINITY : a.upToEquityUsd;
      const bx = b.upToEquityUsd === null ? Number.POSITIVE_INFINITY : b.upToEquityUsd;
      return ax - bx;
    });
  const capitalStages = {
    enabled: capitalStagesRaw.enabled === undefined
      ? !!capitalStagesDef.enabled
      : !!capitalStagesRaw.enabled,
    bands: normalizedBands.length > 0 ? normalizedBands : capitalStagesDef.bands
  };
  const lrc = data.lrc && typeof data.lrc === 'object' ? data.lrc : {};
  const len = Math.max(10, Math.floor(toNumberOr(lrc.len, DEFAULT_TRADE_CONFIG.lrc.len)));
  const devlen = Math.max(0.1, toNumberOr(lrc.devlen, DEFAULT_TRADE_CONFIG.lrc.devlen));
  const k = Math.max(0.0001, toNumberOr(lrc.k, DEFAULT_TRADE_CONFIG.lrc.k));
  const slopeThresholdsByLenRaw = data.slopeThresholdsByLen && typeof data.slopeThresholdsByLen === 'object'
    ? data.slopeThresholdsByLen
    : DEFAULT_TRADE_CONFIG.slopeThresholdsByLen;
  const directionalFirepower = normalizeDirectionalFirepower(data.directionalFirepower, DEFAULT_TRADE_CONFIG.directionalFirepower);
  const firepower = data.firepower && typeof data.firepower === 'object' ? data.firepower : {};
  const weak = clamp(toNumberOr(firepower.weak, DEFAULT_TRADE_CONFIG.firepower.weak), 0.5, 1.5);
  const normalFp = clamp(toNumberOr(firepower.normal, DEFAULT_TRADE_CONFIG.firepower.normal), 0.5, 1.5);
  const strong = clamp(
    toNumberOr(firepower.STRONG ?? firepower.strong, DEFAULT_TRADE_CONFIG.firepower.STRONG),
    0.5,
    1.5
  );
  // minBandDistanceUsd は config/trade.json から必須（NaN 伝搬を防ぐ）
  if (!Number.isFinite(data.minBandDistanceUsd)) {
    throw new Error('config/trade.json に minBandDistanceUsd が設定されていません。取引が開始できません。');
  }
  let minBandDistanceUsd = Math.max(0, Number(data.minBandDistanceUsd));
  
  // minExpectedUsd は config/trade.json から必須（デフォルト削除・二重化防止）
  if (!Number.isFinite(data.minExpectedUsd)) {
    throw new Error('config/trade.json に minExpectedUsd が設定されていません。取引が開始できません。');
  }
  let minExpectedUsd = Math.max(0, data.minExpectedUsd);
  
  const rangeFilter = data.rangeFilter && typeof data.rangeFilter === 'object' ? data.rangeFilter : {};
  const lookbackMin = Math.max(0, Math.floor(toNumberOr(rangeFilter.lookbackMin, DEFAULT_TRADE_CONFIG.rangeFilter.lookbackMin)));
  const minRangeUsd = Math.max(0, toNumberOr(rangeFilter.minRangeUsd, DEFAULT_TRADE_CONFIG.rangeFilter.minRangeUsd));
  const bar1hRaw = data?.bar1h && typeof data.bar1h === 'object' ? data.bar1h : {};
  const bar1hAdaptiveRaw = bar1hRaw.adaptive && typeof bar1hRaw.adaptive === 'object' ? bar1hRaw.adaptive : {};
  const bar1hAdaptiveDefaults = DEFAULT_TRADE_CONFIG.bar1h.adaptive;
  const bar1hLookback = Math.max(1, Math.floor(toNumberOr(bar1hRaw.lookbackBars, DEFAULT_TRADE_CONFIG.bar1h.lookbackBars)));
  const bar1hAdaptive = {
    enabled: bar1hAdaptiveRaw.enabled === undefined ? !!bar1hAdaptiveDefaults.enabled : !!bar1hAdaptiveRaw.enabled,
    startLookbackBars: Math.max(1, Math.floor(toNumberOr(bar1hAdaptiveRaw.startLookbackBars, bar1hAdaptiveDefaults.startLookbackBars))),
    expandedLookbackBars: Math.max(1, Math.floor(toNumberOr(bar1hAdaptiveRaw.expandedLookbackBars, bar1hAdaptiveDefaults.expandedLookbackBars))),
    expandStepBars: Math.max(1, Math.floor(toNumberOr(bar1hAdaptiveRaw.expandStepBars, bar1hAdaptiveDefaults.expandStepBars ?? 1))),
    lowSpanUsd: Math.max(1, toNumberOr(bar1hAdaptiveRaw.lowSpanUsd, bar1hAdaptiveDefaults.lowSpanUsd)),
    highSpanUsd: Math.max(1, toNumberOr(bar1hAdaptiveRaw.highSpanUsd, bar1hAdaptiveDefaults.highSpanUsd)),
    minFinalSpanUsd: Math.max(1, toNumberOr(bar1hAdaptiveRaw.minFinalSpanUsd, bar1hAdaptiveDefaults.minFinalSpanUsd ?? bar1hAdaptiveDefaults.lowSpanUsd)),
    switchCooldownMs: Math.max(0, Math.floor(toNumberOr(bar1hAdaptiveRaw.switchCooldownMs, bar1hAdaptiveDefaults.switchCooldownMs))),
    weakOrderMsAfterSwitch: Math.max(0, Math.floor(toNumberOr(bar1hAdaptiveRaw.weakOrderMsAfterSwitch, bar1hAdaptiveDefaults.weakOrderMsAfterSwitch)))
  };
  if (bar1hAdaptive.expandedLookbackBars < bar1hAdaptive.startLookbackBars) {
    bar1hAdaptive.expandedLookbackBars = bar1hAdaptive.startLookbackBars;
  }
  if (bar1hAdaptive.highSpanUsd <= bar1hAdaptive.lowSpanUsd) {
    bar1hAdaptive.highSpanUsd = bar1hAdaptive.lowSpanUsd + 100;
  }
  const snapshotRefreshSec = Math.max(0, Math.floor(toNumberOr(data?.b1?.snapshotRefreshSec, DEFAULT_TRADE_CONFIG.b1.snapshotRefreshSec)));
  const maxSrCandidates = Math.max(2, Math.min(24, Math.floor(toNumberOr(
    data?.b1?.maxSrCandidates,
    DEFAULT_TRADE_CONFIG.b1.maxSrCandidates
  ))));
  const dailyArenaBufferUsd = Math.max(0, toNumberOr(
    data?.b1?.dailyArenaBufferUsd,
    DEFAULT_TRADE_CONFIG.b1.dailyArenaBufferUsd
  ));
  const b1ValidationRaw = data?.b1?.higherTfValidation && typeof data.b1.higherTfValidation === 'object'
    ? data.b1.higherTfValidation
    : {};
  const b1StructureRecognitionRaw = data?.b1?.structureRecognition && typeof data.b1.structureRecognition === 'object'
    ? data.b1.structureRecognition
    : {};
  const viewpointRaw = data.viewpoint && typeof data.viewpoint === 'object' ? data.viewpoint : {};
  const viewpointDefaults = DEFAULT_TRADE_CONFIG.viewpoint;
  const b1ValidationDefaults = DEFAULT_TRADE_CONFIG.b1.higherTfValidation;
  const b1StructureRecognitionDefaults = DEFAULT_TRADE_CONFIG.b1.structureRecognition;
  const b1StrictB1Flow = data?.b1?.strictB1Flow === undefined
    ? DEFAULT_TRADE_CONFIG.b1.strictB1Flow
    : data.b1.strictB1Flow !== false;
  const b1MinOverlapRatio = clamp(
    toNumberOr(data?.b1?.minOverlapRatio, DEFAULT_TRADE_CONFIG.b1.minOverlapRatio ?? 0.7),
    0,
    1
  );
  const b1StructureRecognition = {
    minDepthSpanUsd: Math.max(
      1,
      toNumberOr(
        b1StructureRecognitionRaw.minDepthSpanUsd,
        b1StructureRecognitionDefaults.minDepthSpanUsd
      )
    ),
    minDepthSpanRatioOfB15m: clamp(
      toNumberOr(
        b1StructureRecognitionRaw.minDepthSpanRatioOfB15m,
        b1StructureRecognitionDefaults.minDepthSpanRatioOfB15m
      ),
      0,
      1
    ),
    minDepthSpanCapUsd: Math.max(
      1,
      toNumberOr(
        b1StructureRecognitionRaw.minDepthSpanCapUsd,
        b1StructureRecognitionDefaults.minDepthSpanCapUsd
      )
    )
  };
  const b1ValidationPreferRaw = String(b1ValidationRaw.prefer ?? b1ValidationDefaults.prefer).toLowerCase();
  const b1ValidationPrefer = ['intersection', 'bar1h', 'depth'].includes(b1ValidationPreferRaw)
    ? b1ValidationPreferRaw
    : b1ValidationDefaults.prefer;
  const b1HigherTfValidation = {
    enabled: b1ValidationRaw.enabled === undefined ? !!b1ValidationDefaults.enabled : !!b1ValidationRaw.enabled,
    minSpanRatioOf1h: clamp(
      toNumberOr(b1ValidationRaw.minSpanRatioOf1h, b1ValidationDefaults.minSpanRatioOf1h),
      0.05,
      1.5
    ),
    minSpanUsd: Math.max(
      0,
      toNumberOr(b1ValidationRaw.minSpanUsd, b1ValidationDefaults.minSpanUsd ?? 0)
    ),
    clampToBarRange: b1ValidationRaw.clampToBarRange === undefined
      ? !!b1ValidationDefaults.clampToBarRange
      : !!b1ValidationRaw.clampToBarRange,
    prefer: b1ValidationPrefer
  };
  const b0Enabled = data?.b0?.enabled === undefined
    ? DEFAULT_TRADE_CONFIG.b0.enabled
    : !!data.b0.enabled;
  const b0MergeDistanceUsd = Math.max(20, toNumberOr(
    data?.b0?.mergeDistanceUsd,
    DEFAULT_TRADE_CONFIG.b0.mergeDistanceUsd
  ));
  const b0MaxLevelsPerSide = Math.max(2, Math.min(64, Math.floor(toNumberOr(
    data?.b0?.maxLevelsPerSide,
    DEFAULT_TRADE_CONFIG.b0.maxLevelsPerSide
  ))));
  const b0MaxClustersPerSide = Math.max(1, Math.min(16, Math.floor(toNumberOr(
    data?.b0?.maxClustersPerSide,
    DEFAULT_TRADE_CONFIG.b0.maxClustersPerSide
  ))));
  const b0DailyArenaBufferUsd = Math.max(0, toNumberOr(
    data?.b0?.dailyArenaBufferUsd,
    DEFAULT_TRADE_CONFIG.b0.dailyArenaBufferUsd
  ));
  const srRaw = data?.sr && typeof data.sr === 'object' ? data.sr : {};
  const srDefaults = DEFAULT_TRADE_CONFIG.sr;
  const srPivotRaw = srRaw.pivot && typeof srRaw.pivot === 'object' ? srRaw.pivot : {};
  const srFilterRaw = srRaw.filter && typeof srRaw.filter === 'object' ? srRaw.filter : {};
  const sr = {
    enabled: srRaw.enabled === undefined ? !!srDefaults.enabled : !!srRaw.enabled,
    pivot: {
      leftBars: Math.max(1, Math.min(30, Math.floor(toNumberOr(srPivotRaw.leftBars, srDefaults.pivot.leftBars)))),
      rightBars: Math.max(0, Math.min(10, Math.floor(toNumberOr(srPivotRaw.rightBars, srDefaults.pivot.rightBars)))),
      lookbackBars: Math.max(30, Math.min(500, Math.floor(toNumberOr(srPivotRaw.lookbackBars, srDefaults.pivot.lookbackBars))))
    },
    filter: {
      enabled: srFilterRaw.enabled === undefined ? !!srDefaults.filter.enabled : !!srFilterRaw.enabled,
      nearRatio: clamp(toNumberOr(srFilterRaw.nearRatio, srDefaults.filter.nearRatio), 0.01, 0.5),
      maxLevels: Math.max(1, Math.min(12, Math.floor(toNumberOr(srFilterRaw.maxLevels, srDefaults.filter.maxLevels)))),
      pairOuterPriority: srFilterRaw.pairOuterPriority === undefined
        ? !!srDefaults.filter.pairOuterPriority
        : !!srFilterRaw.pairOuterPriority
    }
  };
  const viewpoint = {
    minStepUsd: Math.max(
      1,
      toNumberOr(viewpointRaw.minStepUsd, viewpointDefaults.minStepUsd)
    ),
    arenaStepRatio: clamp(
      toNumberOr(viewpointRaw.arenaStepRatio, viewpointDefaults.arenaStepRatio),
      0.02,
      0.8
    ),
    tpNormalMaxT: clamp(
      toNumberOr(viewpointRaw.tpNormalMaxT, viewpointDefaults.tpNormalMaxT),
      0.1,
      1.0
    ),
    bar15mRangeWeight: clamp(
      toNumberOr(viewpointRaw.bar15mRangeWeight, viewpointDefaults.bar15mRangeWeight),
      0.1,
      3.0
    ),
    nearRetryFactor: clamp(
      toNumberOr(viewpointRaw.nearRetryFactor, viewpointDefaults.nearRetryFactor),
      0.2,
      0.95
    ),
    nearRetryMinUsd: Math.max(
      1,
      toNumberOr(viewpointRaw.nearRetryMinUsd, viewpointDefaults.nearRetryMinUsd)
    )
  };
  const feedHealthThresholds = normalizeFeedHealthThresholds(data.feedHealthThresholds, DEFAULT_TRADE_CONFIG.feedHealthThresholds);
  const tpMinLiquidityUsd = Math.max(0, toNumberOr(data.tpMinLiquidityUsd, 0));
  const riskGuardsRaw = data.riskGuards && typeof data.riskGuards === 'object' ? data.riskGuards : {};
  const riskGuardsEnabled = riskGuardsRaw.enabled === undefined
    ? !!DEFAULT_TRADE_CONFIG.riskGuards.enabled
    : !!riskGuardsRaw.enabled;
  const hardSlCooldownMs = Math.max(
    0,
    Math.floor(toNumberOr(riskGuardsRaw.hardSlCooldownMs, DEFAULT_TRADE_CONFIG.riskGuards.hardSlCooldownMs))
  );
  const reduceSizeAfterLoss = riskGuardsRaw.reduceSizeAfterLoss === undefined
    ? !!DEFAULT_TRADE_CONFIG.riskGuards.reduceSizeAfterLoss
    : !!riskGuardsRaw.reduceSizeAfterLoss;
  const reduceSizeFactor = clamp(
    toNumberOr(riskGuardsRaw.reduceSizeFactor, DEFAULT_TRADE_CONFIG.riskGuards.reduceSizeFactor),
    0.1,
    1.0
  );
  const reduceSizeWindowMs = Math.max(
    0,
    Math.floor(toNumberOr(riskGuardsRaw.reduceSizeWindowMs, DEFAULT_TRADE_CONFIG.riskGuards.reduceSizeWindowMs))
  );
  const awayAutoHaltEnabled = riskGuardsRaw.awayAutoHaltEnabled === undefined
    ? !!DEFAULT_TRADE_CONFIG.riskGuards.awayAutoHaltEnabled
    : !!riskGuardsRaw.awayAutoHaltEnabled;
  const awayHardSlStreak = Math.max(
    1,
    Math.floor(toNumberOr(riskGuardsRaw.awayHardSlStreak, DEFAULT_TRADE_CONFIG.riskGuards.awayHardSlStreak))
  );
  const awayNetWindowTrades = Math.max(
    1,
    Math.floor(toNumberOr(riskGuardsRaw.awayNetWindowTrades, DEFAULT_TRADE_CONFIG.riskGuards.awayNetWindowTrades))
  );
  const awayMinTrades = Math.max(
    1,
    Math.floor(toNumberOr(riskGuardsRaw.awayMinTrades, DEFAULT_TRADE_CONFIG.riskGuards.awayMinTrades))
  );
  const awayMinNetPerTradeUsd = toNumberOr(
    riskGuardsRaw.awayMinNetPerTradeUsd,
    DEFAULT_TRADE_CONFIG.riskGuards.awayMinNetPerTradeUsd
  );
  const awayApplyInTestMode = riskGuardsRaw.awayApplyInTestMode === undefined
    ? !!DEFAULT_TRADE_CONFIG.riskGuards.awayApplyInTestMode
    : !!riskGuardsRaw.awayApplyInTestMode;
  const lossTimeoutRaw = data.lossTimeout && typeof data.lossTimeout === 'object' ? data.lossTimeout : {};
  const lossTimeoutDefaults = DEFAULT_TRADE_CONFIG.lossTimeout;
  const dynamicRealtimeRaw = lossTimeoutRaw.dynamicRealtime && typeof lossTimeoutRaw.dynamicRealtime === 'object'
    ? lossTimeoutRaw.dynamicRealtime
    : {};
  const dynamicRealtimeDefaults = lossTimeoutDefaults.dynamicRealtime;
  const lossTimeout = {
    enabled: lossTimeoutRaw.enabled === undefined ? !!lossTimeoutDefaults.enabled : !!lossTimeoutRaw.enabled,
    eps: Math.max(0, toNumberOr(lossTimeoutRaw.eps, lossTimeoutDefaults.eps)),
    ms: Math.max(1000, Math.floor(toNumberOr(lossTimeoutRaw.ms, lossTimeoutDefaults.ms))),
    softRatio: clamp(toNumberOr(lossTimeoutRaw.softRatio, lossTimeoutDefaults.softRatio), 0.05, 0.95),
    softTimeoutMs: Math.max(1000, Math.floor(toNumberOr(lossTimeoutRaw.softTimeoutMs, lossTimeoutDefaults.softTimeoutMs))),
    hardRatio: clamp(toNumberOr(lossTimeoutRaw.hardRatio, lossTimeoutDefaults.hardRatio), 0.1, 1.2),
    dynamicRealtime: {
      enabled: dynamicRealtimeRaw.enabled === undefined ? !!dynamicRealtimeDefaults.enabled : !!dynamicRealtimeRaw.enabled,
      maxSpreadBps: Math.max(0.1, toNumberOr(dynamicRealtimeRaw.maxSpreadBps, dynamicRealtimeDefaults.maxSpreadBps)),
      maxVelocityBps: Math.max(0.1, toNumberOr(dynamicRealtimeRaw.maxVelocityBps, dynamicRealtimeDefaults.maxVelocityBps)),
      maxCShock: clamp(toNumberOr(dynamicRealtimeRaw.maxCShock, dynamicRealtimeDefaults.maxCShock), 0.05, 3),
      minTimeoutMs: Math.max(1000, Math.floor(toNumberOr(dynamicRealtimeRaw.minTimeoutMs, dynamicRealtimeDefaults.minTimeoutMs))),
      maxTimeoutMs: Math.max(
        Math.max(1000, Math.floor(toNumberOr(dynamicRealtimeRaw.minTimeoutMs, dynamicRealtimeDefaults.minTimeoutMs))),
        Math.floor(toNumberOr(dynamicRealtimeRaw.maxTimeoutMs, dynamicRealtimeDefaults.maxTimeoutMs))
      ),
      rangeTimeoutMul: clamp(toNumberOr(dynamicRealtimeRaw.rangeTimeoutMul, dynamicRealtimeDefaults.rangeTimeoutMul), 0.5, 1.5),
      trendTimeoutMul: clamp(toNumberOr(dynamicRealtimeRaw.trendTimeoutMul, dynamicRealtimeDefaults.trendTimeoutMul), 0.5, 1.5),
      stressTimeoutMul: clamp(toNumberOr(dynamicRealtimeRaw.stressTimeoutMul, dynamicRealtimeDefaults.stressTimeoutMul), 0.4, 1.2),
      rangeSoftMul: clamp(toNumberOr(dynamicRealtimeRaw.rangeSoftMul, dynamicRealtimeDefaults.rangeSoftMul), 0.6, 1.4),
      trendSoftMul: clamp(toNumberOr(dynamicRealtimeRaw.trendSoftMul, dynamicRealtimeDefaults.trendSoftMul), 0.6, 1.4),
      stressSoftMul: clamp(toNumberOr(dynamicRealtimeRaw.stressSoftMul, dynamicRealtimeDefaults.stressSoftMul), 0.5, 1.2),
      rangeHardMul: clamp(toNumberOr(dynamicRealtimeRaw.rangeHardMul, dynamicRealtimeDefaults.rangeHardMul), 0.6, 1.4),
      trendHardMul: clamp(toNumberOr(dynamicRealtimeRaw.trendHardMul, dynamicRealtimeDefaults.trendHardMul), 0.6, 1.4),
      stressHardMul: clamp(toNumberOr(dynamicRealtimeRaw.stressHardMul, dynamicRealtimeDefaults.stressHardMul), 0.5, 1.2),
      stressExitEnabled: dynamicRealtimeRaw.stressExitEnabled === undefined
        ? !!dynamicRealtimeDefaults.stressExitEnabled
        : !!dynamicRealtimeRaw.stressExitEnabled,
      stressExitMinHoldMs: Math.max(
        1000,
        Math.floor(toNumberOr(dynamicRealtimeRaw.stressExitMinHoldMs, dynamicRealtimeDefaults.stressExitMinHoldMs))
      ),
      stressExitMinAdverseRatio: clamp(
        toNumberOr(dynamicRealtimeRaw.stressExitMinAdverseRatio, dynamicRealtimeDefaults.stressExitMinAdverseRatio),
        0.01,
        0.8
      ),
      earlyExitMinHoldMs: Math.max(
        1000,
        Math.floor(toNumberOr(dynamicRealtimeRaw.earlyExitMinHoldMs, dynamicRealtimeDefaults.earlyExitMinHoldMs))
      ),
      earlyExitProgressMax: clamp(
        toNumberOr(dynamicRealtimeRaw.earlyExitProgressMax, dynamicRealtimeDefaults.earlyExitProgressMax),
        0.01,
        0.8
      )
    }
  };
  const perfRaw = data.performanceGuards && typeof data.performanceGuards === 'object' ? data.performanceGuards : {};
  const perfDef = DEFAULT_TRADE_CONFIG.performanceGuards;
  const performanceGuards = {
    enabled: perfRaw.enabled === undefined ? !!perfDef.enabled : !!perfRaw.enabled,
    maxDrawdownPct: clamp(toNumberOr(perfRaw.maxDrawdownPct, perfDef.maxDrawdownPct), 1, 80),
    kpiWindowTrades: Math.max(5, Math.floor(toNumberOr(perfRaw.kpiWindowTrades, perfDef.kpiWindowTrades))),
    minAvgNetUsd: toNumberOr(perfRaw.minAvgNetUsd, perfDef.minAvgNetUsd),
    minAvgWinUsd: Math.max(0, toNumberOr(perfRaw.minAvgWinUsd, perfDef.minAvgWinUsd)),
    minWinRate: clamp(toNumberOr(perfRaw.minWinRate, perfDef.minWinRate), 0.05, 0.95),
    lockOnTrigger: perfRaw.lockOnTrigger === undefined ? !!perfDef.lockOnTrigger : !!perfRaw.lockOnTrigger,
    autoResume: perfRaw.autoResume === undefined ? !!perfDef.autoResume : !!perfRaw.autoResume,
    resumeCooldownMs: Math.max(60000, Math.floor(toNumberOr(perfRaw.resumeCooldownMs, perfDef.resumeCooldownMs)))
  };
  const b2Raw = data.b2 && typeof data.b2 === 'object' ? data.b2 : {};
  const b2Defaults = DEFAULT_TRADE_CONFIG.b2;
  const b2HybridRaw = b2Raw.hybridMode && typeof b2Raw.hybridMode === 'object' ? b2Raw.hybridMode : {};
  const b2HybridDefaults = b2Defaults.hybridMode;
  const b2TpSplitRaw = b2Raw.tpSplit && typeof b2Raw.tpSplit === 'object' ? b2Raw.tpSplit : {};
  const b2TpSplitDefaults = b2Defaults.tpSplit;
  const b2Tp2TrailRaw = b2TpSplitRaw.tp2Trail && typeof b2TpSplitRaw.tp2Trail === 'object'
    ? b2TpSplitRaw.tp2Trail
    : {};
  const b2Tp2TrailDefaults = b2TpSplitDefaults.tp2Trail;
  const b2CloseRatioRaw = clamp(toNumberOr(b2TpSplitRaw.closeRatio, b2TpSplitDefaults.closeRatio), 0.1, 0.9);
  const b2MinRemainRatioRaw = clamp(toNumberOr(b2TpSplitRaw.minRemainRatio, b2TpSplitDefaults.minRemainRatio), 0.05, 0.95);
  const b2CloseRatio = Math.min(b2CloseRatioRaw, Math.max(0.01, 1 - b2MinRemainRatioRaw));
  const b2MinRemainRatio = b2MinRemainRatioRaw;
  const b2 = {
    tpStretch: clamp(toNumberOr(b2Raw.tpStretch, b2Defaults.tpStretch), 0.5, 2.2),
    tpStretchHoldMs: Math.max(0, Math.floor(toNumberOr(b2Raw.tpStretchHoldMs, b2Defaults.tpStretchHoldMs))),
    rangeTpStretchDisabled: b2Raw.rangeTpStretchDisabled === undefined
      ? !!b2Defaults.rangeTpStretchDisabled
      : !!b2Raw.rangeTpStretchDisabled,
    hybridMode: {
      enabled: b2HybridRaw.enabled === undefined ? !!b2HybridDefaults.enabled : !!b2HybridRaw.enabled
    },
    tpSplit: {
      enabled: b2TpSplitRaw.enabled === undefined ? !!b2TpSplitDefaults.enabled : !!b2TpSplitRaw.enabled,
      closeRatio: b2CloseRatio,
      minRemainRatio: b2MinRemainRatio,
      tp2Trail: {
        enabled: b2Tp2TrailRaw.enabled === undefined ? !!b2Tp2TrailDefaults.enabled : !!b2Tp2TrailRaw.enabled,
        velocityRefBps: Math.max(0.1, toNumberOr(b2Tp2TrailRaw.velocityRefBps, b2Tp2TrailDefaults.velocityRefBps)),
        maxBoostMul: clamp(toNumberOr(b2Tp2TrailRaw.maxBoostMul, b2Tp2TrailDefaults.maxBoostMul), 1.0, 2.5),
        minMul: clamp(toNumberOr(b2Tp2TrailRaw.minMul, b2Tp2TrailDefaults.minMul), 0.4, 1.2),
        spreadPenaltyRefBps: Math.max(0.1, toNumberOr(b2Tp2TrailRaw.spreadPenaltyRefBps, b2Tp2TrailDefaults.spreadPenaltyRefBps)),
        spreadPenaltyMul: clamp(toNumberOr(b2Tp2TrailRaw.spreadPenaltyMul, b2Tp2TrailDefaults.spreadPenaltyMul), 0.5, 1.0),
        updateCooldownMs: Math.max(200, Math.floor(toNumberOr(b2Tp2TrailRaw.updateCooldownMs, b2Tp2TrailDefaults.updateCooldownMs))),
        trendMul: clamp(toNumberOr(b2Tp2TrailRaw.trendMul, b2Tp2TrailDefaults.trendMul), 0.7, 1.5),
        rangeMul: clamp(toNumberOr(b2Tp2TrailRaw.rangeMul, b2Tp2TrailDefaults.rangeMul), 0.6, 1.3)
      }
    }
  };
  const feesRaw = data.fees && typeof data.fees === 'object' ? data.fees : {};
  const makerBps = Math.max(0, toNumberOr(feesRaw.makerBps, DEFAULT_TRADE_CONFIG.fees.makerBps));
  const takerBps = Math.max(0, toNumberOr(feesRaw.takerBps, DEFAULT_TRADE_CONFIG.fees.takerBps));
  const tpExitModeRaw = String(feesRaw.tpExitMode ?? DEFAULT_TRADE_CONFIG.fees.tpExitMode ?? 'taker').toLowerCase();
  const tpExitMode = tpExitModeRaw === 'maker' || tpExitModeRaw === 'auto' ? tpExitModeRaw : 'taker';
  const feeEdgeGuardRaw = data.feeEdgeGuard && typeof data.feeEdgeGuard === 'object' ? data.feeEdgeGuard : {};
  const feeEdgeGuardDefaults = DEFAULT_TRADE_CONFIG.feeEdgeGuard;
  const feeEdgeGuard = {
    enabled: feeEdgeGuardRaw.enabled === undefined ? !!feeEdgeGuardDefaults.enabled : !!feeEdgeGuardRaw.enabled,
    minNetUsd: Math.max(1.0, toNumberOr(feeEdgeGuardRaw.minNetUsd, feeEdgeGuardDefaults.minNetUsd)),
    minNetPer100Notional: Math.max(0, toNumberOr(feeEdgeGuardRaw.minNetPer100Notional, feeEdgeGuardDefaults.minNetPer100Notional)),
    exitMode: String(feeEdgeGuardRaw.exitMode ?? feeEdgeGuardDefaults.exitMode ?? 'taker').toLowerCase() === 'maker' ? 'maker' : 'taker',
    strictMinNetFloor: feeEdgeGuardRaw.strictMinNetFloor === undefined
      ? !!feeEdgeGuardDefaults.strictMinNetFloor
      : !!feeEdgeGuardRaw.strictMinNetFloor,
    autoSizeBoost: feeEdgeGuardRaw.autoSizeBoost === undefined
      ? !!feeEdgeGuardDefaults.autoSizeBoost
      : !!feeEdgeGuardRaw.autoSizeBoost,
    maxSizeBoostMul: clamp(
      toNumberOr(feeEdgeGuardRaw.maxSizeBoostMul, feeEdgeGuardDefaults.maxSizeBoostMul),
      1.0,
      6.0
    ),
    expectancyRealizationFactor: clamp(
      toNumberOr(feeEdgeGuardRaw.expectancyRealizationFactor, feeEdgeGuardDefaults.expectancyRealizationFactor ?? 1.0),
      0.1,
      1.0
    ),
    dynamic: {
      enabled: feeEdgeGuardRaw?.dynamic?.enabled === undefined
        ? !!feeEdgeGuardDefaults.dynamic.enabled
        : !!feeEdgeGuardRaw.dynamic.enabled,
      tzOffsetMin: Math.floor(toNumberOr(feeEdgeGuardRaw?.dynamic?.tzOffsetMin, feeEdgeGuardDefaults.dynamic.tzOffsetMin)),
      sessionMul: {
        asia: clamp(toNumberOr(feeEdgeGuardRaw?.dynamic?.sessionMul?.asia, feeEdgeGuardDefaults.dynamic.sessionMul.asia), 0.5, 2.0),
        eu: clamp(toNumberOr(feeEdgeGuardRaw?.dynamic?.sessionMul?.eu, feeEdgeGuardDefaults.dynamic.sessionMul.eu), 0.5, 2.0),
        us: clamp(toNumberOr(feeEdgeGuardRaw?.dynamic?.sessionMul?.us, feeEdgeGuardDefaults.dynamic.sessionMul.us), 0.5, 2.0)
      },
      stress: {
        spreadBpsRef: Math.max(0.1, toNumberOr(feeEdgeGuardRaw?.dynamic?.stress?.spreadBpsRef, feeEdgeGuardDefaults.dynamic.stress.spreadBpsRef)),
        velocityBpsRef: Math.max(0.1, toNumberOr(feeEdgeGuardRaw?.dynamic?.stress?.velocityBpsRef, feeEdgeGuardDefaults.dynamic.stress.velocityBpsRef)),
        maxMul: clamp(toNumberOr(feeEdgeGuardRaw?.dynamic?.stress?.maxMul, feeEdgeGuardDefaults.dynamic.stress.maxMul), 1.0, 3.0)
      }
    }
  };
  const srDistanceGuardRaw = data.srDistanceGuard && typeof data.srDistanceGuard === 'object' ? data.srDistanceGuard : {};
  const srDistanceGuardEnabled = srDistanceGuardRaw.enabled !== false;
  const minSRDistanceUsd = Math.max(0, toNumberOr(srDistanceGuardRaw.minSRDistanceUsd, 10));
  const maxSRDistanceUsd = Math.max(minSRDistanceUsd, toNumberOr(srDistanceGuardRaw.maxSRDistanceUsd, 120));
  const metaGateRaw = data.metaGate && typeof data.metaGate === 'object' ? data.metaGate : {};
  const metaGateDefaults = DEFAULT_TRADE_CONFIG.metaGate;
  const metaGate = {
    enabled: metaGateRaw.enabled === undefined ? !!metaGateDefaults.enabled : !!metaGateRaw.enabled,
    maxSpreadBps: Math.max(0.1, toNumberOr(metaGateRaw.maxSpreadBps, metaGateDefaults.maxSpreadBps)),
    maxSpreadJumpBps: Math.max(0.05, toNumberOr(metaGateRaw.maxSpreadJumpBps, metaGateDefaults.maxSpreadJumpBps)),
    maxPriceVelocityBps: Math.max(0.1, toNumberOr(metaGateRaw.maxPriceVelocityBps, metaGateDefaults.maxPriceVelocityBps)),
    maxCShock: clamp(toNumberOr(metaGateRaw.maxCShock, metaGateDefaults.maxCShock), 0.05, 2),
    toxicityThreshold: clamp(toNumberOr(metaGateRaw.toxicityThreshold, metaGateDefaults.toxicityThreshold), 0.2, 3),
    holdMs: Math.max(0, Math.floor(toNumberOr(metaGateRaw.holdMs, metaGateDefaults.holdMs)))
  };
  const startupRaw = data.startup && typeof data.startup === 'object' ? data.startup : {};
  const fastStartRaw = startupRaw.fastStart && typeof startupRaw.fastStart === 'object'
    ? startupRaw.fastStart
    : {};
  const fastStartDefaults = DEFAULT_TRADE_CONFIG.startup.fastStart;
  const fastStart = {
    enabled: fastStartRaw.enabled === undefined ? !!fastStartDefaults.enabled : !!fastStartRaw.enabled,
    maxElapsedMs: Math.max(0, Math.floor(toNumberOr(fastStartRaw.maxElapsedMs, fastStartDefaults.maxElapsedMs))),
    requireDepthReady: fastStartRaw.requireDepthReady === undefined
      ? !!fastStartDefaults.requireDepthReady
      : !!fastStartRaw.requireDepthReady,
    requireLrcTvReady: fastStartRaw.requireLrcTvReady === undefined
      ? !!fastStartDefaults.requireLrcTvReady
      : !!fastStartRaw.requireLrcTvReady
  };
  const restartAssistRaw = startupRaw.restartAssist && typeof startupRaw.restartAssist === 'object'
    ? startupRaw.restartAssist
    : {};
  const restartAssistDefaults = DEFAULT_TRADE_CONFIG.startup.restartAssist;
  const hotRestartMaxGapMs = Math.max(0, Math.floor(toNumberOr(
    restartAssistRaw.hotRestartMaxGapMs,
    restartAssistDefaults.hotRestartMaxGapMs
  )));
  const warmRestartMaxGapMs = Math.max(
    hotRestartMaxGapMs,
    Math.floor(toNumberOr(restartAssistRaw.warmRestartMaxGapMs, restartAssistDefaults.warmRestartMaxGapMs))
  );
  const restartAssist = {
    enabled: restartAssistRaw.enabled === undefined ? !!restartAssistDefaults.enabled : !!restartAssistRaw.enabled,
    hotRestartMaxGapMs,
    warmRestartMaxGapMs,
    hotSizeScalar: clamp(toNumberOr(restartAssistRaw.hotSizeScalar, restartAssistDefaults.hotSizeScalar), 0.3, 1.0),
    warmSizeScalar: clamp(toNumberOr(restartAssistRaw.warmSizeScalar, restartAssistDefaults.warmSizeScalar), 0.3, 1.0),
    coldSizeScalar: clamp(toNumberOr(restartAssistRaw.coldSizeScalar, restartAssistDefaults.coldSizeScalar), 0.3, 1.0)
  };
  const startupGuardRaw = data.startupGuard && typeof data.startupGuard === 'object' ? data.startupGuard : {};
  const startupGuardDefaults = DEFAULT_TRADE_CONFIG.startupGuard;
  const startupGuard = {
    enabled: startupGuardRaw.enabled === undefined ? !!startupGuardDefaults.enabled : !!startupGuardRaw.enabled,
    noOrderMs: Math.max(0, Math.floor(toNumberOr(startupGuardRaw.noOrderMs, startupGuardDefaults.noOrderMs))),
    windowMs: Math.max(0, Math.floor(toNumberOr(startupGuardRaw.windowMs, startupGuardDefaults.windowMs))),
    sizeScalar: clamp(toNumberOr(startupGuardRaw.sizeScalar, startupGuardDefaults.sizeScalar), 0.5, 1.0),
    minMapStrengthAdd: clamp(
      toNumberOr(startupGuardRaw.minMapStrengthAdd, startupGuardDefaults.minMapStrengthAdd),
      0,
      0.3
    ),
    minPathDepthAdd: Math.max(
      0,
      Math.min(3, Math.floor(toNumberOr(startupGuardRaw.minPathDepthAdd, startupGuardDefaults.minPathDepthAdd)))
    ),
    freezeAutoTuneApplyMs: Math.max(
      0,
      Math.floor(toNumberOr(startupGuardRaw.freezeAutoTuneApplyMs, startupGuardDefaults.freezeAutoTuneApplyMs))
    ),
    applyInTestMode: startupGuardRaw.applyInTestMode === undefined
      ? !!startupGuardDefaults.applyInTestMode
      : !!startupGuardRaw.applyInTestMode,
    liveBlockUntilAStable: startupGuardRaw.liveBlockUntilAStable === undefined
      ? !!startupGuardDefaults.liveBlockUntilAStable
      : !!startupGuardRaw.liveBlockUntilAStable
  };
  // 0 <= noOrderMs <= windowMs を保証（2段起動制限の順序維持）
  startupGuard.noOrderMs = Math.min(startupGuard.noOrderMs, startupGuard.windowMs);
  const b2UpgradeRaw = data.b2Upgrade && typeof data.b2Upgrade === 'object' ? data.b2Upgrade : {};
  const b2UpgradeDefault = DEFAULT_TRADE_CONFIG.b2Upgrade;
  const executionModelRaw = b2UpgradeRaw.executionModel && typeof b2UpgradeRaw.executionModel === 'object'
    ? b2UpgradeRaw.executionModel
    : {};
  const arenaGuardRaw = b2UpgradeRaw.arenaGuard && typeof b2UpgradeRaw.arenaGuard === 'object'
    ? b2UpgradeRaw.arenaGuard
    : {};
  const edgeControlRaw = b2UpgradeRaw.edgeControl && typeof b2UpgradeRaw.edgeControl === 'object'
    ? b2UpgradeRaw.edgeControl
    : {};
  const executionRaw = b2UpgradeRaw.execution && typeof b2UpgradeRaw.execution === 'object'
    ? b2UpgradeRaw.execution
    : {};
  const adaptiveSizeRaw = b2UpgradeRaw.adaptiveSize && typeof b2UpgradeRaw.adaptiveSize === 'object'
    ? b2UpgradeRaw.adaptiveSize
    : {};
  const structureQualityRaw = b2UpgradeRaw.structureQuality && typeof b2UpgradeRaw.structureQuality === 'object'
    ? b2UpgradeRaw.structureQuality
    : {};
  const ladderAttackRaw = b2UpgradeRaw.ladderAttack && typeof b2UpgradeRaw.ladderAttack === 'object'
    ? b2UpgradeRaw.ladderAttack
    : {};
  const higherTfRaw = b2UpgradeRaw.higherTfControl && typeof b2UpgradeRaw.higherTfControl === 'object'
    ? b2UpgradeRaw.higherTfControl
    : {};
  const angleDirectionBoostRaw = b2UpgradeRaw.angleDirectionBoost && typeof b2UpgradeRaw.angleDirectionBoost === 'object'
    ? b2UpgradeRaw.angleDirectionBoost
    : {};
  const abTrendBoostRaw = b2UpgradeRaw.abTrendBoost && typeof b2UpgradeRaw.abTrendBoost === 'object'
    ? b2UpgradeRaw.abTrendBoost
    : {};
  const aCenterControlRaw = b2UpgradeRaw.aCenterControl && typeof b2UpgradeRaw.aCenterControl === 'object'
    ? b2UpgradeRaw.aCenterControl
    : {};
  const clusterWallBoostRaw = b2UpgradeRaw.clusterWallBoost && typeof b2UpgradeRaw.clusterWallBoost === 'object'
    ? b2UpgradeRaw.clusterWallBoost
    : {};
  const srClusterBridgeRaw = b2UpgradeRaw.srClusterBridge && typeof b2UpgradeRaw.srClusterBridge === 'object'
    ? b2UpgradeRaw.srClusterBridge
    : {};
  const srBridgePromotionRaw = srClusterBridgeRaw.promotion && typeof srClusterBridgeRaw.promotion === 'object'
    ? srClusterBridgeRaw.promotion
    : {};
  const distanceGuardModeRaw = String(
    executionModelRaw.distanceGuardMode ?? b2UpgradeDefault.executionModel.distanceGuardMode ?? 'enforce'
  ).toLowerCase();
  const distanceGuardMode = ['enforce', 'shadow', 'off'].includes(distanceGuardModeRaw)
    ? distanceGuardModeRaw
    : 'enforce';
  const rangeModeRaw = String(executionModelRaw.rangeMode ?? b2UpgradeDefault.executionModel.rangeMode ?? 'c_bias').toLowerCase();
  const rangeMode = ['c_bias', 'skip'].includes(rangeModeRaw) ? rangeModeRaw : 'c_bias';
  const b2Upgrade = {
    executionModel: {
      enabled: executionModelRaw.enabled === undefined
        ? !!b2UpgradeDefault.executionModel.enabled
        : !!executionModelRaw.enabled,
      useDistanceEntry: executionModelRaw.useDistanceEntry === undefined
        ? !!b2UpgradeDefault.executionModel.useDistanceEntry
        : !!executionModelRaw.useDistanceEntry,
      distanceGuardMode,
      minEntryQuality: clamp(
        toNumberOr(executionModelRaw.minEntryQuality, b2UpgradeDefault.executionModel.minEntryQuality),
        0.0,
        0.95
      ),
      minMapStrength: clamp(
        toNumberOr(executionModelRaw.minMapStrength, b2UpgradeDefault.executionModel.minMapStrength),
        0.0,
        1.0
      ),
      edgeFallback: {
        enabled: executionModelRaw.edgeFallback?.enabled === undefined
          ? !!b2UpgradeDefault.executionModel.edgeFallback.enabled
          : !!executionModelRaw.edgeFallback.enabled,
        minMapStrength: clamp(
          toNumberOr(
            executionModelRaw.edgeFallback?.minMapStrength,
            b2UpgradeDefault.executionModel.edgeFallback.minMapStrength
          ),
          0.0,
          1.0
        ),
        minPathDepth: Math.max(
          0,
          Math.floor(
            toNumberOr(
              executionModelRaw.edgeFallback?.minPathDepth,
              b2UpgradeDefault.executionModel.edgeFallback.minPathDepth
            )
          )
        )
      },
      rangeMode,
      requireStructuralPath: executionModelRaw.requireStructuralPath === undefined
        ? !!b2UpgradeDefault.executionModel.requireStructuralPath
        : !!executionModelRaw.requireStructuralPath,
      srReferenceGuard: {
        enabled: executionModelRaw.srReferenceGuard?.enabled === undefined
          ? !!b2UpgradeDefault.executionModel.srReferenceGuard.enabled
          : !!executionModelRaw.srReferenceGuard.enabled,
        windowUsd: Math.max(
          1,
          toNumberOr(
            executionModelRaw.srReferenceGuard?.windowUsd,
            b2UpgradeDefault.executionModel.srReferenceGuard.windowUsd
          )
        ),
        minRank: clamp(
          toNumberOr(
            executionModelRaw.srReferenceGuard?.minRank,
            b2UpgradeDefault.executionModel.srReferenceGuard.minRank
          ),
          0,
          1
        ),
        minScore: Math.max(
          0,
          toNumberOr(
            executionModelRaw.srReferenceGuard?.minScore,
            b2UpgradeDefault.executionModel.srReferenceGuard.minScore
          )
        ),
        minNotionalUsd: Math.max(
          0,
          toNumberOr(
            executionModelRaw.srReferenceGuard?.minNotionalUsd,
            b2UpgradeDefault.executionModel.srReferenceGuard.minNotionalUsd
          )
        ),
        requireBothSides: executionModelRaw.srReferenceGuard?.requireBothSides === undefined
          ? !!b2UpgradeDefault.executionModel.srReferenceGuard.requireBothSides
          : !!executionModelRaw.srReferenceGuard.requireBothSides,
        allowEdgeLike: executionModelRaw.srReferenceGuard?.allowEdgeLike === undefined
          ? !!b2UpgradeDefault.executionModel.srReferenceGuard.allowEdgeLike
          : !!executionModelRaw.srReferenceGuard.allowEdgeLike,
        allowUnknownStrength: executionModelRaw.srReferenceGuard?.allowUnknownStrength === undefined
          ? !!b2UpgradeDefault.executionModel.srReferenceGuard.allowUnknownStrength
          : !!executionModelRaw.srReferenceGuard.allowUnknownStrength,
        enforceWhenClustersPresent: executionModelRaw.srReferenceGuard?.enforceWhenClustersPresent === undefined
          ? !!b2UpgradeDefault.executionModel.srReferenceGuard.enforceWhenClustersPresent
          : !!executionModelRaw.srReferenceGuard.enforceWhenClustersPresent
      }
    },
    arenaGuard: {
      enabled: arenaGuardRaw.enabled === undefined ? !!b2UpgradeDefault.arenaGuard.enabled : !!arenaGuardRaw.enabled,
      paddingRatio: clamp(toNumberOr(arenaGuardRaw.paddingRatio, b2UpgradeDefault.arenaGuard.paddingRatio), 0, 0.25)
    },
    edgeControl: {
      baseRatio: clamp(toNumberOr(edgeControlRaw.baseRatio, b2UpgradeDefault.edgeControl.baseRatio), 0.05, 0.30),
      minThresholdUsd: Math.max(1, toNumberOr(edgeControlRaw.minThresholdUsd, b2UpgradeDefault.edgeControl.minThresholdUsd)),
      maxThresholdUsd: Math.max(
        Math.max(1, toNumberOr(edgeControlRaw.minThresholdUsd, b2UpgradeDefault.edgeControl.minThresholdUsd)),
        toNumberOr(edgeControlRaw.maxThresholdUsd, b2UpgradeDefault.edgeControl.maxThresholdUsd)
      )
    },
    execution: {
      maxSpreadBps: Math.max(0.1, toNumberOr(executionRaw.maxSpreadBps, b2UpgradeDefault.execution.maxSpreadBps)),
      maxVelocityBps: Math.max(0.1, toNumberOr(executionRaw.maxVelocityBps, b2UpgradeDefault.execution.maxVelocityBps)),
      maxCShock: clamp(toNumberOr(executionRaw.maxCShock, b2UpgradeDefault.execution.maxCShock), 0.05, 2),
      makerMaxSpreadBps: Math.max(0.1, toNumberOr(executionRaw.makerMaxSpreadBps, b2UpgradeDefault.execution.makerMaxSpreadBps)),
      makerMaxVelocityBps: Math.max(0.1, toNumberOr(executionRaw.makerMaxVelocityBps, b2UpgradeDefault.execution.makerMaxVelocityBps))
    },
    adaptiveSize: {
      enabled: adaptiveSizeRaw.enabled === undefined ? !!b2UpgradeDefault.adaptiveSize.enabled : !!adaptiveSizeRaw.enabled,
      minScalar: clamp(toNumberOr(adaptiveSizeRaw.minScalar, b2UpgradeDefault.adaptiveSize.minScalar), 0.5, 1.0),
      maxScalar: clamp(toNumberOr(adaptiveSizeRaw.maxScalar, b2UpgradeDefault.adaptiveSize.maxScalar), 1.0, 2.0)
    },
    structureQuality: {
      enabled: structureQualityRaw.enabled === undefined
        ? !!b2UpgradeDefault.structureQuality.enabled
        : !!structureQualityRaw.enabled,
      minScalar: clamp(
        toNumberOr(structureQualityRaw.minScalar, b2UpgradeDefault.structureQuality.minScalar),
        0.3,
        1.0
      ),
      maxScalar: clamp(
        toNumberOr(structureQualityRaw.maxScalar, b2UpgradeDefault.structureQuality.maxScalar),
        0.8,
        2.0
      ),
      fallbackQuality: clamp(
        toNumberOr(structureQualityRaw.fallbackQuality, b2UpgradeDefault.structureQuality.fallbackQuality),
        0,
        1
      )
    },
    ladderAttack: {
      enabled: ladderAttackRaw.enabled === undefined ? !!b2UpgradeDefault.ladderAttack.enabled : !!ladderAttackRaw.enabled,
      requireSrNext: ladderAttackRaw.requireSrNext === undefined
        ? !!b2UpgradeDefault.ladderAttack.requireSrNext
        : !!ladderAttackRaw.requireSrNext,
      minTp2DistanceRatio: clamp(
        toNumberOr(ladderAttackRaw.minTp2DistanceRatio, b2UpgradeDefault.ladderAttack.minTp2DistanceRatio),
        1.0,
        4.0
      ),
      distanceSlope: clamp(
        toNumberOr(ladderAttackRaw.distanceSlope, b2UpgradeDefault.ladderAttack.distanceSlope),
        0.05,
        2.0
      ),
      boostMax: clamp(
        toNumberOr(ladderAttackRaw.boostMax, b2UpgradeDefault.ladderAttack.boostMax),
        1.0,
        2.5
      )
    },
    higherTfControl: {
      enabled: higherTfRaw.enabled === undefined ? !!b2UpgradeDefault.higherTfControl.enabled : !!higherTfRaw.enabled,
      applyOnRegimeOnly: higherTfRaw.applyOnRegimeOnly === undefined
        ? !!b2UpgradeDefault.higherTfControl.applyOnRegimeOnly
        : !!higherTfRaw.applyOnRegimeOnly,
      minReadyFrames: Math.max(0, Math.floor(toNumberOr(higherTfRaw.minReadyFrames, b2UpgradeDefault.higherTfControl.minReadyFrames))),
      blockOnConflict: higherTfRaw.blockOnConflict === undefined
        ? !!b2UpgradeDefault.higherTfControl.blockOnConflict
        : !!higherTfRaw.blockOnConflict,
      blockThreshold: clamp(toNumberOr(higherTfRaw.blockThreshold, b2UpgradeDefault.higherTfControl.blockThreshold), -1.0, 0),
      sizeBoostMax: clamp(toNumberOr(higherTfRaw.sizeBoostMax, b2UpgradeDefault.higherTfControl.sizeBoostMax), 1.0, 2.5),
      sizePenaltyMin: clamp(toNumberOr(higherTfRaw.sizePenaltyMin, b2UpgradeDefault.higherTfControl.sizePenaltyMin), 0.4, 1.0),
      tpBoostMax: clamp(toNumberOr(higherTfRaw.tpBoostMax, b2UpgradeDefault.higherTfControl.tpBoostMax), 1.0, 2.0),
      tpPenaltyMin: clamp(toNumberOr(higherTfRaw.tpPenaltyMin, b2UpgradeDefault.higherTfControl.tpPenaltyMin), 0.5, 1.0),
      weight15m: clamp(toNumberOr(higherTfRaw.weight15m, b2UpgradeDefault.higherTfControl.weight15m), 0, 1),
      weight1h: clamp(toNumberOr(higherTfRaw.weight1h, b2UpgradeDefault.higherTfControl.weight1h), 0, 1)
    },
    angleDirectionBoost: {
      enabled: angleDirectionBoostRaw.enabled === undefined
        ? !!b2UpgradeDefault.angleDirectionBoost.enabled
        : !!angleDirectionBoostRaw.enabled,
      bAlignedBoost: clamp(
        toNumberOr(angleDirectionBoostRaw.bAlignedBoost, b2UpgradeDefault.angleDirectionBoost.bAlignedBoost),
        1.0,
        2.0
      ),
      aAlignedExtraBoost: clamp(
        toNumberOr(angleDirectionBoostRaw.aAlignedExtraBoost, b2UpgradeDefault.angleDirectionBoost.aAlignedExtraBoost),
        1.0,
        2.0
      )
    },
    abTrendBoost: {
      enabled: abTrendBoostRaw.enabled === undefined
        ? !!b2UpgradeDefault.abTrendBoost.enabled
        : !!abTrendBoostRaw.enabled,
      bothAlignedBoost: clamp(
        toNumberOr(abTrendBoostRaw.bothAlignedBoost, b2UpgradeDefault.abTrendBoost.bothAlignedBoost),
        1.0,
        2.0
      )
    },
    aCenterControl: {
      enabled: aCenterControlRaw.enabled === undefined
        ? !!b2UpgradeDefault.aCenterControl.enabled
        : !!aCenterControlRaw.enabled,
      centerBand: clamp(
        toNumberOr(aCenterControlRaw.centerBand, b2UpgradeDefault.aCenterControl.centerBand),
        0.01,
        0.8
      ),
      centerMul: clamp(
        toNumberOr(aCenterControlRaw.centerMul, b2UpgradeDefault.aCenterControl.centerMul),
        0.5,
        1.0
      )
    },
    clusterWallBoost: {
      enabled: clusterWallBoostRaw.enabled === undefined
        ? !!b2UpgradeDefault.clusterWallBoost.enabled
        : !!clusterWallBoostRaw.enabled,
      maxBoost: clamp(toNumberOr(clusterWallBoostRaw.maxBoost, b2UpgradeDefault.clusterWallBoost.maxBoost), 1.0, 3.0),
      clusterWeight: clamp(toNumberOr(clusterWallBoostRaw.clusterWeight, b2UpgradeDefault.clusterWallBoost.clusterWeight), 0, 1),
      wallWeight: clamp(toNumberOr(clusterWallBoostRaw.wallWeight, b2UpgradeDefault.clusterWallBoost.wallWeight), 0, 1),
      mapStrengthWeight: clamp(
        toNumberOr(clusterWallBoostRaw.mapStrengthWeight, b2UpgradeDefault.clusterWallBoost.mapStrengthWeight),
        0,
        1
      ),
      pathDepthWeight: clamp(
        toNumberOr(clusterWallBoostRaw.pathDepthWeight, b2UpgradeDefault.clusterWallBoost.pathDepthWeight),
        0,
        1
      ),
      clusterCountWeight: clamp(
        toNumberOr(clusterWallBoostRaw.clusterCountWeight, b2UpgradeDefault.clusterWallBoost.clusterCountWeight),
        0,
        1
      ),
      maxClusters: Math.max(1, Math.floor(toNumberOr(clusterWallBoostRaw.maxClusters, b2UpgradeDefault.clusterWallBoost.maxClusters))),
      maxPathDepth: Math.max(1, Math.floor(toNumberOr(clusterWallBoostRaw.maxPathDepth, b2UpgradeDefault.clusterWallBoost.maxPathDepth))),
      nearWindowUsd: Math.max(1, toNumberOr(clusterWallBoostRaw.nearWindowUsd, b2UpgradeDefault.clusterWallBoost.nearWindowUsd)),
      minWallUsd: Math.max(0, toNumberOr(clusterWallBoostRaw.minWallUsd, b2UpgradeDefault.clusterWallBoost.minWallUsd)),
      wallSaturationUsd: Math.max(
        Math.max(1, toNumberOr(clusterWallBoostRaw.minWallUsd, b2UpgradeDefault.clusterWallBoost.minWallUsd)) + 1,
        toNumberOr(clusterWallBoostRaw.wallSaturationUsd, b2UpgradeDefault.clusterWallBoost.wallSaturationUsd)
      )
    },
    srClusterBridge: {
      enabled: srClusterBridgeRaw.enabled === undefined
        ? !!b2UpgradeDefault.srClusterBridge.enabled
        : !!srClusterBridgeRaw.enabled,
      maxClusters: Math.max(
        3,
        Math.min(12, Math.floor(toNumberOr(srClusterBridgeRaw.maxClusters, b2UpgradeDefault.srClusterBridge.maxClusters)))
      ),
      mergeGapUsd: Math.max(
        1,
        toNumberOr(srClusterBridgeRaw.mergeGapUsd, b2UpgradeDefault.srClusterBridge.mergeGapUsd)
      ),
      minDistanceUsd: Math.max(
        0,
        toNumberOr(srClusterBridgeRaw.minDistanceUsd, b2UpgradeDefault.srClusterBridge.minDistanceUsd)
      ),
      minClusterCount: Math.max(
        1,
        Math.min(6, Math.floor(toNumberOr(srClusterBridgeRaw.minClusterCount, b2UpgradeDefault.srClusterBridge.minClusterCount)))
      ),
      cacheTtlMs: Math.max(
        0,
        Math.floor(toNumberOr(srClusterBridgeRaw.cacheTtlMs, b2UpgradeDefault.srClusterBridge.cacheTtlMs))
      ),
      invalidateMidDriftUsd: Math.max(
        0,
        toNumberOr(srClusterBridgeRaw.invalidateMidDriftUsd, b2UpgradeDefault.srClusterBridge.invalidateMidDriftUsd)
      ),
      promotion: {
        enabled: srBridgePromotionRaw.enabled === undefined
          ? !!b2UpgradeDefault.srClusterBridge.promotion.enabled
          : !!srBridgePromotionRaw.enabled,
        linkBandRatio: clamp(
          toNumberOr(srBridgePromotionRaw.linkBandRatio, b2UpgradeDefault.srClusterBridge.promotion.linkBandRatio),
          0.02,
          0.3
        ),
        linkBandMaxUsd: Math.max(
          5,
          toNumberOr(srBridgePromotionRaw.linkBandMaxUsd, b2UpgradeDefault.srClusterBridge.promotion.linkBandMaxUsd)
        ),
        minBounceAbsUsd: Math.max(
          1,
          toNumberOr(srBridgePromotionRaw.minBounceAbsUsd, b2UpgradeDefault.srClusterBridge.promotion.minBounceAbsUsd)
        ),
        minBounceRatio: clamp(
          toNumberOr(srBridgePromotionRaw.minBounceRatio, b2UpgradeDefault.srClusterBridge.promotion.minBounceRatio),
          0.01,
          0.3
        ),
        nearNoiseUsd: Math.max(
          0,
          toNumberOr(srBridgePromotionRaw.nearNoiseUsd, b2UpgradeDefault.srClusterBridge.promotion.nearNoiseUsd)
        ),
        minTouches: Math.max(
          1,
          Math.floor(toNumberOr(srBridgePromotionRaw.minTouches, b2UpgradeDefault.srClusterBridge.promotion.minTouches))
        )
      }
    }
  };
  const lrcWsOrbitRaw = data.lrcWsOrbit && typeof data.lrcWsOrbit === 'object' ? data.lrcWsOrbit : {};
  const lrcWsOrbitDefault = DEFAULT_TRADE_CONFIG.lrcWsOrbit;
  const lrcWsOrbit = {
    enabled: lrcWsOrbitRaw.enabled === undefined ? !!lrcWsOrbitDefault.enabled : !!lrcWsOrbitRaw.enabled,
    zoneBoostMax: clamp(toNumberOr(lrcWsOrbitRaw.zoneBoostMax, lrcWsOrbitDefault.zoneBoostMax), 0, 0.8),
    zonePenaltyMax: clamp(toNumberOr(lrcWsOrbitRaw.zonePenaltyMax, lrcWsOrbitDefault.zonePenaltyMax), 0, 0.8),
    edgeRatioBoostMax: clamp(toNumberOr(lrcWsOrbitRaw.edgeRatioBoostMax, lrcWsOrbitDefault.edgeRatioBoostMax), 0, 0.8),
    edgeRatioPenaltyMax: clamp(toNumberOr(lrcWsOrbitRaw.edgeRatioPenaltyMax, lrcWsOrbitDefault.edgeRatioPenaltyMax), 0, 0.8),
    tpStretchBoostMax: clamp(toNumberOr(lrcWsOrbitRaw.tpStretchBoostMax, lrcWsOrbitDefault.tpStretchBoostMax), 0, 0.8),
    tpStretchPenaltyMax: clamp(toNumberOr(lrcWsOrbitRaw.tpStretchPenaltyMax, lrcWsOrbitDefault.tpStretchPenaltyMax), 0, 0.8),
    microSpreadBpsRef: Math.max(0.1, toNumberOr(lrcWsOrbitRaw.microSpreadBpsRef, lrcWsOrbitDefault.microSpreadBpsRef)),
    microVelocityBpsRef: Math.max(0.1, toNumberOr(lrcWsOrbitRaw.microVelocityBpsRef, lrcWsOrbitDefault.microVelocityBpsRef)),
    microShockRef: Math.max(0.05, toNumberOr(lrcWsOrbitRaw.microShockRef, lrcWsOrbitDefault.microShockRef))
  };

  // srAggregate は存在すればそのまま渡す（詳細バリデーションは Aggregator 側に委譲）
  const srAggregate = data.srAggregate && typeof data.srAggregate === 'object'
    ? { ...data.srAggregate }
    : { enabled: false };
  const compatibilityRaw = data.compatibility && typeof data.compatibility === 'object' ? data.compatibility : {};
  const compatibilityDefaults = DEFAULT_TRADE_CONFIG.compatibility;
  const compatibility = {
    legacyKeysEnabled: compatibilityRaw.legacyKeysEnabled === undefined
      ? !!compatibilityDefaults.legacyKeysEnabled
      : !!compatibilityRaw.legacyKeysEnabled
  };
  const depthGuardsRaw = data.depthGuards && typeof data.depthGuards === 'object' ? data.depthGuards : {};
  const depthGuardsDefaults = DEFAULT_TRADE_CONFIG.depthGuards;
  const depthGuards = {
    enabled: depthGuardsRaw.enabled === undefined
      ? !!depthGuardsDefaults.enabled
      : !!depthGuardsRaw.enabled,
    // 仕様書キー互換:
    // - min_depth_usd_per_sr -> minSrNotionalUsd
    // - min_tp_depth_usd -> minTpNotionalUsd
    minSrNotionalUsd: Math.max(
      0,
      toNumberOr(
        depthGuardsRaw.minSrNotionalUsd ?? data.min_depth_usd_per_sr,
        depthGuardsDefaults.minSrNotionalUsd
      )
    ),
    minTpNotionalUsd: Math.max(
      0,
      toNumberOr(
        depthGuardsRaw.minTpNotionalUsd ?? data.min_tp_depth_usd,
        depthGuardsDefaults.minTpNotionalUsd
      )
    ),
    requireBothSides: depthGuardsRaw.requireBothSides === undefined
      ? !!depthGuardsDefaults.requireBothSides
      : !!depthGuardsRaw.requireBothSides
  };
  const depthRecheckRaw = data.depthRecheck && typeof data.depthRecheck === 'object' ? data.depthRecheck : {};
  const depthRecheckDefaults = DEFAULT_TRADE_CONFIG.depthRecheck;
  const depthRecheckModeRaw = String(
    depthRecheckRaw.mode ?? depthRecheckDefaults.mode ?? 'reject'
  ).trim().toLowerCase();
  const depthRecheckMode = depthRecheckModeRaw === 'observe_only' ? 'observe_only' : 'reject';
  const depthRecheck = {
    enabled: depthRecheckRaw.enabled === undefined
      ? (data.depth_recheck_enabled === undefined
        ? !!depthRecheckDefaults.enabled
        : !!data.depth_recheck_enabled)
      : !!depthRecheckRaw.enabled,
    mode: depthRecheckMode,
    windowUsd: Math.max(
      1,
      toNumberOr(
        depthRecheckRaw.windowUsd ?? data.depth_recheck_window_usd,
        depthRecheckDefaults.windowUsd
      )
    ),
    minSrNotionalUsd: Math.max(
      0,
      toNumberOr(
        depthRecheckRaw.minSrNotionalUsd ?? data.min_depth_usd_per_sr,
        depthRecheckDefaults.minSrNotionalUsd
      )
    ),
    minTpNotionalUsd: Math.max(
      0,
      toNumberOr(
        depthRecheckRaw.minTpNotionalUsd ?? data.min_tp_depth_usd,
        depthRecheckDefaults.minTpNotionalUsd
      )
    ),
    minSlNotionalUsd: Math.max(
      0,
      toNumberOr(
        depthRecheckRaw.minSlNotionalUsd ?? data.min_sl_depth_usd,
        depthRecheckDefaults.minSlNotionalUsd
      )
    )
  };
  const entryRateMonitorRaw = data.entryRateMonitor && typeof data.entryRateMonitor === 'object' ? data.entryRateMonitor : {};
  const entryRateMonitorDefault = DEFAULT_TRADE_CONFIG.entryRateMonitor;
  const entryRateMonitor = {
    enabled: entryRateMonitorRaw.enabled === undefined ? !!entryRateMonitorDefault.enabled : !!entryRateMonitorRaw.enabled,
    lineAlertEnabled: entryRateMonitorRaw.lineAlertEnabled === undefined ? !!entryRateMonitorDefault.lineAlertEnabled : !!entryRateMonitorRaw.lineAlertEnabled,
    emailSignalEnabled: entryRateMonitorRaw.emailSignalEnabled === undefined ? !!entryRateMonitorDefault.emailSignalEnabled : !!entryRateMonitorRaw.emailSignalEnabled,
    minEntryRate: clamp(toNumberOr(entryRateMonitorRaw.minEntryRate, entryRateMonitorDefault.minEntryRate), 0, 1),
    maxEntryRate: clamp(toNumberOr(entryRateMonitorRaw.maxEntryRate, entryRateMonitorDefault.maxEntryRate), 0, 1),
    minEvaluated: Math.max(1, Math.floor(toNumberOr(entryRateMonitorRaw.minEvaluated, entryRateMonitorDefault.minEvaluated))),
    alertCooldownMs: Math.max(10_000, Math.floor(toNumberOr(entryRateMonitorRaw.alertCooldownMs, entryRateMonitorDefault.alertCooldownMs)))
  };
  if (entryRateMonitor.maxEntryRate < entryRateMonitor.minEntryRate) {
    entryRateMonitor.maxEntryRate = entryRateMonitor.minEntryRate;
  }
  const tuningPresetsRaw = data.tuningPresets && typeof data.tuningPresets === 'object' ? data.tuningPresets : {};
  const tuningPresetsDefault = DEFAULT_TRADE_CONFIG.tuningPresets;
  const profilesRaw = tuningPresetsRaw.profiles && typeof tuningPresetsRaw.profiles === 'object'
    ? tuningPresetsRaw.profiles
    : tuningPresetsDefault.profiles;
  const tuningPresets = {
    applyOnLoad: tuningPresetsRaw.applyOnLoad === undefined ? !!tuningPresetsDefault.applyOnLoad : !!tuningPresetsRaw.applyOnLoad,
    active: typeof tuningPresetsRaw.active === 'string' ? tuningPresetsRaw.active : tuningPresetsDefault.active,
    profiles: {
      conservative: {
        minBandDistanceUsd: Math.max(0, toNumberOr(profilesRaw?.conservative?.minBandDistanceUsd, tuningPresetsDefault.profiles.conservative.minBandDistanceUsd)),
        minExpectedUsd: Math.max(0, toNumberOr(profilesRaw?.conservative?.minExpectedUsd, tuningPresetsDefault.profiles.conservative.minExpectedUsd))
      },
      balanced: {
        minBandDistanceUsd: Math.max(0, toNumberOr(profilesRaw?.balanced?.minBandDistanceUsd, tuningPresetsDefault.profiles.balanced.minBandDistanceUsd)),
        minExpectedUsd: Math.max(0, toNumberOr(profilesRaw?.balanced?.minExpectedUsd, tuningPresetsDefault.profiles.balanced.minExpectedUsd))
      },
      aggressive: {
        minBandDistanceUsd: Math.max(0, toNumberOr(profilesRaw?.aggressive?.minBandDistanceUsd, tuningPresetsDefault.profiles.aggressive.minBandDistanceUsd)),
        minExpectedUsd: Math.max(0, toNumberOr(profilesRaw?.aggressive?.minExpectedUsd, tuningPresetsDefault.profiles.aggressive.minExpectedUsd))
      }
    }
  };
  if (tuningPresets.applyOnLoad && tuningPresets.active !== 'custom') {
    const profile = tuningPresets.profiles[tuningPresets.active];
    if (profile) {
      minBandDistanceUsd = Math.max(0, toNumberOr(profile.minBandDistanceUsd, minBandDistanceUsd));
      minExpectedUsd = Math.max(0, toNumberOr(profile.minExpectedUsd, minExpectedUsd));
    }
  }

  return {
    ...data,
    leverage,
    symbols,
    lot: {
      min: Math.min(min, max),
      max: Math.max(min, max),
      mode: lotMode,
      minNotionalRatio: Math.min(minNotionalRatio, maxNotionalRatio),
      maxNotionalRatio: Math.max(minNotionalRatio, maxNotionalRatio),
      attackFirepowerThreshold,
      effectiveEquityCapUsd,
      effectiveEquitySlopeAboveCap,
      lowEquityBand
    },
    capitalStages,
    lrc: {
      len,
      devlen,
      k
    },
    slopeThresholdsByLen: slopeThresholdsByLenRaw,
    directionalFirepower,
    firepower: {
      weak,
      normal: normalFp,
      STRONG: strong
    },
    minBandDistanceUsd,
    minExpectedUsd,
    rangeFilter: {
      lookbackMin,
      minRangeUsd
    },
    bar1h: {
      lookbackBars: bar1hLookback,
      adaptive: bar1hAdaptive
    },
    b1: {
      snapshotRefreshSec,
      maxSrCandidates,
      dailyArenaBufferUsd,
      strictB1Flow: b1StrictB1Flow,
      minOverlapRatio: b1MinOverlapRatio,
      structureRecognition: b1StructureRecognition,
      higherTfValidation: b1HigherTfValidation
    },
    b0: {
      enabled: b0Enabled,
      mergeDistanceUsd: b0MergeDistanceUsd,
      maxLevelsPerSide: b0MaxLevelsPerSide,
      maxClustersPerSide: b0MaxClustersPerSide,
      dailyArenaBufferUsd: b0DailyArenaBufferUsd
    },
    sr,
    viewpoint,
    feedHealthThresholds,
    tpMinLiquidityUsd,
    riskGuards: {
      enabled: riskGuardsEnabled,
      hardSlCooldownMs,
      reduceSizeAfterLoss,
      reduceSizeFactor,
      reduceSizeWindowMs,
      awayAutoHaltEnabled,
      awayHardSlStreak,
      awayNetWindowTrades,
      awayMinTrades,
      awayMinNetPerTradeUsd,
      awayApplyInTestMode
    },
    performanceGuards,
    lossTimeout,
    b2,
    fees: {
      makerBps,
      takerBps,
      tpExitMode
    },
    feeEdgeGuard,
    metaGate,
    startup: {
      fastStart,
      restartAssist
    },
    startupGuard,
    b2Upgrade,
    lrcWsOrbit,
    srDistanceGuard: {
      enabled: srDistanceGuardEnabled,
      minSRDistanceUsd,
      maxSRDistanceUsd
    },
    entryRateMonitor,
    tuningPresets,
    compatibility,
    depthGuards,
    depthRecheck,
    srAggregate
  };
}

function normalizeFeedHealthThresholds(raw, defaults) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of Object.keys(defaults)) {
    const warnMs = toNumberOr(src?.[key]?.warnMs, defaults[key].warnMs);
    const ngMs = toNumberOr(src?.[key]?.ngMs, defaults[key].ngMs);
    out[key] = {
      warnMs: Math.max(0, warnMs),
      ngMs: Math.max(0, ngMs)
    };
  }
  return out;
}

function normalizeDirectionalFirepower(raw, defaults) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const def = defaults || DEFAULT_TRADE_CONFIG.directionalFirepower;
  const clampDir = (val, fallback) => clamp(toNumberOr(val, fallback), 0, 2);
  const resolvePair = (key) => {
    const entry = src[key];
    const defEntry = def[key];
    const longVal = clampDir(entry?.long, defEntry.long);
    const shortVal = clampDir(entry?.short, defEntry.short);
    return { long: longVal, short: shortVal };
  };
  return {
    enabled: src.enabled === undefined ? !!def.enabled : !!src.enabled,
    up: resolvePair('up'),
    down: resolvePair('down'),
    range: resolvePair('range')
  };
}

function resolveSlopeThresholds(len, direct, table) {
  const baseFlat = toNumberOr(direct.flat, DEFAULT_TRADE_CONFIG.slopeThresholds.flat);
  const baseNormal = toNumberOr(direct.normal, DEFAULT_TRADE_CONFIG.slopeThresholds.normal);
  const tableEntry = table && (table[len] || table[String(len)] || table.default || null);
  const flat = Math.max(0, toNumberOr(tableEntry?.flat, baseFlat));
  const normal = Math.max(flat, toNumberOr(tableEntry?.normal, baseNormal));
  return { flat, normal };
}

function computeHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function readAndNormalizeTradeConfig() {
  const raw = fs.readFileSync(FILE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const normalized = normalizeTradeConfig(parsed);
  return { normalized, hash: computeHash(raw) };
}

export function loadTradeConfig(force = false) {
  if (loaded && !force) {
    return cachedTradeConfig;
  }
  try {
    const { normalized, hash } = readAndNormalizeTradeConfig();
    cachedTradeConfig = normalized;
    lastHash = hash;
    loaded = true;
    return cachedTradeConfig;
  } catch (err) {
    loaded = true;
    // minExpectedUsd/minBandDistanceUsd の欠落は致命的（fallback せず throw）
    if (err.message && (err.message.indexOf('minExpectedUsd') >= 0 || err.message.indexOf('minBandDistanceUsd') >= 0)) {
      throw err; // config.json の必須項目欠落は再スロー
    }
    // その他のエラーはデフォルトで代替（構文エラー等）
    cachedTradeConfig = { ...DEFAULT_TRADE_CONFIG };
    if (!warned) {
      warned = true;
      // ← #4修正: filePath → FILE_PATH に修正（ReferenceError対応）
      console.warn(`[trade] failed to load ${FILE_PATH}, using defaults. Error: ${err.message}`);
    }
    return cachedTradeConfig;
  }
}

export function getTradeConfig() {
  if (!loaded) {
    loadTradeConfig(); // 初回呼び出し時に読み込み
  }
  return loaded ? cachedTradeConfig : { ...DEFAULT_TRADE_CONFIG };
}

export function resolveB1SnapshotRefreshSetting(tradeConfig = getTradeConfig(), env = process.env) {
  const envRaw = env?.B1_SNAPSHOT_REFRESH_SEC;
  if (envRaw !== undefined) {
    const envSec = Number(envRaw);
    if (Number.isFinite(envSec) && envSec >= 0) {
      const sec = Math.floor(envSec);
      return { sec, ms: sec * 1000, source: 'env' };
    }
  }
  const configSecRaw = Number(tradeConfig?.b1?.snapshotRefreshSec);
  if (Number.isFinite(configSecRaw) && configSecRaw >= 0) {
    const sec = Math.floor(configSecRaw);
    return { sec, ms: sec * 1000, source: 'config' };
  }
  const fallbackSec = 20;
  return { sec: fallbackSec, ms: fallbackSec * 1000, source: 'default' };
}

/**
 * ファイルのハッシュが変わった時だけ再読込する。
 * 変更があれば { changed: true, hash } を返す。
 * 致命的エラー（必須フィールド欠落）は throw し、その他はデフォルト維持で changed: false。
 */
export function refreshTradeConfigIfChanged() {
  if (!loaded) {
    return { changed: true, config: loadTradeConfig(true), hash: lastHash };
  }
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const nextHash = computeHash(raw);
    if (lastHash && nextHash === lastHash) {
      return { changed: false, config: cachedTradeConfig, hash: lastHash };
    }
    const parsed = JSON.parse(raw);
    const normalized = normalizeTradeConfig(parsed);
    cachedTradeConfig = normalized;
    lastHash = nextHash;
    return { changed: true, config: cachedTradeConfig, hash: lastHash };
  } catch (err) {
    // minExpectedUsd/minBandDistanceUsd 欠落は致命的（そのまま throw）
    if (err.message && (err.message.indexOf('minExpectedUsd') >= 0 || err.message.indexOf('minBandDistanceUsd') >= 0)) {
      throw err;
    }
    // その他のエラーはデフォルト維持で警告一度だけ
    if (!warned) {
      warned = true;
      console.warn(`[trade] refresh failed, keep current config. Error: ${err.message}`);
    }
    return { changed: false, config: cachedTradeConfig, hash: lastHash };
  }
}

/**
 * 一定間隔で config/trade.json を再読込する。
 * onChange(hash) を指定すると、変更時に呼び出される。
 */
export function startTradeConfigAutoReload(intervalMs = 60000, onChange) {
  // まず即時チェック
  refreshTradeConfigIfChanged();
  const timer = setInterval(() => {
    const res = refreshTradeConfigIfChanged();
    if (res.changed && typeof onChange === 'function') {
      try {
        onChange(res.hash, res.config);
      } catch (_) {
        // onChange のエラーは握りつぶす
      }
    }
  }, Math.max(1000, intervalMs));
  // ← #5修正: unref() でプロセス終了を妨げない
  if (timer.unref) timer.unref();
  return timer;
}
