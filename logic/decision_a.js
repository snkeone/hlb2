/**
 * logic/decision_a.js
 * 
 * A ロジック - 俯瞰判定（LOGIC_SPEC_v1.3準拠）
 * 
 * 役割：
 *   - 相場の方向性（regime）と有効エリア（arena）を決める
 *   - 売買判定（allow）は常に true/false で返す
 *   - IOメトリクスからの制約(constraints)を伝播
 * 
 * 出力：AResult
 *   regime: 'UP'|'DOWN'|'RANGE'|'NONE' - 方向分類
 *   arena?: { low, high, mid, valid }  - 有効エリア
 *   allow: boolean                     - 売買評価可能
 *   constraints: string[]              - 制約リスト（IO層から）
 *   reason: string                     - 必ず 'A: ' prefix
 */

import { updateHealth, STAGES } from '../core/healthState.js';
import { getTradeConfig } from '../config/trade.js';

// lookbackレンジ判定用のサンプル蓄積（Aロジック内で完結・軽量）
// ← #15修正: コイン・モード単位でキャッシュを分離
const rangeCache = new Map();  // キー: `${symbol}-${mode}`
const MAX_RANGE_SAMPLES = 1000; // メモリ肥大防止：上限数

function getCacheKey(symbol, mode) {
  return `${symbol || 'UNKNOWN'}-${mode || 'test'}`;
}

function normalizeTrend(raw, fallback = 'RANGE') {
  const trend = String(raw ?? fallback).toUpperCase();
  return trend === 'UP' ? 'UP' : (trend === 'DOWN' ? 'DOWN' : 'RANGE');
}

function resolveTrendFromState(state, sourceLabel) {
  const raw = state?.trendState ?? state?.trend;
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  return {
    trend: normalizeTrend(raw, 'RANGE'),
    source: sourceLabel
  };
}

function resolveTrendFromC(ioMetrics, cOverride = null, threshold = 0.35) {
  const c = Number(Number.isFinite(Number(cOverride)) ? cOverride : ioMetrics?.c);
  if (!Number.isFinite(c)) return null;
  if (c >= threshold) return 'UP';
  if (c <= -threshold) return 'DOWN';
  return null;
}

function resolveDailyTrendMeta(ioMetrics, cOverride = null) {
  const lrcDState = ioMetrics?.lrcDState ?? null;
  const lrcAState = ioMetrics?.lrcAState ?? null;
  const lrcTvState = ioMetrics?.lrcTvState ?? null;
  const lrcState = ioMetrics?.lrcState ?? null;
  const resolved = (
    resolveTrendFromState(lrcDState, 'lrcD') ??
    resolveTrendFromState(lrcAState, 'lrcA') ??
    resolveTrendFromState(lrcTvState, 'lrcTv') ??
    resolveTrendFromState(lrcState, 'lrcState') ??
    { trend: 'RANGE', source: 'RANGE_DEFAULT' }
  );
  const cTrend = resolveTrendFromC(ioMetrics, cOverride);
  if (resolved.trend === 'RANGE' && cTrend) {
    return {
      trend: cTrend,
      source: 'cTrend',
      usedFallback: true
    };
  }
  return {
    trend: resolved.trend,
    source: resolved.source,
    usedFallback: resolved.source !== 'lrcD'
  };
}

function resolveTrendMeta(ioMetrics, cOverride = null) {
  const lrcAState = ioMetrics?.lrcAState ?? null;
  const lrcTvState = ioMetrics?.lrcTvState ?? null;
  const lrcState = ioMetrics?.lrcState ?? null;
  const resolved = (
    resolveTrendFromState(lrcAState, 'lrcA') ??
    resolveTrendFromState(lrcTvState, 'lrcTv') ??
    resolveTrendFromState(lrcState, 'lrcState') ??
    { trend: 'RANGE', source: 'RANGE_DEFAULT' }
  );
  const cTrend = resolveTrendFromC(ioMetrics, cOverride);
  if (resolved.trend === 'RANGE' && cTrend) {
    return {
      trend: cTrend,
      source: 'cTrend',
      usedFallback: true
    };
  }
  return {
    trend: resolved.trend,
    source: resolved.source,
    usedFallback: resolved.source !== 'lrcA'
  };
}

function resolveDailyArea(ioMetrics) {
  const lrcD = ioMetrics?.lrcDState ?? null;
  const dTop = Number(lrcD?.channelTop);
  const dBottom = Number(lrcD?.channelBottom);
  const dMid = Number(lrcD?.channelMid);
  if (Number.isFinite(dTop) && Number.isFinite(dBottom) && dTop > dBottom) {
    return {
      channelTop: dTop,
      channelBottom: dBottom,
      mid: Number.isFinite(dMid) ? dMid : (dTop + dBottom) / 2,
      valid: true,
      source: 'lrc_d_daily'
    };
  }
  return null;
}

function resolveStrengthScore(rawSlope, fallback = 0.5) {
  const n = Math.abs(Number(rawSlope));
  if (!Number.isFinite(n)) return Math.max(0, Math.min(1, Number(fallback)));
  return Math.max(0, Math.min(1, n));
}

function resolveActiveArea(ioMetrics, bar1hState, midPrice) {
  const lrcA = ioMetrics?.lrcAState ?? null;

  const aTop = Number(lrcA?.channelTop);
  const aBottom = Number(lrcA?.channelBottom);
  const aMid = Number(lrcA?.channelMid);
  if (Number.isFinite(aTop) && Number.isFinite(aBottom) && aTop > aBottom) {
    return {
      channelTop: aTop,
      channelBottom: aBottom,
      mid: Number.isFinite(aMid) ? aMid : (aTop + aBottom) / 2,
      valid: true,
      source: 'lrc_a_1h'
    };
  }
  return null;
}

function resolveAreaSideZone(area, midPrice) {
  const top = Number(area?.channelTop);
  const bottom = Number(area?.channelBottom);
  const mid = Number(midPrice);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(mid) || top <= bottom) {
    return {
      side: 'BUY',
      zone: 'middle',
      positionRatio: 0.5
    };
  }
  const span = top - bottom;
  const positionRaw = (mid - bottom) / span;
  const positionRatio = Math.max(0, Math.min(1, positionRaw));
  const zone = positionRatio <= 0.25
    ? 'bottom'
    : (positionRatio >= 0.75 ? 'top' : 'middle');
  const side = positionRatio < 0.5 ? 'BUY' : 'SELL';
  return {
    side,
    zone,
    positionRatio
  };
}

export function decideTradeA(payload) {
  try {
    updateHealth(STAGES.DECISION_A);
  } catch (err) {
    console.error('[DECISION_A] updateHealth failed', err);
  }
  const { ioMetrics, marketState } = payload;
  const { lrcAState, lrcDState, lrcState, bar1hState, c } = ioMetrics || {};
  const marketCurrent = marketState?.current || {};
  const tradeConfig = getTradeConfig();
  const minRangeUsd = Number.isFinite(tradeConfig?.rangeFilter?.minRangeUsd)
    ? tradeConfig.rangeFilter.minRangeUsd
    : 0;
  const lookbackMin = Number.isFinite(tradeConfig?.rangeFilter?.lookbackMin)
    ? Math.max(0, Math.floor(tradeConfig.rangeFilter.lookbackMin))
    : 0;
  
  // ─────────────────────────
  // ガード：鮮度チェック（Phase 2対応）
  // ─────────────────────────
  const nowMs = payload?.timestamp;
  // 実データの最新時刻を優先して鮮度を測る
  const lastMarketAtMs = marketCurrent?.ts ?? ioMetrics?.lastUpdated ?? payload?.timestamp;
  const marketAgeMs = (Number.isFinite(nowMs) && Number.isFinite(lastMarketAtMs))
    ? nowMs - lastMarketAtMs
    : 0;
  
  // STALLED_THRESHOLD_MS = 10,000ms（ws/runtime.js L26）
  if (marketAgeMs > 10000) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      // [A1-1] reason 語彙統一：古いデータは data not ready と扱う
      reason: 'A: data not ready',
      _gateDiag: { code: 'A_STALE_MARKET', marketAgeMs }
    };
  }
  
  // ─────────────────────────
  // 最優先ガード：bar1h 準備状況（lookback本数充足が要）
  // ─────────────────────────
  // Note: bar1h が最も重要な前提条件（lookback本数分のウォームアップ期間）
  //       LRC よりも先にチェックし、未準備なら即座に停止
  // Note: TEST_MODE時は1本でA-GATE通過可能（精度維持のため3本まで読み続ける）
  const MAX_DATA_AGE_MS = 60000;  // 60秒を上限
  const isTestMode = process.env.TEST_MODE === '1';
  const bar1hMinimumMet = isTestMode
    ? (bar1hState && bar1hState.barCount >= 1)
    : (bar1hState && bar1hState.ready);
  
  if (!bar1hMinimumMet) {
    const depthReady = ioMetrics?.depthSR?.ready === true;
    const lrcAReady = lrcAState?.ready === true;
    const lrcReady = lrcState?.ready === true;
    const lrcTvReady = ioMetrics?.lrcTvState?.ready === true;
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: bar1h not ready',
      _gateDiag: { 
        code: 'A_NOT_READY_BAR1H', 
        bar1hExists: !!bar1hState, 
        bar1hReady: bar1hState?.ready ?? false,
        bar1hBarCount: bar1hState?.barCount ?? 0,
        isTestMode,
        depthReady,
        lrcAReady,
        lrcReady,
        lrcTvReady
      }
    };
  }
  
  // bar1hState の鮮度チェック
  const bar1hAgeMs = (Number.isFinite(nowMs) && Number.isFinite(bar1hState?.lastUpdateTime))
    ? nowMs - bar1hState.lastUpdateTime
    : 0;
  if (bar1hAgeMs > MAX_DATA_AGE_MS) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: data stale',
      _gateDiag: { 
        code: 'A_STALE_BAR1H', 
        bar1hAgeMs 
      }
    };
  }
  
  // ─────────────────────────
  // ガード：A参照チャネル（1h広域LRC）準備状況
  // ─────────────────────────
  if (!lrcAState || lrcAState.ready !== true) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: preparing broad 1h arena',
      _gateDiag: { 
        code: 'A_NOT_READY_LRC_A', 
        lrcAExists: !!lrcAState, 
        lrcAReady: lrcAState?.ready ?? false
      }
    };
  }

  // lrcAState の鮮度チェック
  const lrcAAgeMs = (Number.isFinite(nowMs) && Number.isFinite(lrcAState?.lastUpdateTime))
    ? nowMs - lrcAState.lastUpdateTime
    : 0;
  if (lrcAAgeMs > MAX_DATA_AGE_MS) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: data stale',
      _gateDiag: { 
        code: 'A_STALE_LRC_A', 
        lrcAAgeMs
      }
    };
  }

  // ─────────────────────────
  // Note: MID_CHOP (abs(c) < 0.20) は禁止ではなく情報として zone に反映
  // A は「状況定義」のみ。B が判断権を持つ。
  // ─────────────────────────
  const cNum = Number(c);
  if (!Number.isFinite(cNum)) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: no valid c',
      _gateDiag: {
        code: 'A_INVALID_C',
        c
      }
    };
  }
  
  // ─────────────────────────
  // 有効レンジ判定（LOGIC_SPEC_v1.3 セクション2）
  // ─────────────────────────
  const activeRange = (Number.isFinite(bar1hState.high) ? bar1hState.high : 0) - (Number.isFinite(bar1hState.low) ? bar1hState.low : 0);
  
  if (!Number.isFinite(activeRange) || activeRange <= 0) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      // [A1-1] reason 語彙統一：A: outside active area
      reason: 'A: outside active area',
      _gateDiag: { 
        code: 'A_INVALID_RANGE', 
        high: bar1hState.high, 
        low: bar1hState.low, 
        range: activeRange 
      }
    };
  }
  
  // ─────────────────────────
  // midPrice 決定
  // ─────────────────────────
  const midPrice = Number.isFinite(marketCurrent.midPx)
    ? marketCurrent.midPx
    : (Number.isFinite(bar1hState.mid)
      ? bar1hState.mid
      : (Number.isFinite(bar1hState.high) && Number.isFinite(bar1hState.low)
        ? (bar1hState.high + bar1hState.low) / 2
        : NaN));
  
  if (!Number.isFinite(midPrice)) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: no valid price',
      _gateDiag: { 
        code: 'A_MISSING_PRICE', 
        marketMid: marketCurrent.midPx, 
        bar1hMid: bar1hState.mid 
      }
    };
  }

  // ─────────────────────────
  // Range Filter: lookbackMin + minRangeUsd gate（優先: lookbackレンジ）
  // ─────────────────────────
  if (Number.isFinite(minRangeUsd) && minRangeUsd > 0) {
    const windowMs = lookbackMin > 0 ? lookbackMin * 60 * 1000 : 0;
    let effectiveRangeUsd = activeRange;
    let lookbackRangeUsd = null;
    if (windowMs > 0 && Number.isFinite(midPrice)) {
      // ← #15修正: コイン・モード単位のキャッシュを使用
      const symbol = marketCurrent?.symbol || ioMetrics?.symbol || tradeConfig?.symbols?.[0] || 'UNKNOWN';
      const mode = payload?.mode || (process.env.TEST_MODE === '1' ? 'test' : 'live');
      const cacheKey = getCacheKey(symbol, mode);
      
      if (!rangeCache.has(cacheKey)) {
        rangeCache.set(cacheKey, []);
      }
      const rangeSamples = rangeCache.get(cacheKey);
      
      // サンプル追加
      const ts = lastMarketAtMs;
      rangeSamples.push({ ts, midPx: midPrice });
      const cutoff = ts - windowMs;
      // 不要サンプル削除（有限値のみ）
      for (let i = rangeSamples.length - 1; i >= 0; i--) {
        const s = rangeSamples[i];
        if (!Number.isFinite(s?.midPx) || s.ts < cutoff) {
          rangeSamples.splice(i, 1);
        }
      }
      // メモリ肥大防止：上限超過時は古いサンプルから削除
      if (rangeSamples.length > MAX_RANGE_SAMPLES) {
        rangeSamples.sort((a, b) => a.ts - b.ts);
        rangeSamples.splice(0, rangeSamples.length - MAX_RANGE_SAMPLES);
      }
      if (rangeSamples.length >= 2) {
        let hi = -Infinity;
        let lo = Infinity;
        for (const s of rangeSamples) {
          if (s.midPx > hi) hi = s.midPx;
          if (s.midPx < lo) lo = s.midPx;
        }
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          lookbackRangeUsd = hi - lo;
          // 視野のアンカーは上位足。短期lookbackは補助としてのみ使う。
          // これで 5-15m の極小レンジに引っ張られて A が過剰に狭窄しにくくなる。
          effectiveRangeUsd = Math.max(activeRange, lookbackRangeUsd);
        }
      }
    }
    // [A0-4] effectiveRangeUsd は常にfinite（NaN排除）
    if (!Number.isFinite(effectiveRangeUsd)) {
      effectiveRangeUsd = activeRange; // fallback
    }
    if (!Number.isFinite(effectiveRangeUsd) || effectiveRangeUsd < minRangeUsd) {
      const constraints = [...(ioMetrics?.constraints || []), 'range_too_small'];
      return {
        regime: 'NONE',
        side: null,
        zone: null,
        trend_strength: null,
        arena: null,
        allow: false,
        constraints,
        // [A1-1] reason 語彙統一：正確なminRangeUsd比較表示
        reason: `A: range too narrow usd=${Number.isFinite(effectiveRangeUsd) ? effectiveRangeUsd.toFixed(2) : '0.00'} < ${minRangeUsd}`,
        _gateDiag: {
          code: 'A_RANGE_TOO_NARROW',
          activeRange,
          lookbackMin,
          lookbackRangeUsd,
          effectiveRangeUsd,
          minRangeUsd
        }
      };
    }
  }
  
  // ─────────────────────────
  // bias 判定（LOGIC_SPEC_v1.3 セクション2）
  // 
  // bias=UP   : trend=UP && price >= mid
  // bias=DOWN : trend=DOWN && price <= mid
  // bias=RANGE: それ以外
  // ─────────────────────────
  let bias = 'RANGE';
  const h1TrendMeta = resolveTrendMeta(ioMetrics, payload?.c);
  const dailyTrendMeta = resolveDailyTrendMeta(ioMetrics, payload?.c);
  const h1Trend = h1TrendMeta.trend;
  const dailyTrend = dailyTrendMeta.trend;
  
  const activeArea = resolveActiveArea(ioMetrics, bar1hState, midPrice);
  if (!activeArea) {
    return {
      regime: 'NONE',
      side: null,
      zone: null,
      trend_strength: null,
      arena: null,
      allow: false,
      constraints: ioMetrics?.constraints || [],
      reason: 'A: preparing broad 1h arena',
      _gateDiag: {
        code: 'A_ARENA_UNDEFINED',
        lrcAReady: lrcAState?.ready === true,
        lrcAChannelTop: Number.isFinite(Number(lrcAState?.channelTop)) ? Number(lrcAState.channelTop) : null,
        lrcAChannelBottom: Number.isFinite(Number(lrcAState?.channelBottom)) ? Number(lrcAState.channelBottom) : null
      }
    };
  }
  const dailyArea = resolveDailyArea(ioMetrics);
  const areaMid = Number.isFinite(activeArea?.mid) ? activeArea.mid : midPrice;

  const isDirectBias = (h1Trend === 'UP' && midPrice >= areaMid) || (h1Trend === 'DOWN' && midPrice <= areaMid);
  if (h1Trend === 'UP' && midPrice >= areaMid) {
    bias = 'UP';
  } else if (h1Trend === 'DOWN' && midPrice <= areaMid) {
    bias = 'DOWN';
  }
  const biasFallbackUsed = !isDirectBias;
  const biasRoute = `daily:${dailyTrendMeta.source} → h1:${h1TrendMeta.source === 'RANGE_DEFAULT' ? 'RANGE' : h1TrendMeta.source}`;
  const fallbackSources = [];
  if (dailyTrendMeta.usedFallback) fallbackSources.push(dailyTrendMeta.source);
  if (h1TrendMeta.usedFallback) fallbackSources.push(h1TrendMeta.source);
  if (biasFallbackUsed) fallbackSources.push('RANGE_DEFAULT');
  const fallbackSource = fallbackSources.length > 0
    ? Array.from(new Set(fallbackSources)).join(',')
    : 'PRIMARY';
  const fallbackUsed = fallbackSources.length > 0;
  
  // ─────────────────────────
  // zone / side / trend_strength 計算（常時出力）
  // ─────────────────────────
  const sideZone = resolveAreaSideZone(activeArea, midPrice);
  const zone = sideZone.zone;
  const side = sideZone.side;
  
  // trend_strength: bar1h の傾きと形状から判定
  // 仕様: 上位足と方向が揃い、SR 抜け続けているケースで STRONG
  const trend_strength = calculateTrendStrength(lrcAState, bias, tradeConfig);
  
  // ─────────────────────────
  // A出力（Bが評価可能）
  // ─────────────────────────
  return {
    regime: bias,
    regimeLabel: bias,
    dailyBias: dailyTrend,
    dailyStrength: resolveStrengthScore(lrcDState?.normalizedSlope, trend_strength === 'STRONG' ? 0.8 : (trend_strength === 'weak' ? 0.35 : 0.6)),
    h1Bias: h1Trend,
    h1Strength: resolveStrengthScore(lrcAState?.normalizedSlope, trend_strength === 'STRONG' ? 0.8 : (trend_strength === 'weak' ? 0.35 : 0.6)),
    dailyArena: dailyArea,
    arena: activeArea,
    fallbackUsed,
    fallbackSource,
    biasRoute,
    dailyTrendSource: dailyTrendMeta.source,
    h1TrendSource: h1TrendMeta.source,
    biasFallbackUsed,
    allow: true,
    zone: zone,                           // ← 新規追加（常時）
    side: side,                           // ← 新規追加（常時）
    trend_strength: trend_strength,       // ← 新規追加（常時）
    constraints: ioMetrics?.constraints || [],
    reason: `A: normal gate (regime=${bias}, zone=${zone}, trend=${trend_strength})`,
    _gateDiag: { 
      code: 'A_NORMAL',
      c,
      zone,
      positionRatio: sideZone.positionRatio,
      trend_strength,
      arenaSource: activeArea?.source ?? 'unknown'
    }
  };
}

/**
 * zone / side / trend_strength 計算ヘルパー
 */
function calculateTrendStrength(lrcAState, regime, tradeConfig) {
  if (!lrcAState || lrcAState.ready !== true) {
    return 'normal';
  }

  const lrcTrendRaw = lrcAState?.trendState ?? lrcAState?.trend ?? 'RANGE';
  const lrcTrend = String(lrcTrendRaw).toUpperCase();
  const normalizedSlope = Math.abs(Number(lrcAState?.normalizedSlope ?? NaN));
  const thresholdsByLen = tradeConfig?.slopeThresholdsByLen ?? {};
  const thresholdCfg = thresholdsByLen.default ?? { flat: 1, normal: 2 };
  const flatThreshold = Math.max(0.01, Number(thresholdCfg.flat ?? 1));
  const normalThreshold = Math.max(flatThreshold, Number(thresholdCfg.normal ?? 2));
  const isDirectionAligned = (regime === 'UP' && lrcTrend === 'UP') || (regime === 'DOWN' && lrcTrend === 'DOWN');

  if (isDirectionAligned && Number.isFinite(normalizedSlope) && normalizedSlope >= normalThreshold) {
    return 'STRONG';
  }

  if (regime === 'RANGE' || !Number.isFinite(normalizedSlope) || normalizedSlope < flatThreshold) {
    return 'weak';
  }

  return 'normal';
}

/**
 * Aロジック結果の型定義（参考）
 * 
 * AResult = {
 *   regime: 'UP' | 'DOWN' | 'RANGE' | 'NONE',
 *   arena?: { low, high, mid, valid },
 *   allow: boolean,
 *   constraints: string[],
 *   reason: string  // 必ず 'A: ' prefix
 * }
 */
