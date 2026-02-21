import crypto from 'crypto';
import { appendTradeLog } from './tradeLogger.js';
import { notifyLine, checkWinRateMilestones, checkScheduledLineReports } from './lineNotify.js';
import { updateHealth, STAGES } from '../core/healthState.js';
import { getTradeConfig } from '../config/trade.js';
// 市況分類は現状UNKNOWNで保存（後続フェーズで拡張）
const MARKET_STATE_UNKNOWN = 'UNKNOWN';

// STEP3: touchTick, evaluateSafety（拡張禁止）
function touchTick(state) {
  // ループのサイクル時刻のみ記録（市場データ新鮮度判定と分離）
  state.lastLoopAtMs = Date.now();
}

function evaluateSafety(state) {
  const STALE_MS = 5000;
  const now = Date.now();
  
  // ループが回っているか確認（lastLoopAtMs を見る）
  if (state.lastLoopAtMs === null) {
    setSafety(state, 'DEGRADED', 'NO_TICK');
    return;
  }
  
  // 市場データが新鮮か確認（lastMarketAtMs を見る）
  if (state.lastMarketAtMs !== null && now - state.lastMarketAtMs > STALE_MS) {
    setSafety(state, 'HALTED', 'DATA_STALE');
    return;
  }
  
  // 重大状態からの回復: DATA_STALE の場合、lastMarketAtMs が新鮮なら NORMAL に戻る
  const currentStatus = state.safety?.status ?? 'NORMAL';
  const currentReason = state.safety?.reason ?? null;
  
  if (currentStatus === 'HALTED' && currentReason === 'DATA_STALE') {
    // DATA_STALE は市場データが復旧したら NORMAL に戻す。
    setSafety(state, 'NORMAL', null);
    return;
  }
  
  if (currentStatus === 'HALTED' || currentStatus === 'ERROR') {
    // その他の重大状態は継続維持（回復条件なしで即座に NORMAL にしない）
    return;
  }
  
  // それ以外は NORMAL
  setSafety(state, 'NORMAL', null);
}
// ENGINE_*イベントをbridgeEmitter経由で発火する関数
function emitEngineEvent(event, payload) {
  // --- MINA検証用1行ログ出力 ---
  // event: ENGINE_DECISION, ENGINE_POSITION_UPDATE, ENGINE_PNL_UPDATE, ENGINE_ERROR など
  // payload: { decision, reason, positionBefore, positionAfter, realizedPnlBefore, realizedPnlAfter, ... }
  try {
    // ログ出力はENGINE_イベントのみ
    if (typeof event === 'string' && event.startsWith('ENGINE_')) {
      // CODE種別
      let code = event.replace('ENGINE_', '');
      // side
      let side = (payload?.decision?.side ?? payload?.side ?? 'NONE').toString().toUpperCase();
      // reason
      let reason = (payload?.reason ?? '-').toString();
      // position before/after
      let posB = 'NONE', posA = 'NONE';
      if (payload?.positionBefore) {
        posB = (payload.positionBefore.side ? payload.positionBefore.side.toUpperCase() : 'NONE');
      }
      if (payload?.positionAfter) {
        posA = (payload.positionAfter.side ? payload.positionAfter.side.toUpperCase() : 'NONE');
      }
      // pnl before/after
      let pnlB = (payload?.realizedPnlBefore !== undefined) ? Number(payload.realizedPnlBefore).toFixed(2) : '0.00';
      let pnlA = (payload?.realizedPnlAfter !== undefined) ? Number(payload.realizedPnlAfter).toFixed(2) : '0.00';
      // ENTRY/EXIT/PNL/DECISION/HOLD/ERRORなどで見やすく
      const logLine = `[ENGINE] ${code.padEnd(8)}| side=${side.padEnd(4)}| reason=${reason.padEnd(18)}| pos=${posB}->${posA} | pnl=${pnlB}->${pnlA}`;
      console.log(logLine);
    }
    bridgeEmitter.emit(event, payload);
  } catch (err) {
    console.error('[ENGINE] emit event failed', { event }, err);
  }
}
/**
 * engine/update.js
 * TEST Engine の更新ロジック
 * 
 * 目的:
 * - Logic decideTrade() の出力と I/O の MarketState を受け取り
 * - 疑似注文実行とStats更新を行う
 * 
 * 仕様:
 * - v1.0: EXIT後の同ターン新規エントリーなし
 * - realizedPnlPct: 各トレードのpnlPctを単純合算
 * - APR7d: history7d内のpnlPctから年率換算
 */

import { pushTrade, cleanupHistory7d } from './state.js';
import { setSafety } from './safety.js';
import { mapExitReason } from './exitReason.js';
import { ensureRiskGuardState, updateRiskGuardState, evaluatePerformanceGuards } from './performanceGuards.js';
import bridgeEmitter from '../core/bridgeEmitter.js';
import { getInitialCapitalUsd } from '../config/capital.js';

// Bロジックのリビジョンを刻印（再起動で更新される想定）
const BLOGIC_REVISION = process.env.B_LOGIC_REVISION || new Date().toISOString();

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(num, min, max) {
  const n = Number(num);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeBookLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const out = [];
  for (const lv of levels) {
    const price = toFiniteNumber(lv?.price ?? lv?.px ?? lv?.[0], NaN);
    const size = toFiniteNumber(lv?.size ?? lv?.sz ?? lv?.[1], NaN);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    out.push({ price, size, notionalUsd: price * size });
  }
  return out;
}

function sumNotionalInBand(levels, lowPx, highPx) {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  if (!Number.isFinite(lowPx) || !Number.isFinite(highPx) || highPx <= lowPx) return 0;
  let sum = 0;
  for (const lv of levels) {
    if (lv.price < lowPx || lv.price > highPx) continue;
    sum += toFiniteNumber(lv.notionalUsd, 0);
  }
  return sum;
}

function sumNotionalAroundPrice(bids, asks, px, windowUsd) {
  if (!Number.isFinite(px) || px <= 0) return 0;
  const half = Math.max(1, toFiniteNumber(windowUsd, 50));
  const low = px - half;
  const high = px + half;
  return (
    sumNotionalInBand(bids, low, high)
    + sumNotionalInBand(asks, low, high)
  );
}

function resolveDecisionTs(decision) {
  const direct = Number(decision?.timestamp);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const ts = Number(decision?.ts);
  if (Number.isFinite(ts) && ts > 0) return ts;
  return null;
}

function resolvePreEntrySlPx(side, decision, entryPx, tradeConfig) {
  const explicitSlPx = Number(decision?.slPx);
  if (Number.isFinite(explicitSlPx) && explicitSlPx > 0) return explicitSlPx;
  const explicitSlDistance = Number(decision?.slDistanceUsd);
  const tpDistanceUsd = Number(decision?.tpDistanceUsd);
  const slMultiplier = Math.max(0.01, toFiniteNumber(tradeConfig?.sl_multiplier, 0.5));
  const minSlDistanceUsd = Math.max(0, toFiniteNumber(tradeConfig?.min_sl_distance_usd, 40));
  const baseSlDistance = Number.isFinite(explicitSlDistance) && explicitSlDistance > 0
    ? explicitSlDistance
    : (Number.isFinite(tpDistanceUsd) && tpDistanceUsd > 0 ? tpDistanceUsd * slMultiplier : NaN);
  if (!Number.isFinite(baseSlDistance) || baseSlDistance <= 0 || !Number.isFinite(entryPx) || entryPx <= 0) {
    return NaN;
  }
  const slDistanceUsd = Math.max(baseSlDistance, minSlDistanceUsd);
  return side === 'buy' ? (entryPx - slDistanceUsd) : (entryPx + slDistanceUsd);
}

function evaluatePreEntryDepthRecheck({ side, decision, market, tradeConfig, entryPx, nowTs }) {
  const cfg = tradeConfig?.depthRecheck ?? {};
  const modeRaw = String(cfg.mode ?? 'reject').trim().toLowerCase();
  const mode = modeRaw === 'observe_only' ? 'observe_only' : 'reject';
  if (cfg.enabled === false) {
    return { ok: true, diag: null, mode, observeOnly: false };
  }
  const windowUsd = Math.max(1, toFiniteNumber(cfg.windowUsd, 50));
  const minSrNotionalUsd = Math.max(0, toFiniteNumber(cfg.minSrNotionalUsd, 1_000_000));
  const minTpNotionalUsd = Math.max(0, toFiniteNumber(cfg.minTpNotionalUsd, 2_000_000));
  const minSlNotionalUsd = Math.max(0, toFiniteNumber(cfg.minSlNotionalUsd, 1_000_000));
  const tpPx = Number(decision?.tpPx);
  const slPx = resolvePreEntrySlPx(side, decision, entryPx, tradeConfig);
  const bids = normalizeBookLevels(market?.bids);
  const asks = normalizeBookLevels(market?.asks);
  const srDepthUsd = sumNotionalAroundPrice(bids, asks, entryPx, windowUsd);
  const tpDepthUsd = sumNotionalAroundPrice(bids, asks, tpPx, windowUsd);
  const slDepthUsd = sumNotionalAroundPrice(bids, asks, slPx, windowUsd);
  const decisionTs = resolveDecisionTs(decision);
  const elapsedMs = decisionTs ? Math.max(0, nowTs - decisionTs) : null;
  const validTpPx = Number.isFinite(tpPx) && tpPx > 0;
  const validSlPx = Number.isFinite(slPx) && slPx > 0;
  const ok = (
    validTpPx
    && validSlPx
    && srDepthUsd >= minSrNotionalUsd
    && tpDepthUsd >= minTpNotionalUsd
    && slDepthUsd >= minSlNotionalUsd
  );
  const diag = {
    enabled: true,
    mode,
    window_usd: windowUsd,
    entry_px: Number.isFinite(entryPx) ? entryPx : null,
    tp_px: validTpPx ? tpPx : null,
    sl_px: validSlPx ? slPx : null,
    sr_depth: srDepthUsd,
    tp_depth: tpDepthUsd,
    sl_depth: slDepthUsd,
    threshold_sr_depth: minSrNotionalUsd,
    threshold_tp_depth: minTpNotionalUsd,
    threshold_sl_depth: minSlNotionalUsd,
    elapsed_ms: elapsedMs,
    decision_ts: decisionTs,
    checked_ts: nowTs,
    ok
  };
  return { ok, diag, mode, observeOnly: mode === 'observe_only' };
}

function maxNotionalBetween(levels, lowPx, highPx) {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  if (!Number.isFinite(lowPx) || !Number.isFinite(highPx) || highPx <= lowPx) return 0;
  let maxNotional = 0;
  for (const lv of levels) {
    if (lv.price < lowPx || lv.price > highPx) continue;
    const n = toFiniteNumber(lv.notionalUsd, 0);
    if (n > maxNotional) maxNotional = n;
  }
  return maxNotional;
}

function sumClosestNotional(levels, midPx, topN) {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  if (!Number.isFinite(midPx) || midPx <= 0) return 0;
  const n = Math.max(1, Math.floor(toFiniteNumber(topN, 8)));
  return levels
    .map(lv => ({ ...lv, dist: Math.abs(lv.price - midPx) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n)
    .reduce((acc, lv) => acc + toFiniteNumber(lv.notionalUsd, 0), 0);
}

function createDepthExitState(prev = null) {
  const src = (prev && typeof prev === 'object') ? prev : {};
  return {
    shieldStreak: Math.max(0, Math.floor(toFiniteNumber(src.shieldStreak, 0))),
    wallStreak: Math.max(0, Math.floor(toFiniteNumber(src.wallStreak, 0))),
    flowStreak: Math.max(0, Math.floor(toFiniteNumber(src.flowStreak, 0))),
    flowTpStreak: Math.max(0, Math.floor(toFiniteNumber(src.flowTpStreak, 0))),
    burstStreak: Math.max(0, Math.floor(toFiniteNumber(src.burstStreak, 0))),
    driftStreak: Math.max(0, Math.floor(toFiniteNumber(src.driftStreak, 0))),
    lastSignal: src.lastSignal ? String(src.lastSignal) : null,
    lastSignalAt: Number.isFinite(Number(src.lastSignalAt)) ? Number(src.lastSignalAt) : null
  };
}

function resolveTradeFlowWindow(market, cfgWindowMs = 30000, cfgMinTrades = 8) {
  const flow = market?.tradeFlow;
  const defaultOut = {
    available: false,
    adequateSample: false,
    windowMs: Math.max(1000, Math.floor(toFiniteNumber(cfgWindowMs, 30000))),
    minTrades: Math.max(1, Math.floor(toFiniteNumber(cfgMinTrades, 8))),
    tradeCount: 0,
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    flowPressure: 0,
    acceleration: 0,
    largeTradeCount: 0,
    adverseRatioLong: 0,
    adverseRatioShort: 0
  };
  if (!flow || typeof flow !== 'object') return defaultOut;
  const windowMs = Math.max(1000, Math.floor(toFiniteNumber(cfgWindowMs, toFiniteNumber(flow?.windowMs, 30000))));
  const minTrades = Math.max(1, Math.floor(toFiniteNumber(cfgMinTrades, toFiniteNumber(flow?.minTradesForSignal, 8))));
  const windows = flow?.windows ?? {};
  const bucket = windows[String(windowMs)] ?? windows[windowMs] ?? null;
  const tradeCount = Math.max(0, Math.floor(toFiniteNumber(bucket?.tradeCount, toFiniteNumber(flow?.tradeCount, 0))));
  const buyVolumeUsd = Math.max(0, toFiniteNumber(bucket?.buyVolumeUsd, toFiniteNumber(flow?.buyVolumeUsd, 0)));
  const sellVolumeUsd = Math.max(0, toFiniteNumber(bucket?.sellVolumeUsd, toFiniteNumber(flow?.sellVolumeUsd, 0)));
  const flowPressure = toFiniteNumber(bucket?.flowPressure, toFiniteNumber(flow?.flowPressure, 0));
  const acceleration = toFiniteNumber(bucket?.acceleration, toFiniteNumber(flow?.acceleration, 0));
  const largeTradeCount = Math.max(0, Math.floor(toFiniteNumber(bucket?.largeTradeCount, toFiniteNumber(flow?.largeTradeCount, 0))));
  const adverseRatioLong = sellVolumeUsd / Math.max(1, buyVolumeUsd);
  const adverseRatioShort = buyVolumeUsd / Math.max(1, sellVolumeUsd);
  return {
    available: true,
    adequateSample: tradeCount >= minTrades,
    windowMs,
    minTrades,
    tradeCount,
    buyVolumeUsd,
    sellVolumeUsd,
    flowPressure,
    acceleration,
    largeTradeCount,
    adverseRatioLong,
    adverseRatioShort
  };
}

function evaluateFlowAdaptiveTakeProfit(pos, market, tradeConfig, context = {}) {
  const out = { hit: false, diag: null };
  const root = tradeConfig?.flowAdaptiveExit ?? {};
  if (root.enabled === false) return out;
  const cfg = root.earlyTakeProfit ?? {};
  if (cfg.enabled !== true) return out;
  const isLong = pos?.side === 'buy';
  if (!isLong && pos?.side !== 'sell') return out;
  const holdMs = Math.max(0, toFiniteNumber(context.holdMs, 0));
  const tpProgressRatio = toFiniteNumber(context.tpProgressRatio, 0);
  const unrealizedUsd = toFiniteNumber(context.unrealizedUsd, 0);
  const minHoldMs = Math.max(0, Math.floor(toFiniteNumber(cfg.minHoldMs, 8000)));
  const minProgress = clamp(toFiniteNumber(cfg.minProgress, 0.30), 0.01, 1.2);
  const accelMinProgress = clamp(toFiniteNumber(cfg.accelMinProgress, 0.50), minProgress, 1.5);
  const minProfitUsd = Math.max(0, toFiniteNumber(cfg.minProfitUsd, 0.2));
  if (holdMs < minHoldMs || tpProgressRatio < minProgress || unrealizedUsd < minProfitUsd) return out;
  const flow = resolveTradeFlowWindow(
    market,
    toFiniteNumber(cfg.windowMs, 30000),
    toFiniteNumber(cfg.minTrades, 8)
  );
  if (!flow.available || !flow.adequateSample) {
    out.diag = {
      signal: 'flow_adaptive_take_profit',
      skipped: 'insufficient_trade_flow_sample',
      holdMs,
      tpProgressRatio,
      unrealizedUsd,
      tradeCount: flow.tradeCount,
      minTrades: flow.minTrades
    };
    return out;
  }
  const hostileRatioLong = Math.max(1.01, toFiniteNumber(cfg.hostileRatioLong, 1.18));
  const hostileRatioShort = Math.max(1.01, toFiniteNumber(cfg.hostileRatioShort, 1.18));
  const accelDecayThreshold = toFiniteNumber(cfg.accelDecayThreshold, -0.30);
  const accelAdverseRatioMin = Math.max(1.0, toFiniteNumber(cfg.accelAdverseRatioMin, 1.02));
  const adverseRatio = isLong ? flow.adverseRatioLong : flow.adverseRatioShort;
  const ratioThreshold = isLong ? hostileRatioLong : hostileRatioShort;
  const hostileByRatio = adverseRatio >= ratioThreshold;
  const hostileByDecay = tpProgressRatio >= accelMinProgress
    && flow.acceleration <= accelDecayThreshold
    && adverseRatio >= accelAdverseRatioMin;
  if (hostileByRatio || hostileByDecay) {
    out.hit = true;
  }
  out.diag = {
    signal: 'flow_adaptive_take_profit',
    flowWindowMs: flow.windowMs,
    flowTradeCount: flow.tradeCount,
    adverseRatio,
    ratioThreshold,
    flowPressure: flow.flowPressure,
    acceleration: flow.acceleration,
    accelDecayThreshold,
    accelAdverseRatioMin,
    hostileByRatio,
    hostileByDecay,
    holdMs,
    tpProgressRatio,
    unrealizedUsd
  };
  return out;
}

function evaluateMicroTradeBurstExit(pos, market, tradeConfig, context = {}) {
  const out = { hit: false, diag: null };
  const root = tradeConfig?.flowAdaptiveExit ?? {};
  if (root.enabled === false) return out;
  const cfg = root.burstExit ?? {};
  if (cfg.enabled !== true) return out;
  const isLong = pos?.side === 'buy';
  if (!isLong && pos?.side !== 'sell') return out;
  const holdMs = Math.max(0, toFiniteNumber(context.holdMs, 0));
  const unrealizedUsd = toFiniteNumber(context.unrealizedUsd, 0);
  const minHoldMs = Math.max(0, Math.floor(toFiniteNumber(cfg.minHoldMs, 5000)));
  const maxLossUsd = Math.max(0, toFiniteNumber(cfg.maxLossUsd, 0.5));
  if (holdMs < minHoldMs || unrealizedUsd < (-maxLossUsd)) return out;
  const flow = market?.tradeFlow;
  const windows = flow?.windows ?? {};
  const w5 = windows['5000'] ?? windows[5000] ?? null;
  const w60 = windows['60000'] ?? windows[60000] ?? null;
  const tradeCount5 = Math.max(0, Math.floor(toFiniteNumber(w5?.tradeCount, 0)));
  const tradeCount60 = Math.max(0, Math.floor(toFiniteNumber(w60?.tradeCount, 0)));
  const minTrades5 = Math.max(1, Math.floor(toFiniteNumber(cfg.minTrades5s, 3)));
  const minTrades60 = Math.max(minTrades5, Math.floor(toFiniteNumber(cfg.minTrades60s, 10)));
  if (tradeCount5 < minTrades5 || tradeCount60 < minTrades60) {
    out.diag = {
      signal: 'burst_adverse_exit',
      skipped: 'insufficient_trade_flow_sample',
      tradeCount5,
      tradeCount60,
      minTrades5,
      minTrades60,
      holdMs,
      unrealizedUsd
    };
    return out;
  }
  const rate5 = Math.max(0, toFiniteNumber(w5?.tradeRatePerSec, 0));
  const rate60 = Math.max(0, toFiniteNumber(w60?.tradeRatePerSec, 0));
  const rateRatio = rate60 > 0 ? (rate5 / rate60) : 0;
  const minRateRatio = Math.max(1.0, toFiniteNumber(cfg.minRateRatio, 4.0));
  const minAdverseFlowPressure = clamp(toFiniteNumber(cfg.minAdverseFlowPressure, 0.3), 0.05, 0.95);
  const flowPressure5 = toFiniteNumber(w5?.flowPressure, 0);
  const isAdverseBurst = isLong
    ? (flowPressure5 <= -minAdverseFlowPressure)
    : (flowPressure5 >= minAdverseFlowPressure);
  out.hit = rateRatio >= minRateRatio && isAdverseBurst;
  out.diag = {
    signal: 'burst_adverse_exit',
    rate5,
    rate60,
    rateRatio,
    minRateRatio,
    flowPressure5,
    minAdverseFlowPressure,
    isAdverseBurst,
    tradeCount5,
    tradeCount60,
    holdMs,
    unrealizedUsd,
    maxLossUsd
  };
  return out;
}

function resolveFlowLossTightening(pos, market, tradeConfig, context = {}) {
  const out = {
    applied: false,
    softMul: 1,
    hardMul: 1,
    diag: null
  };
  const root = tradeConfig?.flowAdaptiveExit ?? {};
  if (root.enabled === false) return out;
  const cfg = root.lossTightening ?? {};
  if (cfg.enabled !== true) return out;
  const isLong = pos?.side === 'buy';
  if (!isLong && pos?.side !== 'sell') return out;
  const holdMs = Math.max(0, toFiniteNumber(context.holdMs, 0));
  const minHoldMs = Math.max(0, Math.floor(toFiniteNumber(cfg.minHoldMs, 5000)));
  if (holdMs < minHoldMs) return out;
  const flow = resolveTradeFlowWindow(
    market,
    toFiniteNumber(cfg.windowMs, 30000),
    toFiniteNumber(cfg.minTrades, 8)
  );
  if (!flow.available || !flow.adequateSample) return out;
  const hostileRatioLong = Math.max(1.01, toFiniteNumber(cfg.hostileRatioLong, 1.30));
  const hostileRatioShort = Math.max(1.01, toFiniteNumber(cfg.hostileRatioShort, 1.30));
  const adverseRatio = isLong ? flow.adverseRatioLong : flow.adverseRatioShort;
  const hostileRatioThreshold = isLong ? hostileRatioLong : hostileRatioShort;
  const hostileLargeTrades = Math.max(0, Math.floor(toFiniteNumber(cfg.hostileLargeTrades, 2)));
  const hasHostileLarge = hostileLargeTrades > 0 ? flow.largeTradeCount >= hostileLargeTrades : false;
  const hostileByFlow = adverseRatio >= hostileRatioThreshold || hasHostileLarge;
  if (!hostileByFlow) return out;
  out.applied = true;
  out.softMul = clamp(toFiniteNumber(cfg.softRatioMul, 0.85), 0.3, 1.0);
  out.hardMul = clamp(toFiniteNumber(cfg.hardRatioMul, 0.75), 0.3, 1.0);
  out.diag = {
    signal: 'flow_loss_tightening',
    flowWindowMs: flow.windowMs,
    flowTradeCount: flow.tradeCount,
    flowPressure: flow.flowPressure,
    adverseRatio,
    hostileRatioThreshold,
    largeTradeCount: flow.largeTradeCount,
    hostileLargeTrades,
    softMul: out.softMul,
    hardMul: out.hardMul
  };
  return out;
}

function resolveHoldingPressureAdjustments(pos, market, tradeConfig) {
  const out = {
    applied: false,
    timeoutMul: 1,
    softMul: 1,
    hardMul: 1,
    diag: null
  };
  const root = tradeConfig?.flowAdaptiveExit ?? {};
  if (root.enabled === false) return out;
  const cfg = root.holdingPressure ?? {};
  if (cfg.enabled !== true) return out;
  const isLong = pos?.side === 'buy';
  if (!isLong && pos?.side !== 'sell') return out;
  const funding = toFiniteNumber(market?.funding, NaN);
  const premiumRaw = toFiniteNumber(market?.premium, NaN);
  const oraclePx = toFiniteNumber(market?.oraclePx, NaN);
  const markPx = toFiniteNumber(market?.markPx, NaN);
  const premium = Number.isFinite(premiumRaw)
    ? premiumRaw
    : (Number.isFinite(oraclePx) && oraclePx > 0 && Number.isFinite(markPx))
      ? ((markPx - oraclePx) / oraclePx)
      : NaN;
  const fundingHostileLong = Math.max(0, toFiniteNumber(cfg.fundingHostileLong, 0.0003));
  const fundingHostileShort = Math.max(0, toFiniteNumber(cfg.fundingHostileShort, 0.0003));
  const premiumHostileLong = Math.max(0, toFiniteNumber(cfg.premiumHostileLong, 0.0005));
  const premiumHostileShort = Math.max(0, toFiniteNumber(cfg.premiumHostileShort, 0.0005));
  const fundingHostile = isLong
    ? (Number.isFinite(funding) && funding >= fundingHostileLong)
    : (Number.isFinite(funding) && funding <= -fundingHostileShort);
  const premiumHostile = isLong
    ? (Number.isFinite(premium) && premium >= premiumHostileLong)
    : (Number.isFinite(premium) && premium <= -premiumHostileShort);
  if (!fundingHostile && !premiumHostile) return out;
  out.applied = true;
  out.timeoutMul = clamp(toFiniteNumber(cfg.timeoutMul, 0.85), 0.4, 1.0);
  out.softMul = clamp(toFiniteNumber(cfg.softRatioMul, 0.90), 0.4, 1.0);
  out.hardMul = clamp(toFiniteNumber(cfg.hardRatioMul, 0.90), 0.4, 1.0);
  out.diag = {
    signal: 'holding_pressure',
    funding,
    premium,
    fundingHostile,
    premiumHostile,
    timeoutMul: out.timeoutMul,
    softMul: out.softMul,
    hardMul: out.hardMul
  };
  return out;
}

function resolveEntryQualityRoutingAdjustments(pos, tradeConfig) {
  const out = {
    applied: false,
    timeoutMul: 1,
    softMul: 1,
    hardMul: 1,
    profile: 'neutral',
    diag: null
  };
  const root = tradeConfig?.flowAdaptiveExit ?? {};
  if (root.enabled === false) return out;
  const cfg = root.entryQualityRouting ?? {};
  if (cfg.enabled !== true) return out;
  const entryQualityScore = toFiniteNumber(pos?.entryContext?.entryQualityScore, NaN);
  if (!Number.isFinite(entryQualityScore)) {
    out.diag = {
      signal: 'entry_quality_routing',
      skipped: 'entry_quality_missing'
    };
    return out;
  }
  const highThreshold = clamp(toFiniteNumber(cfg.highThreshold, 0.70), 0.3, 0.95);
  const lowThreshold = clamp(toFiniteNumber(cfg.lowThreshold, 0.40), 0.1, highThreshold);
  if (entryQualityScore >= highThreshold) {
    out.applied = true;
    out.profile = 'high';
    out.timeoutMul = clamp(toFiniteNumber(cfg.highTimeoutMul, 1.20), 0.5, 4.0);
    out.softMul = clamp(toFiniteNumber(cfg.highSoftMul, 1.15), 0.5, 2.0);
    out.hardMul = clamp(toFiniteNumber(cfg.highHardMul, 1.10), 0.5, 2.0);
  } else if (entryQualityScore < lowThreshold) {
    out.applied = true;
    out.profile = 'low';
    out.timeoutMul = clamp(toFiniteNumber(cfg.lowTimeoutMul, 0.75), 0.3, 1.0);
    out.softMul = clamp(toFiniteNumber(cfg.lowSoftMul, 0.80), 0.3, 1.0);
    out.hardMul = clamp(toFiniteNumber(cfg.lowHardMul, 0.85), 0.3, 1.0);
  }
  out.diag = {
    signal: 'entry_quality_routing',
    profile: out.profile,
    applied: out.applied,
    entryQualityScore,
    highThreshold,
    lowThreshold,
    timeoutMul: out.timeoutMul,
    softMul: out.softMul,
    hardMul: out.hardMul
  };
  return out;
}

function resolveDecisionRegime(decision) {
  const raw = (
    decision?.context?.bResult?.regime
    ?? decision?.context?.aResult?.regime
    ?? decision?.state
    ?? null
  );
  const regime = String(raw ?? '').toUpperCase();
  return (regime === 'UP' || regime === 'DOWN' || regime === 'RANGE') ? regime : null;
}

function resolveDecisionMapStrength(decision) {
  const direct = toFiniteNumber(decision?.phase1?.srClusters?.mapStrength, NaN);
  if (Number.isFinite(direct)) return direct;
  const fromCtx = toFiniteNumber(decision?.context?.bResult?.phase1?.srClusters?.mapStrength, NaN);
  if (Number.isFinite(fromCtx)) return fromCtx;
  return NaN;
}

function resolveEnvironmentDriftAdjustments(pos, decision, market, tradeConfig, context = {}) {
  const out = {
    applied: false,
    hit: false,
    timeoutMul: 1,
    softMul: 1,
    hardMul: 1,
    driftScore: 0,
    diag: null
  };
  const root = tradeConfig?.flowAdaptiveExit ?? {};
  if (root.enabled === false) return out;
  const cfg = root.environmentDrift ?? {};
  if (cfg.enabled !== true) return out;
  const holdMs = Math.max(0, toFiniteNumber(context.holdMs, 0));
  const unrealizedUsd = toFiniteNumber(context.unrealizedUsd, 0);
  const minHoldMs = Math.max(0, Math.floor(toFiniteNumber(cfg.minHoldMs, 10000)));
  if (holdMs < minHoldMs) return out;

  const regimeWeight = Math.max(0, toFiniteNumber(cfg.regimeWeight, 0.45));
  const mapWeight = Math.max(0, toFiniteNumber(cfg.mapWeight, 0.35));
  const flowWeight = Math.max(0, toFiniteNumber(cfg.flowWeight, 0.25));
  const mapDropRatio = clamp(toFiniteNumber(cfg.mapDropRatio, 0.65), 0.05, 0.99);
  const flowHostilePressure = clamp(toFiniteNumber(cfg.flowHostilePressure, 0.25), 0.05, 0.95);
  const tightenScore = Math.max(0.05, toFiniteNumber(cfg.tightenScore, 0.35));
  const exitScore = Math.max(tightenScore, toFiniteNumber(cfg.exitScore, 0.70));
  const maxLossUsd = Math.max(0, toFiniteNumber(cfg.maxLossUsd, 0.8));

  const entryRegime = String(pos?.entryContext?.marketRegime ?? '').toUpperCase();
  const currentRegime = resolveDecisionRegime(decision);
  const validEntryRegime = entryRegime === 'UP' || entryRegime === 'DOWN' || entryRegime === 'RANGE';
  const regimeShift = validEntryRegime && !!currentRegime && currentRegime !== entryRegime;

  const entryMapStrength = toFiniteNumber(pos?.entryContext?.mapStrength, NaN);
  const currentMapStrength = resolveDecisionMapStrength(decision);
  const mapRatio = (Number.isFinite(entryMapStrength) && entryMapStrength > 0 && Number.isFinite(currentMapStrength))
    ? (currentMapStrength / entryMapStrength)
    : NaN;
  const mapDropped = Number.isFinite(mapRatio) && mapRatio <= mapDropRatio;

  const flow = resolveTradeFlowWindow(
    market,
    toFiniteNumber(cfg.flowWindowMs, 30000),
    toFiniteNumber(cfg.flowMinTrades, 8)
  );
  const alignedFlowPressure = (pos?.side === 'buy') ? flow.flowPressure : -flow.flowPressure;
  const hostileFlow = flow.available && flow.adequateSample && alignedFlowPressure <= (-flowHostilePressure);

  let driftScore = 0;
  if (regimeShift) driftScore += regimeWeight;
  if (mapDropped) driftScore += mapWeight;
  if (hostileFlow) driftScore += flowWeight;
  out.driftScore = driftScore;
  if (driftScore >= tightenScore) {
    out.applied = true;
    out.timeoutMul = clamp(toFiniteNumber(cfg.tightenTimeoutMul, 0.70), 0.3, 1.0);
    out.softMul = clamp(toFiniteNumber(cfg.tightenSoftMul, 0.85), 0.3, 1.0);
    out.hardMul = clamp(toFiniteNumber(cfg.tightenHardMul, 0.88), 0.3, 1.0);
  }
  if (driftScore >= exitScore && unrealizedUsd >= (-maxLossUsd)) {
    out.hit = true;
  }
  out.diag = {
    signal: 'environment_drift',
    holdMs,
    unrealizedUsd,
    driftScore,
    tightenScore,
    exitScore,
    maxLossUsd,
    entryRegime: validEntryRegime ? entryRegime : null,
    currentRegime,
    regimeShift,
    entryMapStrength: Number.isFinite(entryMapStrength) ? entryMapStrength : null,
    currentMapStrength: Number.isFinite(currentMapStrength) ? currentMapStrength : null,
    mapRatio: Number.isFinite(mapRatio) ? mapRatio : null,
    mapDropRatio,
    mapDropped,
    flowWindowMs: flow.windowMs,
    flowTradeCount: flow.tradeCount,
    flowAdequateSample: flow.adequateSample,
    alignedFlowPressure,
    flowHostilePressure,
    hostileFlow,
    timeoutMul: out.timeoutMul,
    softMul: out.softMul,
    hardMul: out.hardMul,
    applied: out.applied,
    hit: out.hit
  };
  return out;
}

function buildDepthExitAnchor(side, market, decision, tradeConfig) {
  const cfg = tradeConfig?.depthAwareExit ?? {};
  if (cfg.enabled !== true) return null;
  const shieldCfg = cfg.shield ?? {};
  if (shieldCfg.enabled !== true) return null;
  const bandUsd = Math.max(10, toFiniteNumber(shieldCfg.entryBandUsd, 120));
  const bids = normalizeBookLevels(market?.bids);
  const asks = normalizeBookLevels(market?.asks);
  const supportPrice = toFiniteNumber(
    decision?.supportPrice ?? decision?.context?.bResult?.supportPrice,
    NaN
  );
  const resistancePrice = toFiniteNumber(
    decision?.resistancePrice ?? decision?.context?.bResult?.resistancePrice,
    NaN
  );
  if (side === 'buy') {
    const ref = Number.isFinite(supportPrice)
      ? supportPrice
      : toFiniteNumber(decision?.midPrice, NaN) - bandUsd;
    if (!Number.isFinite(ref)) return null;
    const baseline = sumNotionalInBand(bids, ref, ref + bandUsd);
    return {
      side,
      shieldRefPrice: ref,
      shieldBandUsd: bandUsd,
      shieldBaselineUsd: baseline,
      createdAt: Date.now()
    };
  }
  const ref = Number.isFinite(resistancePrice)
    ? resistancePrice
    : toFiniteNumber(decision?.midPrice, NaN) + bandUsd;
  if (!Number.isFinite(ref)) return null;
  const baseline = sumNotionalInBand(asks, ref - bandUsd, ref);
  return {
    side,
    shieldRefPrice: ref,
    shieldBandUsd: bandUsd,
    shieldBaselineUsd: baseline,
    createdAt: Date.now()
  };
}

function evaluateDepthAwareSignals(pos, market, tradeConfig, context = {}) {
  const cfg = tradeConfig?.depthAwareExit ?? {};
  const empty = {
    shield: { hit: false, diag: null },
    wallAhead: { hit: false, diag: null },
    flowImbalance: { hit: false, diag: null }
  };
  if (cfg.enabled !== true) return empty;
  const side = pos?.side;
  if (side !== 'buy' && side !== 'sell') return empty;
  const isLong = side === 'buy';
  const midPx = toFiniteNumber(market?.midPx, NaN);
  if (!Number.isFinite(midPx) || midPx <= 0) return empty;
  const bids = normalizeBookLevels(market?.bids);
  const asks = normalizeBookLevels(market?.asks);
  if (bids.length === 0 || asks.length === 0) return empty;

  const holdMs = Math.max(0, toFiniteNumber(context.holdMs, 0));
  const tpProgressRatio = toFiniteNumber(context.tpProgressRatio, 0);
  const unrealizedUsd = toFiniteNumber(context.unrealizedUsd, 0);
  const spreadBps = Math.max(0, toFiniteNumber(market?.spreadBps, 0));

  const shieldCfg = cfg.shield ?? {};
  if (shieldCfg.enabled === true && pos?.depthExitAnchor) {
    const minHoldMs = Math.max(0, toFiniteNumber(shieldCfg.minHoldMs, 5000));
    const minBaselineUsd = Math.max(0, toFiniteNumber(shieldCfg.minBaselineUsd, 50000));
    const collapseRatio = clamp(toFiniteNumber(shieldCfg.collapseRatio, 0.45), 0.05, 0.95);
    const bandUsd = Math.max(
      10,
      toFiniteNumber(shieldCfg.compareBandUsd, pos?.depthExitAnchor?.shieldBandUsd ?? 120)
    );
    const ref = toFiniteNumber(pos?.depthExitAnchor?.shieldRefPrice, NaN);
    const baseline = Math.max(0, toFiniteNumber(pos?.depthExitAnchor?.shieldBaselineUsd, 0));
    if (holdMs >= minHoldMs && Number.isFinite(ref) && baseline >= minBaselineUsd) {
      const currentShield = isLong
        ? sumNotionalInBand(bids, ref, ref + bandUsd)
        : sumNotionalInBand(asks, ref - bandUsd, ref);
      if (currentShield <= baseline * collapseRatio) {
        empty.shield.hit = true;
      }
      empty.shield.diag = {
        signal: 'shield_collapse',
        baselineUsd: baseline,
        currentUsd: currentShield,
        collapseRatio
      };
    }
  }

  const wallCfg = cfg.wallAhead ?? {};
  if (wallCfg.enabled === true) {
    const minProgress = clamp(toFiniteNumber(wallCfg.fromProgress, 0.10), -0.2, 1.2);
    const maxProgress = clamp(toFiniteNumber(wallCfg.maxProgress, 0.90), minProgress, 1.5);
    const minProfitUsd = Math.max(0, toFiniteNumber(wallCfg.minProfitUsd, 0.2));
    const minWallUsd = Math.max(0, toFiniteNumber(wallCfg.minWallUsd, 70000));
    const minWallVsNear = Math.max(0, toFiniteNumber(wallCfg.minWallVsNearRatio, 1.4));
    const nearLevels = Math.max(1, Math.floor(toFiniteNumber(wallCfg.nearLevels, 8)));
    const ratioMin = clamp(toFiniteNumber(wallCfg.lookaheadRatioMin, 0.2), 0.01, 0.99);
    const ratioMax = clamp(toFiniteNumber(wallCfg.lookaheadRatioMax, 0.85), ratioMin, 1.5);
    const tpPx = toFiniteNumber(pos?.tpPx, NaN);
    if (
      Number.isFinite(tpPx) &&
      ((isLong && tpPx > midPx) || (!isLong && tpPx < midPx)) &&
      tpProgressRatio >= minProgress &&
      tpProgressRatio <= maxProgress &&
      unrealizedUsd >= minProfitUsd
    ) {
      const dist = Math.abs(tpPx - midPx);
      const nearPx = isLong ? (midPx + dist * ratioMin) : (midPx - dist * ratioMin);
      const farPx = isLong ? (midPx + dist * ratioMax) : (midPx - dist * ratioMax);
      const lowPx = Math.min(nearPx, farPx);
      const highPx = Math.max(nearPx, farPx);
      const opposing = isLong ? asks : bids;
      const wallNotional = maxNotionalBetween(opposing, lowPx, highPx);
      const nearNotional = sumClosestNotional(opposing, midPx, nearLevels);
      const wallVsNear = wallNotional / Math.max(1, nearNotional / nearLevels);
      if (wallNotional >= minWallUsd && wallVsNear >= minWallVsNear) {
        empty.wallAhead.hit = true;
      }
      empty.wallAhead.diag = {
        signal: 'wall_ahead',
        wallNotionalUsd: wallNotional,
        nearNotionalUsd: nearNotional,
        wallVsNear,
        minWallUsd,
        minWallVsNear,
        window: [lowPx, highPx]
      };
    }
  }

  const flowCfg = cfg.flowImbalance ?? {};
  if (flowCfg.enabled === true) {
    const minHoldMs = Math.max(0, toFiniteNumber(flowCfg.minHoldMs, 10000));
    const minProgress = clamp(toFiniteNumber(flowCfg.minProgress, 0.05), -0.2, 1.2);
    const minProfitUsd = Math.max(0, toFiniteNumber(flowCfg.minProfitUsd, 0.15));
    const maxSpreadBps = Math.max(0.05, toFiniteNumber(flowCfg.maxSpreadBps, 1.2));
    const topLevels = Math.max(1, Math.floor(toFiniteNumber(flowCfg.topLevels, 8)));
    const thLong = Math.max(1.01, toFiniteNumber(flowCfg.adverseRatioThresholdLong, 1.35));
    const thShort = Math.max(1.01, toFiniteNumber(flowCfg.adverseRatioThresholdShort, 1.35));
    if (holdMs >= minHoldMs && tpProgressRatio >= minProgress && unrealizedUsd >= minProfitUsd && spreadBps <= maxSpreadBps) {
      const useTradeFlow = flowCfg.useTradeFlow !== false;
      const tradeFlowWindowMs = Math.max(1000, Math.floor(toFiniteNumber(flowCfg.tradeFlowWindowMs, 30000)));
      const tradeFlowMinTrades = Math.max(1, Math.floor(toFiniteNumber(flowCfg.tradeFlowMinTrades, 8)));
      const fallbackToBook = flowCfg.fallbackToBook !== false;

      let source = 'none';
      let buyNear = 0;
      let sellNear = 0;
      let tradeCount = null;
      const flowState = market?.tradeFlow ?? null;
      if (useTradeFlow && flowState && typeof flowState === 'object') {
        const windows = flowState?.windows ?? {};
        const bucket = windows[String(tradeFlowWindowMs)] ?? windows[tradeFlowWindowMs] ?? null;
        const windowTradeCount = Math.max(
          0,
          Math.floor(toFiniteNumber(bucket?.tradeCount, flowState?.tradeCount))
        );
        if (windowTradeCount >= tradeFlowMinTrades) {
          buyNear = Math.max(0, toFiniteNumber(bucket?.buyVolumeUsd, flowState?.buyVolumeUsd));
          sellNear = Math.max(0, toFiniteNumber(bucket?.sellVolumeUsd, flowState?.sellVolumeUsd));
          tradeCount = windowTradeCount;
          source = 'trade_flow';
        }
      }
      if (source !== 'trade_flow' && fallbackToBook) {
        buyNear = sumClosestNotional(bids, midPx, topLevels);
        sellNear = sumClosestNotional(asks, midPx, topLevels);
        source = 'book_depth';
      }

      const longPressure = sellNear / Math.max(1, buyNear);
      const shortPressure = buyNear / Math.max(1, sellNear);
      const adverseRatio = isLong ? longPressure : shortPressure;
      const threshold = isLong ? thLong : thShort;
      if (adverseRatio >= threshold) {
        empty.flowImbalance.hit = true;
      }
      empty.flowImbalance.diag = {
        signal: 'flow_imbalance',
        adverseRatio,
        threshold,
        source,
        flowBuyNotionalUsd: buyNear,
        flowSellNotionalUsd: sellNear,
        flowTradeCount: tradeCount,
        tradeFlowWindowMs: source === 'trade_flow' ? tradeFlowWindowMs : null,
        tradeFlowMinTrades: source === 'trade_flow' ? tradeFlowMinTrades : null,
        topLevels,
        spreadBps
      };
    }
  }

  return empty;
}

function resolveDynamicLossParams(base, market, state, pos, lossTimeoutCfg) {
  const dyn = lossTimeoutCfg?.dynamicRealtime || {};
  const enabled = dyn.enabled !== false;
  if (!enabled) {
    return {
      timeoutMs: base.timeoutMs,
      softRatio: base.softRatio,
      hardRatio: base.hardRatio
    };
  }
  const midPx = toFiniteNumber(market?.midPx, 0);
  const bestBidPx = toFiniteNumber(market?.bestBidPx ?? market?.bestBid, NaN);
  const bestAskPx = toFiniteNumber(market?.bestAskPx ?? market?.bestAsk, NaN);
  const spreadBpsRaw = toFiniteNumber(market?.spreadBps, NaN);
  const spreadBps = Number.isFinite(spreadBpsRaw)
    ? Math.max(0, spreadBpsRaw)
    : (midPx > 0 && Number.isFinite(bestBidPx) && Number.isFinite(bestAskPx))
      ? Math.max(0, ((bestAskPx - bestBidPx) / midPx) * 10000)
      : 0;
  const velocityBpsRaw = toFiniteNumber(market?.priceVelocityBps, NaN);
  const velocityBps = Number.isFinite(velocityBpsRaw)
    ? Math.abs(velocityBpsRaw)
    : (() => {
      const prev = toFiniteNumber(state?.stats?.prevMidPx, NaN);
      return (midPx > 0 && Number.isFinite(prev))
        ? Math.abs((midPx - prev) / midPx) * 10000
        : 0;
    })();
  const cShock = Math.abs(toFiniteNumber(market?.cShock, 0));
  const regime = String(pos?.entryContext?.marketRegime || '').toUpperCase();

  let timeoutMul = 1;
  let softMul = 1;
  let hardMul = 1;
  const rangeLike = regime === 'RANGE';
  const trendLike = regime === 'UP' || regime === 'DOWN';
  if (rangeLike) {
    timeoutMul *= clamp(dyn.rangeTimeoutMul, 0.5, 1.5);
    softMul *= clamp(dyn.rangeSoftMul, 0.6, 1.4);
    hardMul *= clamp(dyn.rangeHardMul, 0.6, 1.4);
  } else if (trendLike) {
    timeoutMul *= clamp(dyn.trendTimeoutMul, 0.5, 1.5);
    softMul *= clamp(dyn.trendSoftMul, 0.6, 1.4);
    hardMul *= clamp(dyn.trendHardMul, 0.6, 1.4);
  }
  const maxSpreadBps = Math.max(0.1, toFiniteNumber(dyn.maxSpreadBps, 1.0));
  const maxVelocityBps = Math.max(0.1, toFiniteNumber(dyn.maxVelocityBps, 1.2));
  const maxCShock = Math.max(0.05, toFiniteNumber(dyn.maxCShock, 0.25));
  const stressTimeoutMul = clamp(dyn.stressTimeoutMul, 0.4, 1.2);
  const stressSoftMul = clamp(dyn.stressSoftMul, 0.5, 1.2);
  const stressHardMul = clamp(dyn.stressHardMul, 0.5, 1.2);
  const stressed = spreadBps > maxSpreadBps || velocityBps > maxVelocityBps || cShock > maxCShock;
  if (stressed) {
    timeoutMul *= stressTimeoutMul;
    softMul *= stressSoftMul;
    hardMul *= stressHardMul;
  }

  // TP距離に応じたtimeout補正（小さめブレンドで段階導入）
  let timeoutBaseMs = toFiniteNumber(base.timeoutMs, 0);
  const proportionalCfg = lossTimeoutCfg?.proportional || {};
  if (proportionalCfg.enabled === true) {
    const tpDistanceUsd = Math.abs(toFiniteNumber(pos?.tpDistanceUsd, 0));
    if (tpDistanceUsd > 0) {
      const msPerUsd = clamp(toFiniteNumber(proportionalCfg.msPerUsd, 500), 50, 5000);
      const blend = clamp(toFiniteNumber(proportionalCfg.blend, 0.35), 0, 1);
      const propMinTimeoutMs = Math.max(1000, Math.floor(toFiniteNumber(proportionalCfg.minTimeoutMs, 120000)));
      const propMaxTimeoutMs = Math.max(propMinTimeoutMs, Math.floor(toFiniteNumber(proportionalCfg.maxTimeoutMs, 480000)));
      const proportionalTimeoutMs = Math.floor(clamp(tpDistanceUsd * msPerUsd, propMinTimeoutMs, propMaxTimeoutMs));
      timeoutBaseMs = Math.floor((timeoutBaseMs * (1 - blend)) + (proportionalTimeoutMs * blend));
    }
  }

  const minTimeoutMs = Math.max(1000, Math.floor(toFiniteNumber(dyn.minTimeoutMs, 45000)));
  const maxTimeoutMs = Math.max(minTimeoutMs, Math.floor(toFiniteNumber(dyn.maxTimeoutMs, 300000)));
  const timeoutMs = Math.floor(clamp(timeoutBaseMs * timeoutMul, minTimeoutMs, maxTimeoutMs));
  const softRatio = clamp(base.softRatio * softMul, 0.05, 0.95);
  const hardMin = Math.min(1.2, softRatio + 0.03);
  const hardRatio = clamp(base.hardRatio * hardMul, hardMin, 1.2);
  return { timeoutMs, softRatio, hardRatio, stressed, spreadBps, velocityBps, cShock };
}

function resolveTp2TrailPrice(pos, market, state, tradeConfig) {
  const cfg = tradeConfig?.b2?.tpSplit?.tp2Trail || {};
  if (cfg.enabled === false) return null;
  if (!pos?.tp1Done) return null;
  const midPx = toFiniteNumber(market?.midPx, NaN);
  if (!Number.isFinite(midPx) || midPx <= 0) return null;
  const tpDistBase = Math.abs(toFiniteNumber(pos?.tpDistanceUsd, NaN));
  if (!Number.isFinite(tpDistBase) || tpDistBase <= 0) return null;
  const prevMidPx = toFiniteNumber(state?.stats?.prevMidPx, NaN);
  const signedVelocityBps = (Number.isFinite(prevMidPx) && midPx > 0)
    ? ((midPx - prevMidPx) / midPx) * 10000
    : 0;
  const spreadBps = toFiniteNumber(market?.spreadBps, 0);
  const velocityRefBps = Math.max(0.1, toFiniteNumber(cfg.velocityRefBps, 0.8));
  const maxBoostMul = clamp(cfg.maxBoostMul, 1.0, 2.5);
  const minMul = clamp(cfg.minMul, 0.4, 1.2);
  const spreadPenaltyRefBps = Math.max(0.1, toFiniteNumber(cfg.spreadPenaltyRefBps, 1.0));
  const spreadPenaltyMul = clamp(cfg.spreadPenaltyMul, 0.5, 1.0);
  const trendMul = clamp(cfg.trendMul, 0.7, 1.5);
  const rangeMul = clamp(cfg.rangeMul, 0.6, 1.3);

  const isLong = pos.side === 'buy';
  const alignedVel = isLong ? Math.max(0, signedVelocityBps) : Math.max(0, -signedVelocityBps);
  const oppositeVel = isLong ? Math.max(0, -signedVelocityBps) : Math.max(0, signedVelocityBps);
  let mul = 1;
  mul += Math.min(maxBoostMul - 1, (alignedVel / velocityRefBps) * 0.2);
  mul -= Math.min(0.35, (oppositeVel / velocityRefBps) * 0.2);
  if (spreadBps > spreadPenaltyRefBps) {
    mul *= spreadPenaltyMul;
  }
  const regime = String(pos?.entryContext?.marketRegime || '').toUpperCase();
  if (regime === 'UP' || regime === 'DOWN') mul *= trendMul;
  if (regime === 'RANGE') mul *= rangeMul;
  mul = clamp(mul, minMul, maxBoostMul);
  const targetDist = tpDistBase * mul;
  let nextTpPx = isLong ? (midPx + targetDist) : (midPx - targetDist);
  const plannedEdge = toFiniteNumber(pos?.entryContext?.plannedTpEdge, NaN);
  if (Number.isFinite(plannedEdge) && plannedEdge > 0) {
    if (isLong) nextTpPx = Math.min(nextTpPx, plannedEdge);
    else nextTpPx = Math.max(nextTpPx, plannedEdge);
  }
  // Ratchet: TP2 trail must never move backward against already locked profit.
  const currentTpPx = toFiniteNumber(pos?.tpPx, NaN);
  if (Number.isFinite(currentTpPx) && currentTpPx > 0) {
    if (isLong) nextTpPx = Math.max(nextTpPx, currentTpPx);
    else nextTpPx = Math.min(nextTpPx, currentTpPx);
  }
  if (!Number.isFinite(nextTpPx) || nextTpPx <= 0) return null;
  if (isLong && nextTpPx <= midPx) return null;
  if (!isLong && nextTpPx >= midPx) return null;
  return { tpPx: nextTpPx, trailMul: mul };
}

function resolveExecMode(modeRaw, fallback = 'taker') {
  const mode = String(modeRaw || '').toLowerCase();
  if (mode === 'maker' || mode === 'taker') return mode;
  return fallback;
}

function resolveExitExecModeForReason(reasonRaw, market, tradeConfig) {
  const reason = String(reasonRaw ?? '').toLowerCase();
  const isTpExit = reason === 'tp_hit' || reason === 'tp1_partial' || reason.includes('tp');
  if (!isTpExit) return 'taker';
  const modeCfg = String(tradeConfig?.fees?.tpExitMode ?? 'taker').toLowerCase();
  if (modeCfg === 'maker' || modeCfg === 'taker') return modeCfg;
  const spreadBpsRaw = toFiniteNumber(market?.spreadBps, NaN);
  const midPx = toFiniteNumber(market?.midPx, 0);
  const bestBid = toFiniteNumber(market?.bestBidPx ?? market?.bestBid, NaN);
  const bestAsk = toFiniteNumber(market?.bestAskPx ?? market?.bestAsk, NaN);
  const spreadBps = Number.isFinite(spreadBpsRaw)
    ? Math.max(0, spreadBpsRaw)
    : (midPx > 0 && Number.isFinite(bestBid) && Number.isFinite(bestAsk))
      ? Math.max(0, ((bestAsk - bestBid) / midPx) * 10000)
      : Infinity;
  const velocityBps = Math.abs(toFiniteNumber(market?.priceVelocityBps, 0));
  const execCfg = tradeConfig?.b2Upgrade?.execution ?? {};
  const makerMaxSpreadBps = Math.max(0.1, toFiniteNumber(execCfg.makerMaxSpreadBps, 0.8));
  const makerMaxVelocityBps = Math.max(0.1, toFiniteNumber(execCfg.makerMaxVelocityBps, 0.8));
  return (spreadBps <= makerMaxSpreadBps * 1.2 && velocityBps <= makerMaxVelocityBps * 1.2)
    ? 'maker'
    : 'taker';
}

function estimateFeesUsd(notionalUsd, entryMode, exitMode, tradeConfig) {
  const feesCfg = tradeConfig?.fees || {};
  const makerBps = Math.max(0, toFiniteNumber(feesCfg.makerBps, 1.44));
  const takerBps = Math.max(0, toFiniteNumber(feesCfg.takerBps, 4.32));
  const n = Math.max(0, toFiniteNumber(notionalUsd, 0));
  const entryBps = resolveExecMode(entryMode, 'taker') === 'maker' ? makerBps : takerBps;
  const exitBps = resolveExecMode(exitMode, 'taker') === 'maker' ? makerBps : takerBps;
  const entryFeeUsd = n * (entryBps / 10000);
  const exitFeeUsd = n * (exitBps / 10000);
  const feeUsd = entryFeeUsd + exitFeeUsd;
  return { entryFeeUsd, exitFeeUsd, feeUsd, makerBps, takerBps };
}

function toUpperOr(value, fallback = 'UNKNOWN') {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  return s.toUpperCase();
}

function extractEntryDiag(ctx = {}) {
  return {
    entryProfileMode: String(ctx.entryProfileMode ?? 'unknown'),
    entryAggressiveness: String(ctx.entryAggressiveness ?? 'unknown'),
    entryQualityScore: Number.isFinite(Number(ctx.entryQualityScore)) ? Number(ctx.entryQualityScore) : null,
    higherTfAlignScore: Number.isFinite(Number(ctx.higherTfAlignScore)) ? Number(ctx.higherTfAlignScore) : null,
    higherTfSizeMul: Number.isFinite(Number(ctx.higherTfSizeMul)) ? Number(ctx.higherTfSizeMul) : null,
    higherTfTpMul: Number.isFinite(Number(ctx.higherTfTpMul)) ? Number(ctx.higherTfTpMul) : null,
    higherTfDir15m: toUpperOr(ctx.higherTfDir15m, 'NONE'),
    higherTfDir1h: toUpperOr(ctx.higherTfDir1h, 'NONE'),
    plannedTpSource: String(ctx.plannedTpSource ?? 'unknown'),
    plannedTpPhase: String(ctx.plannedTpPhase ?? 'unknown'),
    plannedStructureSource: String(ctx.plannedStructureSource ?? 'unknown'),
    plannedStructureBasis: String(ctx.plannedStructureBasis ?? 'unknown'),
    plannedStructureSpanUsd: Number.isFinite(Number(ctx.plannedStructureSpanUsd)) ? Number(ctx.plannedStructureSpanUsd) : null,
    mapClusterCount: Number.isFinite(Number(ctx.mapClusterCount)) ? Number(ctx.mapClusterCount) : null,
    mapPathDepth: Number.isFinite(Number(ctx.mapPathDepth)) ? Number(ctx.mapPathDepth) : null,
    mapStrength: Number.isFinite(Number(ctx.mapStrength)) ? Number(ctx.mapStrength) : null,
    mapStatus: String(ctx.mapStatus ?? 'unknown'),
    plannedTp1: Number.isFinite(Number(ctx.plannedTp1)) ? Number(ctx.plannedTp1) : null,
    plannedTp2: Number.isFinite(Number(ctx.plannedTp2)) ? Number(ctx.plannedTp2) : null,
    plannedTpEdge: Number.isFinite(Number(ctx.plannedTpEdge)) ? Number(ctx.plannedTpEdge) : null,
    ladderAttackScalar: Number.isFinite(Number(ctx.ladderAttackScalar)) ? Number(ctx.ladderAttackScalar) : null,
    feeEdgeBoosted: !!ctx.feeEdgeBoosted,
    feeEdgeBoostMul: Number.isFinite(Number(ctx.feeEdgeBoostMul)) ? Number(ctx.feeEdgeBoostMul) : null,
    sizeScalarCombined: Number.isFinite(Number(ctx.sizeScalarCombined)) ? Number(ctx.sizeScalarCombined) : null
  };
}

function resolvePlannedTp1(pos) {
  const fromCtx = Number(pos?.entryContext?.plannedTp1);
  if (Number.isFinite(fromCtx) && fromCtx > 0) return fromCtx;
  const fromRail = Number(pos?.tpPxRail);
  if (Number.isFinite(fromRail) && fromRail > 0) return fromRail;
  const fromTp = Number(pos?.tpPx);
  if (Number.isFinite(fromTp) && fromTp > 0) return fromTp;
  return null;
}

function computeCaptureMetrics(pos, exitPx) {
  const entryPx = Number(pos?.entryPx);
  const plannedTp1 = resolvePlannedTp1(pos);
  const plannedMoveUsd = Number.isFinite(plannedTp1) && Number.isFinite(entryPx)
    ? Math.abs(plannedTp1 - entryPx)
    : null;
  const capturedMoveUsd = Number.isFinite(exitPx) && Number.isFinite(entryPx)
    ? Math.abs(exitPx - entryPx)
    : null;
  const captureRatio = (Number.isFinite(plannedMoveUsd) && plannedMoveUsd > 0 && Number.isFinite(capturedMoveUsd))
    ? (capturedMoveUsd / plannedMoveUsd)
    : null;
  return {
    plannedMoveUsd,
    capturedMoveUsd,
    captureRatio
  };
}

function computeCounterfactualRegret(pos, market, actualNetUsd, tradeConfig) {
  const entryPx = Number(pos?.entryPx);
  const size = Number(pos?.size);
  if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(size) || size <= 0) {
    return {
      cfTp2NetUsdPotential: null,
      cfEdgeNetUsdPotential: null,
      regretToTp2Usd: null,
      regretToEdgeUsd: null,
      regretMaxUsd: null
    };
  }
  const isLong = pos?.side === 'buy';
  const entryExecMode = resolveExecMode(pos?.entryExecMode, 'taker');
  const exitExecModeCf = resolveExitExecModeForReason('tp_hit', market, tradeConfig);
  const notional = entryPx * size;
  const fee = estimateFeesUsd(notional, entryExecMode, exitExecModeCf, tradeConfig);
  const netAt = (targetPx) => {
    const px = Number(targetPx);
    if (!Number.isFinite(px) || px <= 0) return null;
    if (isLong && px <= entryPx) return null;
    if (!isLong && px >= entryPx) return null;
    const gross = isLong ? (px - entryPx) * size : (entryPx - px) * size;
    return gross - fee.feeUsd;
  };
  const cfTp2Net = netAt(pos?.entryContext?.plannedTp2 ?? pos?.tpPxStretch);
  const cfEdgeNet = netAt(pos?.entryContext?.plannedTpEdge);
  const actual = Number(actualNetUsd);
  const regretTp2 = Number.isFinite(cfTp2Net) && Number.isFinite(actual) ? Math.max(0, cfTp2Net - actual) : null;
  const regretEdge = Number.isFinite(cfEdgeNet) && Number.isFinite(actual) ? Math.max(0, cfEdgeNet - actual) : null;
  const regretMax = Math.max(
    Number.isFinite(regretTp2) ? regretTp2 : 0,
    Number.isFinite(regretEdge) ? regretEdge : 0
  );
  return {
    cfTp2NetUsdPotential: Number.isFinite(cfTp2Net) ? cfTp2Net : null,
    cfEdgeNetUsdPotential: Number.isFinite(cfEdgeNet) ? cfEdgeNet : null,
    regretToTp2Usd: Number.isFinite(regretTp2) ? regretTp2 : null,
    regretToEdgeUsd: Number.isFinite(regretEdge) ? regretEdge : null,
    regretMaxUsd: Number.isFinite(regretMax) ? regretMax : null
  };
}

function withDerivedTradeKpis(trade) {
  const exitSignal = String(trade?.exitSignal ?? '').toLowerCase();
  const tpReached = exitSignal === 'tp_hit' || exitSignal === 'tp1_partial';
  return {
    ...trade,
    tpReached
  };
}

function updateTimeoutLossOnlyAlert(state, trade, tradeConfig, nowTs) {
  const cfg = tradeConfig?.timeoutAlert || {};
  if (cfg.enabled === false) return;
  const threshold = Math.max(1, Math.floor(toFiniteNumber(cfg.consecutiveThreshold, 3)));
  const cooldownMs = Math.max(0, Math.floor(toFiniteNumber(cfg.cooldownMs, 300000)));
  const signal = String(trade?.signal ?? '').toLowerCase();
  const isTimeoutLossOnly = signal === 'timeout_loss_only';
  const prevStreak = Math.max(0, Math.floor(toFiniteNumber(state?.timeoutLossOnlyStreak, 0)));
  const nextStreak = isTimeoutLossOnly ? (prevStreak + 1) : 0;
  state.timeoutLossOnlyStreak = nextStreak;

  if (!isTimeoutLossOnly || nextStreak < threshold) return;
  const lastAlertAt = Math.max(0, Math.floor(toFiniteNumber(state?.timeoutLossOnlyAlertAt, 0)));
  if (cooldownMs > 0 && Number.isFinite(lastAlertAt) && (nowTs - lastAlertAt) < cooldownMs) return;

  state.timeoutLossOnlyAlertAt = nowTs;
  const tpDistanceUsd = Number.isFinite(Number(trade?.tpDistanceUsd)) ? Number(trade.tpDistanceUsd) : null;
  console.warn(`[TIMEOUT_ALERT] timeout_loss_only streak=${nextStreak} threshold=${threshold} tpDistanceUsd=${tpDistanceUsd ?? 'n/a'}`);
}

/**
 * updateEngine
 * Logic決定とMarket状態を受けてEngineStateを更新
 * 
 * @param {Object} state - EngineState
 * @param {Object} market - MarketState { midPx, ts? }
 * @param {Object} decision - Decision { side, size, reason }
 * @param {number} nowTs - 現在時刻 (epoch millis)
 * @returns {Object} 新しいEngineState
 */
function updateEngine(state, market, decision, nowTs) {
  const tradeConfig = getTradeConfig();
  const lossTimeoutCfg = tradeConfig?.lossTimeout || {};
  const LOSS_TIMEOUT_ENABLED = lossTimeoutCfg.enabled !== false;
  const LOSS_TIMEOUT_MS = Number.isFinite(Number(lossTimeoutCfg.ms)) ? Number(lossTimeoutCfg.ms) : 240000;
  const LOSS_TIMEOUT_EPS = Number.isFinite(Number(lossTimeoutCfg.eps)) ? Number(lossTimeoutCfg.eps) : 0;
  const SOFT_RATIO = Number.isFinite(Number(lossTimeoutCfg.softRatio)) ? Number(lossTimeoutCfg.softRatio) : 0.4;
  const SOFT_TIMEOUT_MS = Number.isFinite(Number(lossTimeoutCfg.softTimeoutMs)) ? Number(lossTimeoutCfg.softTimeoutMs) : 120000;
  const HARD_RATIO = Number.isFinite(Number(lossTimeoutCfg.hardRatio)) ? Number(lossTimeoutCfg.hardRatio) : 0.6;
  const riskGuardsCfg = tradeConfig?.riskGuards || {};
  const RISK_GUARDS_ENABLED = riskGuardsCfg.enabled !== false;
  const HARD_SL_COOLDOWN_MS = Math.max(0, Number(riskGuardsCfg.hardSlCooldownMs ?? 0));
  const REDUCE_SIZE_AFTER_LOSS = riskGuardsCfg.reduceSizeAfterLoss !== false;
  const REDUCE_SIZE_FACTOR_RAW = Number(riskGuardsCfg.reduceSizeFactor ?? 1);
  const REDUCE_SIZE_FACTOR = Number.isFinite(REDUCE_SIZE_FACTOR_RAW)
    ? Math.min(1, Math.max(0.1, REDUCE_SIZE_FACTOR_RAW))
    : 1;
  const REDUCE_SIZE_WINDOW_MS = Math.max(0, Number(riskGuardsCfg.reduceSizeWindowMs ?? 0));
  state.riskGuards = ensureRiskGuardState(state.riskGuards);
  try {
    updateHealth(STAGES.ENGINE);
    updateHealth(STAGES.UPDATE);
  } catch (err) {
    console.error('[ENGINE] updateHealth failed', err);
  }
  try {
    checkScheduledLineReports(nowTs);
  } catch (err) {
    console.error('[LINE_NOTIFY] schedule check failed', err?.message || err);
  }
  // --- DEBUG: Market→Engine境界観測 ---
  if (market && typeof market.ts === 'number') {
    const last = state.lastUpdate || 0;
    const delta = Math.abs(market.ts - last);
    if (process.env.DEBUG_MARKET_ENGINE === '1') {
      console.debug(`[MARKET→ENGINE] market.ts=${market.ts} lastUpdate=${last} Δms=${delta}`);
    }
  }
  if (!state.safety) {
    setSafety(state, 'NORMAL', null);
  }
  // Marketデータをstatsに必ず反映（条件分岐なし、1箇所に集約）
  state.stats.prevMidPx = state.stats.midPx;
  state.stats.midPx = market?.midPx ?? null;
  state.stats.oi = market?.oi ?? null;
  state.performanceGuards = evaluatePerformanceGuards(state, tradeConfig, nowTs);
  if (process.env.DEBUG_STATS_UPDATE === '1') {
    console.log('[STATS UPDATE]', state.stats.midPx, state.stats.oi);
  }
    // STEP4: safety状態の扱い
    // - 新規エントリーは止める
    // - ただし保有ポジションの監視/EXIT判定は継続する（ここを止めると運用上危険）
    if (state.safety && (state.safety.status === 'HALTED' || state.safety.status === 'ERROR')) {
      if (!state.openPosition) {
        return state;
      }
      decision = { side: 'none', size: 0, reason: 'safety_halt_manage_open' };
    }
    // runtime は復帰後を ACTIVE で運用するため、ACTIVE は実行許可
    const safetyStatus = state?.safety?.status;
    if (safetyStatus !== 'NORMAL' && safetyStatus !== 'ACTIVE') {
      if (!state.openPosition) {
        return state;
      }
      decision = { side: 'none', size: 0, reason: 'safety_non_normal_manage_open' };
    }
  // ────────────────────────
  // Safety Check
  // ────────────────────────
  
  try {
    if (!market || typeof market.midPx !== 'number' || market.midPx <= 0 || isNaN(market.midPx)) {
      setSafety(state, 'ERROR', 'INVALID_MARKET');
      console.warn('[TEST Engine] Invalid market.midPx:', market?.midPx);
      emitEngineError(`[TEST Engine] Invalid market.midPx: ${market?.midPx}`);
      const newState = {
        ...state,
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, decision);
      emitEngineEvent('ENGINE_ERROR', {
        type: 'market',
        message: `[TEST Engine] Invalid market.midPx: ${market?.midPx}`,
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision,
        reason: decision?.reason || 'invalid_market'
      });
      return newState;
    }
  
    if (!decision || typeof decision.side !== 'string') {
      setSafety(state, 'ERROR', 'INVALID_DECISION');
      console.warn('[TEST Engine] Invalid decision:', decision);
      emitEngineError('[TEST Engine] Invalid decision received');
      const newState = {
        ...state,
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, decision);
      emitEngineEvent('ENGINE_ERROR', {
        type: 'decision',
        message: '[TEST Engine] Invalid decision received',
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision,
        reason: decision?.reason || 'invalid_decision'
      });
      return newState;
    }
    // ...既存ロジック...
    // 以降はtryブロック内で通常進行
    // ...
  } catch (err) {
    setSafety(state, 'ERROR', 'ENGINE_EXCEPTION');
    throw err;
  }

  // midPx is needed below (openPosition monitoring) and must be defined before use
  const midPx = market.midPx;
  
  // ────────────────────────
  // Open position monitoring: update adverse stats & decide exits
  // ────────────────────────
  let normalExitLoggedThisTick = false;
  if (state.openPosition) {
    const pos = state.openPosition;
    // 更新: worstPx / maxAdverseRatio / hitSoftAtTs
    const isLong = pos.side === 'buy';
    const worstPx = isLong
      ? Math.min(pos.worstPx ?? pos.entryPx, midPx)
      : Math.max(pos.worstPx ?? pos.entryPx, midPx);
    const adverseUsd = Math.max(0, isLong ? (pos.entryPx - worstPx) : (worstPx - pos.entryPx));
    const tpDist = Number(pos.tpDistanceUsd);
    const holdMs = nowTs - pos.entryTs;
    const adverseRatio = tpDist > 0 ? adverseUsd / tpDist : 0;
    const dynamicLoss = resolveDynamicLossParams(
      {
        timeoutMs: LOSS_TIMEOUT_MS,
        softRatio: SOFT_RATIO,
        hardRatio: HARD_RATIO
      },
      market,
      state,
      pos,
      lossTimeoutCfg
    );
    let softRatioLimit = dynamicLoss.softRatio;
    let hardRatioLimit = dynamicLoss.hardRatio;
    let timeoutMsLimit = dynamicLoss.timeoutMs;
    const stressExitCfg = lossTimeoutCfg?.dynamicRealtime || {};
    let hitSoftAtTs = pos.hitSoftAtTs ?? null;
    let maxAdverseRatio = Math.max(pos.maxAdverseRatio ?? 0, adverseRatio);
    let trackedTpPx = Number.isFinite(Number(pos.tpPx)) ? Number(pos.tpPx) : null;
    let trackedTpMode = pos.tpMode ?? null;
    let trackedTpStretchActiveAt = pos.tpStretchActiveAt ?? null;
    let trackedTp2TrailMul = Number.isFinite(Number(pos.tp2TrailMul)) ? Number(pos.tp2TrailMul) : null;
    let trackedTp2TrailLastAt = Number.isFinite(Number(pos.tp2TrailLastAt)) ? Number(pos.tp2TrailLastAt) : null;
    let depthExitState = createDepthExitState(pos?.depthExitState);
    let flowAdaptiveCtx = null;
    let burstExitCtx = null;
    let flowTighteningDiag = null;
    let holdingPressureDiag = null;
    let entryQualityRoutingDiag = null;
    let environmentDriftDiag = null;

    // SOFT: 初回ヒット時刻を固定（リセットしない）
    if (adverseRatio >= softRatioLimit) {
      if (!hitSoftAtTs) hitSoftAtTs = nowTs;
    }

    // TPストレッチ: 一定時間経過後にTPを伸ばす（損失側は維持）
    if (
      Number.isFinite(pos.tpStretchRatio) &&
      pos.tpStretchRatio > 1 &&
      Number.isFinite(pos.tpStretchHoldMs) &&
      pos.tpStretchHoldMs > 0 &&
      !trackedTpStretchActiveAt &&
      holdMs >= pos.tpStretchHoldMs &&
      Number.isFinite(pos.tpPxStretch)
    ) {
      trackedTpStretchActiveAt = nowTs;
      trackedTpPx = Number(pos.tpPxStretch);
      trackedTpMode = 'rail+holdStretch';
    }

    // EXIT判定（decisionの有無に依存せず評価）
    let exitDecision = null;
    let depthExitCtx = null;

    // ← #11修正: TP判定を追加
    // TP到達判定
    const tpPx = Number.isFinite(trackedTpPx) ? trackedTpPx : Number(pos.tpPx);
    const plannedTpMoveUsd = Number.isFinite(tpPx) ? Math.abs(tpPx - pos.entryPx) : tpDist;
    const forwardUsdRaw = isLong ? (midPx - pos.entryPx) : (pos.entryPx - midPx);
    const forwardUsd = Number.isFinite(forwardUsdRaw) ? forwardUsdRaw : 0;
    const tpProgressRatio = (Number.isFinite(plannedTpMoveUsd) && plannedTpMoveUsd > 0)
      ? clamp(forwardUsd / plannedTpMoveUsd, -1, 2)
      : 0;
    const unrealizedUsd = isLong ? (midPx - pos.entryPx) * pos.size : (pos.entryPx - midPx) * pos.size;

    const entryQualityRouting = resolveEntryQualityRoutingAdjustments(pos, tradeConfig);
    if (entryQualityRouting.applied) {
      timeoutMsLimit = Math.floor(clamp(timeoutMsLimit * entryQualityRouting.timeoutMul, 1000, 24 * 60 * 60 * 1000));
      softRatioLimit = clamp(softRatioLimit * entryQualityRouting.softMul, 0.05, 0.95);
      hardRatioLimit = clamp(hardRatioLimit * entryQualityRouting.hardMul, softRatioLimit + 0.03, 1.2);
    }
    entryQualityRoutingDiag = entryQualityRouting.diag ?? null;
    const flowTightening = resolveFlowLossTightening(pos, market, tradeConfig, {
      holdMs,
      tpProgressRatio,
      unrealizedUsd
    });
    if (flowTightening.applied) {
      softRatioLimit = clamp(softRatioLimit * flowTightening.softMul, 0.05, 0.95);
      hardRatioLimit = clamp(hardRatioLimit * flowTightening.hardMul, softRatioLimit + 0.03, 1.2);
      flowTighteningDiag = flowTightening.diag ?? null;
    }
    const holdingPressure = resolveHoldingPressureAdjustments(pos, market, tradeConfig);
    if (holdingPressure.applied) {
      timeoutMsLimit = Math.floor(clamp(timeoutMsLimit * holdingPressure.timeoutMul, 1000, 24 * 60 * 60 * 1000));
      softRatioLimit = clamp(softRatioLimit * holdingPressure.softMul, 0.05, 0.95);
      hardRatioLimit = clamp(hardRatioLimit * holdingPressure.hardMul, softRatioLimit + 0.03, 1.2);
      holdingPressureDiag = holdingPressure.diag ?? null;
    }
    const environmentDrift = resolveEnvironmentDriftAdjustments(pos, decision, market, tradeConfig, {
      holdMs,
      unrealizedUsd
    });
    if (environmentDrift.applied) {
      timeoutMsLimit = Math.floor(clamp(timeoutMsLimit * environmentDrift.timeoutMul, 1000, 24 * 60 * 60 * 1000));
      softRatioLimit = clamp(softRatioLimit * environmentDrift.softMul, 0.05, 0.95);
      hardRatioLimit = clamp(hardRatioLimit * environmentDrift.hardMul, softRatioLimit + 0.03, 1.2);
    }
    environmentDriftDiag = environmentDrift.diag ?? null;
    const envCfg = tradeConfig?.flowAdaptiveExit?.environmentDrift ?? {};
    const envReq = Math.max(1, Math.floor(toFiniteNumber(envCfg?.minConsecutiveTicks, 2)));
    depthExitState.driftStreak = environmentDrift.hit ? (depthExitState.driftStreak + 1) : 0;
    if (Number.isFinite(tpPx) && tpPx > 0) {
      const tpHit = (isLong && midPx >= tpPx) || (!isLong && midPx <= tpPx);
      if (tpHit) {
        const tpSplitCfg = tradeConfig?.b2?.tpSplit || {};
        const tp1Done = !!pos.tp1Done;
        if (!tp1Done) {
          const closeRatio = clamp(tpSplitCfg.closeRatio, 0.1, 0.9);
          const minRemainRatio = clamp(tpSplitCfg.minRemainRatio, 0.05, 0.95);
          const closeSize = pos.size * closeRatio;
          const remainSize = pos.size - closeSize;
          const minRemainSize = pos.size * minRemainRatio;
          if (Number.isFinite(closeSize) && closeSize > 0 && Number.isFinite(remainSize) && remainSize >= minRemainSize) {
            const entryPx = pos.entryPx;
            const exitPx = midPx;
            let pnl = 0;
            if (isLong) {
              pnl = (exitPx - entryPx) * closeSize;
            } else {
              pnl = (entryPx - exitPx) * closeSize;
            }
            const notional = entryPx * closeSize;
            const pnlPct = (notional > 0) ? (pnl / notional) * 100 : 0;
            const entryExecMode = resolveExecMode(pos.entryExecMode, 'taker');
            const exitExecMode = resolveExitExecModeForReason('tp1_partial', market, tradeConfig);
            const fee = estimateFeesUsd(notional, entryExecMode, exitExecMode, tradeConfig);
            const pnlNet = pnl - fee.feeUsd;
            const pnlPctNet = (notional > 0) ? (pnlNet / notional) * 100 : 0;
            const tradeId = crypto.randomUUID();
            const partialTrade = withDerivedTradeKpis({
              tradeId,
              ts: nowTs,
              entryTs: pos.entryTs,
              exitTs: nowTs,
              timestampEntry: pos.entryTs,
              timestampExit: nowTs,
              holdMs,
              side: isLong ? 'LONG' : 'SHORT',
              zone: null,
              marketState: MARKET_STATE_UNKNOWN,
              signal: 'tp1_partial',
              safety: state?.safety?.status ?? null,
              entryPrice: entryPx,
              exitPrice: exitPx,
              size: closeSize,
              notional,
              realizedPnlUsd: pnl,
              realizedPnlNetUsd: pnlNet,
              feeUsd: fee.feeUsd,
              entryFeeUsd: fee.entryFeeUsd,
              exitFeeUsd: fee.exitFeeUsd,
              entryExecMode,
              exitExecMode,
              realizedPnlPctTrade: pnlPct,
              realizedPnlPctTradeNet: pnlPctNet,
              result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT',
              wsStateAtEntry: null,
              wsStateAtExit: null,
              exitReason: 'TP',
              exitSignal: 'tp1_partial',
              exitReasonDetail: `TP1 partial close (${Math.round(closeRatio * 100)}%)`,
              exitLabel: null,
              latencyMs: null,
              tpDistanceUsd: Number.isFinite(Number(pos.tpDistanceUsd)) ? Number(pos.tpDistanceUsd) : null,
              tpPx: Number.isFinite(Number(pos.tpPx)) ? Number(pos.tpPx) : null,
              tpMode: 'rail+split',
              tp2TrailMul: Number.isFinite(Number(pos.tp2TrailMul)) ? Number(pos.tp2TrailMul) : null,
              tp1Price: Number.isFinite(Number(pos.tpPxRail)) ? Number(pos.tpPxRail) : null,
              tp2Price: Number.isFinite(Number(pos.tpPxStretch)) ? Number(pos.tpPxStretch) : null,
              tp2Ratio: Number.isFinite(Number(pos.tpStretchRatio)) ? Number(pos.tpStretchRatio) : null,
              holdMsAtStretch: null,
              exitAt: 'tp1_partial',
              maxAdverseRatio: Number.isFinite(Number(maxAdverseRatio)) ? Number(maxAdverseRatio) : null,
              hitSoftAtTs: hitSoftAtTs ?? null,
              bLogicRevision: pos.bLogicRevision || BLOGIC_REVISION,
              structuralDistanceUsd: Number.isFinite((pos.entryContext ?? {}).structuralDistanceUsd)
                ? Number(pos.entryContext.structuralDistanceUsd)
                : -1,
              expectedPnlUsd: Number.isFinite((pos.entryContext ?? {}).expectedPnlUsd)
                ? Number(pos.entryContext.expectedPnlUsd)
                : 0,
              marketRegime: ((pos.entryContext ?? {}).marketRegime || "UNKNOWN").toString().toUpperCase(),
              firepower: Number.isFinite((pos.entryContext ?? {}).firepower)
                ? Number(pos.entryContext.firepower)
                : -1.0,
              ...computeCaptureMetrics(pos, exitPx),
              ...computeCounterfactualRegret(pos, market, pnlNet, tradeConfig),
              ...extractEntryDiag(pos.entryContext)
            });
            appendTradeLog(partialTrade);
            updateTimeoutLossOnlyAlert(state, partialTrade, tradeConfig, nowTs);
            const plannedTp2 = Number(pos.entryContext?.plannedTp2);
            const plannedTpEdge = Number(pos.entryContext?.plannedTpEdge);
            const stretchedTp = Number(pos.tpPxStretch);
            const chooseNextTp = (...candidates) => {
              for (const c of candidates) {
                if (!Number.isFinite(c) || c <= 0) continue;
                if (isLong && c > midPx) return c;
                if (!isLong && c < midPx) return c;
              }
              return null;
            };
            const nextTp = chooseNextTp(plannedTp2, stretchedTp, plannedTpEdge);
            const newPosition = {
              ...pos,
              size: remainSize,
              tp1Done: true,
              tpPx: Number.isFinite(nextTp) ? nextTp : pos.tpPx,
              tpMode: Number.isFinite(nextTp) ? 'rail+split+ladder' : 'rail+split',
              tp2TrailMul: null,
              tp2TrailLastAt: nowTs,
              worstPx: midPx,
              // Keep adverse/soft timeout context for the remaining position.
              hitSoftAtTs,
              maxAdverseRatio,
              depthExitState
            };
            const newState = {
              ...state,
              openPosition: newPosition,
              lastDecision: {
                side: 'none',
                size: 0,
                reason: 'tp1_partial',
                decidedAt: nowTs
              },
              lastUpdate: nowTs
            };
            emitDebugEngine(newState, { side: 'none', size: 0, reason: 'tp1_partial' });
            emitEngineEvent('ENGINE_POSITION_UPDATE', {
              type: 'partial_exit',
              state: newState,
              ts: nowTs,
              positionBefore: state.openPosition,
              positionAfter: newState.openPosition,
              decision: { side: 'none', size: 0, action: 'partial_exit' },
              reason: 'tp1_partial'
            });
            return newState;
          }
        }
        const exitSide = isLong ? 'sell' : 'buy';
        exitDecision = { side: exitSide, size: pos.size, reason: 'tp_hit' };
      }
    }

    // Flow-adaptive early take-profit: progressが乗った後に逆フロー/減速を検知したら利確
    if (!exitDecision) {
      const adaptiveTp = evaluateFlowAdaptiveTakeProfit(pos, market, tradeConfig, {
        holdMs,
        tpProgressRatio,
        unrealizedUsd
      });
      const rootCfg = tradeConfig?.flowAdaptiveExit ?? {};
      const earlyTpCfg = rootCfg?.earlyTakeProfit ?? {};
      const flowTpReq = Math.max(1, Math.floor(toFiniteNumber(earlyTpCfg?.minConsecutiveTicks, 2)));
      depthExitState.flowTpStreak = adaptiveTp.hit ? (depthExitState.flowTpStreak + 1) : 0;
      if (depthExitState.flowTpStreak >= flowTpReq) {
        const exitSide = isLong ? 'sell' : 'buy';
        exitDecision = { side: exitSide, size: pos.size, reason: 'flow_adaptive_take_profit' };
        flowAdaptiveCtx = {
          ...(adaptiveTp.diag ?? {}),
          streak: depthExitState.flowTpStreak,
          requiredStreak: flowTpReq
        };
        depthExitState.lastSignal = flowAdaptiveCtx.signal ?? 'flow_adaptive_take_profit';
        depthExitState.lastSignalAt = nowTs;
      }
    }

    // Micro burst exit: 5s約定速度が急騰し、逆方向フローが強いときに早期撤退
    if (!exitDecision) {
      const burstExit = evaluateMicroTradeBurstExit(pos, market, tradeConfig, {
        holdMs,
        unrealizedUsd
      });
      const burstCfg = tradeConfig?.flowAdaptiveExit?.burstExit ?? {};
      const burstReq = Math.max(1, Math.floor(toFiniteNumber(burstCfg?.minTicks, 1)));
      depthExitState.burstStreak = burstExit.hit ? (depthExitState.burstStreak + 1) : 0;
      if (depthExitState.burstStreak >= burstReq) {
        const exitSide = isLong ? 'sell' : 'buy';
        exitDecision = { side: exitSide, size: pos.size, reason: 'burst_adverse_exit' };
        burstExitCtx = {
          ...(burstExit.diag ?? {}),
          streak: depthExitState.burstStreak,
          requiredStreak: burstReq
        };
        depthExitState.lastSignal = burstExitCtx.signal ?? 'burst_adverse_exit';
        depthExitState.lastSignalAt = nowTs;
      }
    }

    // Environment drift exit: エントリー時の前提（regime/map/flow）が崩れたら撤退
    if (!exitDecision && depthExitState.driftStreak >= envReq) {
      const exitSide = isLong ? 'sell' : 'buy';
      exitDecision = { side: exitSide, size: pos.size, reason: 'environment_drift_exit' };
      depthExitState.lastSignal = environmentDriftDiag?.signal ?? 'environment_drift_exit';
      depthExitState.lastSignalAt = nowTs;
    }

    // Depth-aware exit (WS板の前提崩壊を先行検知)
    if (!exitDecision) {
      const depthSignals = evaluateDepthAwareSignals(pos, market, tradeConfig, {
        holdMs,
        tpProgressRatio,
        unrealizedUsd
      });
      const depthCfg = tradeConfig?.depthAwareExit ?? {};
      const shieldReq = Math.max(1, Math.floor(toFiniteNumber(depthCfg?.shield?.minConsecutiveTicks, 2)));
      const wallReq = Math.max(1, Math.floor(toFiniteNumber(depthCfg?.wallAhead?.minConsecutiveTicks, 2)));
      const flowReq = Math.max(1, Math.floor(toFiniteNumber(depthCfg?.flowImbalance?.minConsecutiveTicks, 3)));
      depthExitState.shieldStreak = depthSignals.shield.hit ? (depthExitState.shieldStreak + 1) : 0;
      depthExitState.wallStreak = depthSignals.wallAhead.hit ? (depthExitState.wallStreak + 1) : 0;
      depthExitState.flowStreak = depthSignals.flowImbalance.hit ? (depthExitState.flowStreak + 1) : 0;

      let selected = null;
      if (depthExitState.shieldStreak >= shieldReq) {
        selected = { reason: 'shield_collapse_exit', diag: depthSignals.shield.diag, streak: depthExitState.shieldStreak, required: shieldReq };
      } else if (depthExitState.wallStreak >= wallReq) {
        selected = { reason: 'wall_ahead_exit', diag: depthSignals.wallAhead.diag, streak: depthExitState.wallStreak, required: wallReq };
      } else if (depthExitState.flowStreak >= flowReq) {
        selected = { reason: 'flow_imbalance_exit', diag: depthSignals.flowImbalance.diag, streak: depthExitState.flowStreak, required: flowReq };
      }

      if (selected?.reason) {
        const notional = pos.entryPx * pos.size;
        const entryExecMode = resolveExecMode(pos.entryExecMode, 'taker');
        const exitExecMode = resolveExitExecModeForReason(selected.reason, market, tradeConfig);
        const fee = estimateFeesUsd(notional, entryExecMode, exitExecMode, tradeConfig);
        const projectedNetUsd = unrealizedUsd - fee.feeUsd;
        if (projectedNetUsd > 0) {
          const exitSide = isLong ? 'sell' : 'buy';
          exitDecision = { side: exitSide, size: pos.size, reason: selected.reason };
          depthExitCtx = {
            ...(selected.diag ?? {}),
            streak: selected.streak,
            requiredStreak: selected.required,
            projectedNetUsd,
            projectedGrossUsd: unrealizedUsd,
            projectedFeeUsd: fee.feeUsd
          };
          depthExitState.lastSignal = depthExitCtx.signal ?? selected.reason;
          depthExitState.lastSignalAt = nowTs;
        } else {
          depthExitCtx = {
            ...(selected.diag ?? {}),
            streak: selected.streak,
            requiredStreak: selected.required,
            blockedByFeeGuard: true,
            projectedNetUsd,
            projectedGrossUsd: unrealizedUsd,
            projectedFeeUsd: fee.feeUsd
          };
          depthExitState.lastSignal = 'depth_exit_fee_blocked';
          depthExitState.lastSignalAt = nowTs;
        }
      }
    }

    // HARD SL / SOFT SL / TIMEOUT
    if (!exitDecision) {
      const tp2TrailCfg = tradeConfig?.b2?.tpSplit?.tp2Trail || {};
      const tp2TrailCooldownMs = Math.max(200, toFiniteNumber(tp2TrailCfg.updateCooldownMs, 1500));
      const lastTp2TrailAt = toFiniteNumber(trackedTp2TrailLastAt, 0);
      if (pos.tp1Done && (nowTs - lastTp2TrailAt) >= tp2TrailCooldownMs) {
        const tp2Trail = resolveTp2TrailPrice({
          ...pos,
          tpPx: Number.isFinite(trackedTpPx) ? trackedTpPx : pos.tpPx,
          tp2TrailMul: trackedTp2TrailMul,
          tp2TrailLastAt: trackedTp2TrailLastAt
        }, market, state, tradeConfig);
        if (tp2Trail && Number.isFinite(tp2Trail.tpPx) && tp2Trail.tpPx > 0) {
          trackedTpPx = tp2Trail.tpPx;
          trackedTp2TrailMul = tp2Trail.trailMul;
          trackedTp2TrailLastAt = nowTs;
          trackedTpMode = 'rail+split+trail';
        }
      }
      const stressExitEnabled = stressExitCfg.stressExitEnabled !== false;
      const stressExitMinHoldMs = Math.max(1000, toFiniteNumber(stressExitCfg.stressExitMinHoldMs, 15000));
      const stressExitMinAdverseRatio = clamp(stressExitCfg.stressExitMinAdverseRatio, 0.01, 0.8);
      const earlyExitMinHoldMs = Math.max(stressExitMinHoldMs, toFiniteNumber(stressExitCfg.earlyExitMinHoldMs, 45000));
      const earlyExitProgressMax = clamp(toFiniteNumber(stressExitCfg.earlyExitProgressMax, 0.22), 0.01, 0.8);
      const canUseEarlyExit = holdMs >= earlyExitMinHoldMs && tpProgressRatio <= earlyExitProgressMax;
      if (
        stressExitEnabled &&
        dynamicLoss.stressed === true &&
        canUseEarlyExit &&
        Number.isFinite(adverseRatio) &&
        adverseRatio >= stressExitMinAdverseRatio &&
        adverseRatio > LOSS_TIMEOUT_EPS
      ) {
        const exitSide = isLong ? 'sell' : 'buy';
        exitDecision = { side: exitSide, size: pos.size, reason: 'stress_cut_loss' };
      } else if (
        Number.isFinite(adverseRatio) &&
        adverseRatio >= hardRatioLimit &&
        (tpProgressRatio <= earlyExitProgressMax || adverseRatio >= 0.8)
      ) {
        const exitSide = isLong ? 'sell' : 'buy';
        exitDecision = { side: exitSide, size: pos.size, reason: 'hard_sl_ratio' };
      } else if (
        Number.isFinite(adverseRatio) &&
        adverseRatio >= softRatioLimit &&
        hitSoftAtTs &&
        (nowTs - hitSoftAtTs) >= SOFT_TIMEOUT_MS
      ) {
        const exitSide = isLong ? 'sell' : 'buy';
        exitDecision = { side: exitSide, size: pos.size, reason: 'soft_sl_timeout' };
      } else if (LOSS_TIMEOUT_ENABLED && tpDist > 0) {
        if (canUseEarlyExit && holdMs >= timeoutMsLimit && adverseRatio > LOSS_TIMEOUT_EPS) {
          const exitSide = isLong ? 'sell' : 'buy';
          exitDecision = { side: exitSide, size: pos.size, reason: 'timeout_loss_only' };
        }
      }
    }

    // decision が hold/同サイドなら exit を優先
    // ← Priority 1 修正: exitDecision が生成された場合、即座に logging
    // P0-1: normalExitLogged フラグはローカル変数で管理（state 汚染を避ける）
    if (exitDecision) {
      const decisionSide = decision?.side ?? 'none';
      if (decisionSide === 'none' || decisionSide === pos.side) {
        decision = { ...exitDecision, isNormalExit: true };
        
        // ─────────────────────────────────────────
        // 通常 EXIT ロギング（tp_hit / hard_sl_ratio など）
        // ─────────────────────────────────────────
        const entryPx = pos.entryPx;
        const exitPx = midPx;
        const isLong = pos.side === 'buy';
        let pnl = 0;
        if (isLong) {
          pnl = (exitPx - entryPx) * pos.size;
        } else {
          pnl = (entryPx - exitPx) * pos.size;
        }
        const notional = entryPx * pos.size;
        const pnlPct = (notional > 0) ? (pnl / notional) * 100 : 0;
        const entryExecMode = resolveExecMode(pos.entryExecMode, 'taker');
        const exitExecMode = resolveExitExecModeForReason(exitDecision.reason, market, tradeConfig);
        const fee = estimateFeesUsd(notional, entryExecMode, exitExecMode, tradeConfig);
        const pnlNet = pnl - fee.feeUsd;
        const pnlPctNet = (notional > 0) ? (pnlNet / notional) * 100 : 0;
        const tradeId = crypto.randomUUID();
        const tpMode = trackedTpStretchActiveAt ? 'rail+holdStretch' : 'rail';
        const holdMsAtStretch = trackedTpStretchActiveAt ? (trackedTpStretchActiveAt - pos.entryTs) : null;
        const exitAt = exitDecision.reason === 'tp_hit'
          ? (trackedTpStretchActiveAt ? 'tp2' : 'tp1')
          : 'sl';
        
        // mapExitReason で exitSignal / exitReasonDetail を生成
        const exitReasonContext = {
          tpDistanceUsd: Number.isFinite(Number(pos.tpDistanceUsd)) ? Number(pos.tpDistanceUsd) : null,
          maxAdverseRatio,
          holdMs
        };
        const exitReasonMapped = mapExitReason(exitDecision.reason, entryPx, exitPx, exitReasonContext);
        
        // 通常 EXIT の trade レコード
        const trade = {
          tradeId,
          ts: nowTs,
          entryTs: pos.entryTs,
          exitTs: nowTs,
          timestampEntry: pos.entryTs,
          timestampExit: nowTs,
          holdMs,
          side: isLong ? 'LONG' : 'SHORT',
          zone: null,
          marketState: MARKET_STATE_UNKNOWN,
          signal: exitDecision.reason,
          safety: state?.safety?.status ?? null,
          entryPrice: entryPx,
          exitPrice: exitPx,
          size: pos.size,
          notional,
          realizedPnlUsd: pnl,
          realizedPnlNetUsd: pnlNet,
          feeUsd: fee.feeUsd,
          entryFeeUsd: fee.entryFeeUsd,
          exitFeeUsd: fee.exitFeeUsd,
          entryExecMode,
          exitExecMode,
          realizedPnlPctTrade: pnlPct,
          realizedPnlPctTradeNet: pnlPctNet,
          result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT',
          wsStateAtEntry: null,
          wsStateAtExit: null,
          exitReason: exitReasonMapped.reason,
          exitSignal: exitReasonMapped.signal,
          exitReasonDetail: exitReasonMapped.detail,
          exitLabel: null,
          latencyMs: null,
          tpDistanceUsd: Number.isFinite(Number(pos.tpDistanceUsd)) ? Number(pos.tpDistanceUsd) : null,
          tpPx: Number.isFinite(trackedTpPx) ? Number(trackedTpPx) : (Number.isFinite(Number(pos.tpPx)) ? Number(pos.tpPx) : null),
          tpMode,
          tp2TrailMul: Number.isFinite(Number(trackedTp2TrailMul)) ? Number(trackedTp2TrailMul) : null,
          tp1Price: Number.isFinite(Number(pos.tpPxRail)) ? Number(pos.tpPxRail) : null,
          tp2Price: Number.isFinite(Number(pos.tpPxStretch)) ? Number(pos.tpPxStretch) : null,
          tp2Ratio: Number.isFinite(Number(pos.tpStretchRatio)) ? Number(pos.tpStretchRatio) : null,
          holdMsAtStretch,
          exitAt,
          maxAdverseRatio: Number.isFinite(Number(maxAdverseRatio)) ? Number(maxAdverseRatio) : null,
          hitSoftAtTs: hitSoftAtTs ?? null,
          depthExitSignal: depthExitCtx?.signal ?? null,
          depthExitWallUsd: Number.isFinite(Number(depthExitCtx?.wallNotionalUsd)) ? Number(depthExitCtx.wallNotionalUsd) : null,
          depthExitShieldCurrentUsd: Number.isFinite(Number(depthExitCtx?.currentUsd)) ? Number(depthExitCtx.currentUsd) : null,
          depthExitFlowRatio: Number.isFinite(Number(depthExitCtx?.adverseRatio)) ? Number(depthExitCtx.adverseRatio) : null,
          depthExitStreak: Number.isFinite(Number(depthExitCtx?.streak)) ? Number(depthExitCtx.streak) : null,
          flowAdaptiveSignal: flowAdaptiveCtx?.signal ?? null,
          flowAdaptiveAdverseRatio: Number.isFinite(Number(flowAdaptiveCtx?.adverseRatio)) ? Number(flowAdaptiveCtx.adverseRatio) : null,
          flowAdaptiveAcceleration: Number.isFinite(Number(flowAdaptiveCtx?.acceleration)) ? Number(flowAdaptiveCtx.acceleration) : null,
          flowAdaptiveStreak: Number.isFinite(Number(flowAdaptiveCtx?.streak)) ? Number(flowAdaptiveCtx.streak) : null,
          burstExitSignal: burstExitCtx?.signal ?? null,
          burstExitRateRatio: Number.isFinite(Number(burstExitCtx?.rateRatio)) ? Number(burstExitCtx.rateRatio) : null,
          burstExitFlowPressure: Number.isFinite(Number(burstExitCtx?.flowPressure5)) ? Number(burstExitCtx.flowPressure5) : null,
          burstExitStreak: Number.isFinite(Number(burstExitCtx?.streak)) ? Number(burstExitCtx.streak) : null,
          entryQualityRoutingApplied: entryQualityRoutingDiag ? true : false,
          entryQualityRoutingProfile: entryQualityRoutingDiag?.profile ?? null,
          entryQualityScoreAtExit: Number.isFinite(Number(entryQualityRoutingDiag?.entryQualityScore))
            ? Number(entryQualityRoutingDiag.entryQualityScore)
            : null,
          entryQualityRoutingTimeoutMul: Number.isFinite(Number(entryQualityRoutingDiag?.timeoutMul))
            ? Number(entryQualityRoutingDiag.timeoutMul)
            : null,
          entryQualityRoutingSoftMul: Number.isFinite(Number(entryQualityRoutingDiag?.softMul))
            ? Number(entryQualityRoutingDiag.softMul)
            : null,
          entryQualityRoutingHardMul: Number.isFinite(Number(entryQualityRoutingDiag?.hardMul))
            ? Number(entryQualityRoutingDiag.hardMul)
            : null,
          environmentDriftApplied: environmentDriftDiag ? true : false,
          environmentDriftScore: Number.isFinite(Number(environmentDriftDiag?.driftScore))
            ? Number(environmentDriftDiag.driftScore)
            : null,
          environmentDriftRegimeShift: environmentDriftDiag?.regimeShift === true,
          environmentDriftMapRatio: Number.isFinite(Number(environmentDriftDiag?.mapRatio))
            ? Number(environmentDriftDiag.mapRatio)
            : null,
          environmentDriftHostileFlow: environmentDriftDiag?.hostileFlow === true,
          environmentDriftStreak: Number.isFinite(Number(depthExitState?.driftStreak))
            ? Number(depthExitState.driftStreak)
            : null,
          flowTighteningApplied: flowTighteningDiag ? true : false,
          flowTighteningSoftMul: Number.isFinite(Number(flowTighteningDiag?.softMul)) ? Number(flowTighteningDiag.softMul) : null,
          flowTighteningHardMul: Number.isFinite(Number(flowTighteningDiag?.hardMul)) ? Number(flowTighteningDiag.hardMul) : null,
          holdingPressureApplied: holdingPressureDiag ? true : false,
          holdingPressureTimeoutMul: Number.isFinite(Number(holdingPressureDiag?.timeoutMul)) ? Number(holdingPressureDiag.timeoutMul) : null,
          holdingPressureSoftMul: Number.isFinite(Number(holdingPressureDiag?.softMul)) ? Number(holdingPressureDiag.softMul) : null,
          holdingPressureHardMul: Number.isFinite(Number(holdingPressureDiag?.hardMul)) ? Number(holdingPressureDiag.hardMul) : null,
          bLogicRevision: pos.bLogicRevision || BLOGIC_REVISION,
          // P1: エントリーコンテキスト（再起動時のフォールバック対応）
          structuralDistanceUsd: Number.isFinite((pos.entryContext ?? {}).structuralDistanceUsd)
            ? Number(pos.entryContext.structuralDistanceUsd)
            : -1,
          expectedPnlUsd: Number.isFinite((pos.entryContext ?? {}).expectedPnlUsd)
            ? Number(pos.entryContext.expectedPnlUsd)
            : 0,
          marketRegime: ((pos.entryContext ?? {}).marketRegime || "UNKNOWN").toString().toUpperCase(),
          firepower: Number.isFinite((pos.entryContext ?? {}).firepower)
            ? Number(pos.entryContext.firepower)
            : -1.0,
          ...computeCaptureMetrics(pos, exitPx),
          ...computeCounterfactualRegret(pos, market, pnlNet, tradeConfig),
          ...extractEntryDiag(pos.entryContext)
        };
        
        const tradeWithKpi = withDerivedTradeKpis(trade);
        appendTradeLog(tradeWithKpi, (err) => {
          if (err) {
            console.warn('[TRADE_LOG] failed to append trade log (normal exit)', err?.message || err);
            return;
          }
          // TP到達など通常の exit では notification は不要（Case4 のみで notifyLine を呼ぶ）
        });
        updateTimeoutLossOnlyAlert(state, tradeWithKpi, tradeConfig, nowTs);
        state.riskGuards = updateRiskGuardState(state.riskGuards, exitDecision.reason, pnl, nowTs);
        
        normalExitLoggedThisTick = true;
      }
    }

    // openPosition を最新のメタで更新（_normalExitLogged フラグを付与しない）
    state.openPosition = {
      ...pos,
      tpPx: Number.isFinite(trackedTpPx) ? Number(trackedTpPx) : pos.tpPx,
      tpMode: trackedTpMode ?? pos.tpMode,
      tpStretchActiveAt: trackedTpStretchActiveAt,
      tp2TrailMul: Number.isFinite(Number(trackedTp2TrailMul)) ? Number(trackedTp2TrailMul) : null,
      tp2TrailLastAt: Number.isFinite(Number(trackedTp2TrailLastAt)) ? Number(trackedTp2TrailLastAt) : null,
      depthExitState,
      worstPx,
      hitSoftAtTs,
      maxAdverseRatio
    };
    
    // normalExitLoggedThisTick は後段 Case4 の重複副作用抑止に利用する
  }

  if (typeof decision.size !== 'number' || decision.size < 0 || isNaN(decision.size)) {
    console.warn('[TEST Engine] Invalid decision.size:', decision.size);
    emitEngineError(`[TEST Engine] Invalid decision.size: ${decision?.size}`);
    const newState = {
      ...state,
      lastUpdate: nowTs,
      lastDecision: {
        side: decision.side || 'none',
        size: 0,
        reason: decision.reason || 'invalid_size',
        decidedAt: nowTs
      }
    };
    emitDebugEngine(newState, decision);
    emitEngineEvent('ENGINE_ERROR', {
      type: 'size',
      message: `[TEST Engine] Invalid decision.size: ${decision?.size}`,
      ts: nowTs,
      positionBefore: state.openPosition,
      positionAfter: newState.openPosition,
      decision,
      reason: decision?.reason || 'invalid_size'
    });
    return newState;
  }
  
  const { side, size, reason } = decision;
  
  // ────────────────────────
  // Case 1: side = 'none' → early return (hold)
  // ────────────────────────
  // ← #10修正: noneはポジション保持、逆サイド判定を避ける
  if (side === 'none') {
    const newState = {
      ...state,
      lastDecision: {
        side: 'none',
        size: 0,
        reason: reason || 'none',
        decidedAt: nowTs
      },
      lastUpdate: nowTs
    };
    emitDebugEngine(newState, decision);
    emitEngineEvent('ENGINE_POSITION_UPDATE', {
      type: 'none',
      state: newState,
      ts: nowTs,
      positionBefore: state.openPosition,
      positionAfter: newState.openPosition,
      decision: { side, size, action: 'none' },
      reason: reason || 'none'
    });
    return newState; // ← 重要: ここでリターンして以下の逆サイド判定に進まない
  }
  
  // ────────────────────────
  // Case 2: 新規エントリー (openPosition = null)
  // ────────────────────────
  
  if (!state.openPosition) {
    const startupGuard = decision?.phase4?.startupGuard ?? decision?.startupGuard ?? null;
    if (startupGuard?.noOrderActive === true) {
      const blockReason = startupGuard?.noOrderByAStability
        ? 'order_blocked_until_a_stable'
        : 'order_blocked_startup_window';
      const newState = {
        ...state,
        lastDecision: {
          side: 'none',
          size: 0,
          reason: blockReason,
          decidedAt: nowTs
        },
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, { ...decision, side: 'none', size: 0, reason: blockReason });
      emitEngineEvent('ENGINE_POSITION_UPDATE', {
        type: 'entry_skip',
        state: newState,
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision: { side, size, action: 'entry_skip' },
        reason: blockReason,
        startupGuard: {
          noOrderActive: startupGuard?.noOrderActive === true,
          noOrderByAStability: startupGuard?.noOrderByAStability === true,
          elapsedMs: Number.isFinite(Number(startupGuard?.elapsedMs)) ? Number(startupGuard.elapsedMs) : null,
          noOrderMs: Number.isFinite(Number(startupGuard?.noOrderMs)) ? Number(startupGuard.noOrderMs) : null,
          windowMs: Number.isFinite(Number(startupGuard?.windowMs)) ? Number(startupGuard.windowMs) : null,
          routeMode: startupGuard?.routeMode ?? null
        }
      });
      return newState;
    }

    const perfGuard = state.performanceGuards ?? {};
    if (perfGuard.blockNewEntries) {
      const blockReason = `guard_locked_${perfGuard.reason ?? 'performance'}`;
      const newState = {
        ...state,
        lastDecision: {
          side: 'none',
          size: 0,
          reason: blockReason,
          decidedAt: nowTs
        },
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, { ...decision, side: 'none', size: 0, reason: blockReason });
      emitEngineEvent('ENGINE_POSITION_UPDATE', {
        type: 'entry_skip',
        state: newState,
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision: { side, size, action: 'entry_skip' },
        reason: blockReason
      });
      return newState;
    }

    let effectiveSize = size;
    let effectiveReason = reason || 'entry';
    if (RISK_GUARDS_ENABLED) {
      const guard = ensureRiskGuardState(state.riskGuards);
      if (HARD_SL_COOLDOWN_MS > 0 && guard.lastHardSlAt && (nowTs - guard.lastHardSlAt) < HARD_SL_COOLDOWN_MS) {
        const remainSec = Math.ceil((HARD_SL_COOLDOWN_MS - (nowTs - guard.lastHardSlAt)) / 1000);
        const blockReason = `guard_hard_sl_cooldown_${Math.max(1, remainSec)}s`;
        const newState = {
          ...state,
          lastDecision: {
            side: 'none',
            size: 0,
            reason: blockReason,
            decidedAt: nowTs
          },
          lastUpdate: nowTs
        };
        emitDebugEngine(newState, { ...decision, side: 'none', size: 0, reason: blockReason });
        emitEngineEvent('ENGINE_POSITION_UPDATE', {
          type: 'entry_skip',
          state: newState,
          ts: nowTs,
          positionBefore: state.openPosition,
          positionAfter: newState.openPosition,
          decision: { side, size, action: 'entry_skip' },
          reason: blockReason
        });
        return newState;
      }
      if (
        REDUCE_SIZE_AFTER_LOSS &&
        guard.lastLossAt &&
        REDUCE_SIZE_FACTOR < 1 &&
        (REDUCE_SIZE_WINDOW_MS <= 0 || (nowTs - guard.lastLossAt) <= REDUCE_SIZE_WINDOW_MS)
      ) {
        effectiveSize = size * REDUCE_SIZE_FACTOR;
        effectiveReason = `${effectiveReason}|guard_loss_size_x${REDUCE_SIZE_FACTOR.toFixed(2)}`;
      }
    }

    if (effectiveSize <= 0) {
      // サイズが0以下なら何もしない
      const newState = {
        ...state,
        lastDecision: {
          side,
          size: 0,
          reason: effectiveReason || 'zero_size',
          decidedAt: nowTs
        },
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, decision);
      emitEngineEvent('ENGINE_POSITION_UPDATE', {
        type: 'entry_skip',
        state: newState,
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision: { side, size: effectiveSize, action: 'entry_skip' },
        reason: effectiveReason || 'zero_size'
      });
      return newState;
    }
    
    // tpPx / tpDistanceUsd が欠落している場合はエントリしない
    if (!Number.isFinite(decision?.tpPx) || !Number.isFinite(decision?.tpDistanceUsd) || decision.tpDistanceUsd <= 0) {
      const newState = {
        ...state,
        lastDecision: {
          side,
          size: 0,
          reason: 'entry_skip_tp_missing',
          decidedAt: nowTs
        },
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, decision);
      emitEngineEvent('ENGINE_POSITION_UPDATE', {
        type: 'entry_skip',
        state: newState,
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision: { side, size, action: 'entry_skip' },
        reason: 'entry_skip_tp_missing'
      });
      return newState;
    }

    const preEntryDepth = evaluatePreEntryDepthRecheck({
      side,
      decision,
      market,
      tradeConfig,
      entryPx: midPx,
      nowTs
    });
    if (!preEntryDepth.ok) {
      const skipReason = 'DEPTH_DETERIORATED';
      if (preEntryDepth.observeOnly) {
        decision.preEntryDepthCheck = preEntryDepth.diag;
        decision.preEntryDepthMode = 'observe_only';
        emitEngineEvent('ENGINE_POSITION_UPDATE', {
          type: 'entry_depth_observe',
          state,
          ts: nowTs,
          positionBefore: state.openPosition,
          positionAfter: state.openPosition,
          decision: { side, size: effectiveSize, action: 'entry_depth_observe' },
          reason: skipReason,
          preEntryDepthCheck: preEntryDepth.diag
        });
      } else {
      const skipDecision = {
        ...decision,
        side: 'none',
        size: 0,
        reason: skipReason,
        preEntryDepthCheck: preEntryDepth.diag
      };
      const newState = {
        ...state,
        lastDecision: {
          side: 'none',
          size: 0,
          reason: skipReason,
          decidedAt: nowTs
        },
        lastUpdate: nowTs
      };
      emitDebugEngine(newState, skipDecision);
      emitEngineEvent('ENGINE_POSITION_UPDATE', {
        type: 'entry_skip',
        state: newState,
        ts: nowTs,
        positionBefore: state.openPosition,
        positionAfter: newState.openPosition,
        decision: { side, size: effectiveSize, action: 'entry_skip' },
        reason: skipReason,
        preEntryDepthCheck: preEntryDepth.diag
      });
      return newState;
      }
    }

    const depthExitAnchor = buildDepthExitAnchor(side, market, decision, tradeConfig);
    const newPosition = {
      side,
      size: effectiveSize,
      initialSize: effectiveSize,
      tp1Done: false,
      tp2TrailMul: null,
      tp2TrailLastAt: null,
      entryPx: midPx,
      entryTs: nowTs,
      tpPx: Number(decision.tpPx),
      tpPxRail: Number.isFinite(Number(decision?.tpPxRail)) ? Number(decision.tpPxRail) : Number(decision.tpPx),
      tpPxStretch: Number.isFinite(Number(decision?.tpPxStretch)) ? Number(decision.tpPxStretch) : Number(decision.tpPx),
      tpStretchRatio: Number.isFinite(Number(decision?.tpStretchRatio)) ? Number(decision.tpStretchRatio) : 1.0,
      tpStretchHoldMs: Number.isFinite(Number(decision?.tpStretchHoldMs)) ? Number(decision.tpStretchHoldMs) : 0,
      tpStretchActiveAt: null,
      tpMode: (Number.isFinite(Number(decision?.tpStretchRatio)) && Number(decision.tpStretchRatio) > 1)
        ? 'rail+holdStretch'
        : 'rail',
      tpDistanceUsd: Number(decision.tpDistanceUsd),
      worstPx: midPx,
      hitSoftAtTs: null,
      maxAdverseRatio: 0,
      bLogicRevision: BLOGIC_REVISION,
      entryExecMode: resolveExecMode(decision?.entryProfile?.mode, 'taker'),
      depthExitAnchor,
      depthExitState: createDepthExitState(),
      // エントリー理由を固定保存（後段の上書きを防ぐ）
      entryReasonFixed: decision?.reason || null,
      // P1: エントリーコンテキストの保存（再起動時の引き継ぎ対応）
      entryContext: {
        structuralDistanceUsd: Number.isFinite(Number(decision?.structuralDistanceUsd))
          ? Number(decision.structuralDistanceUsd)
          : (Number.isFinite(decision?.context?.bResult?.structuralDistanceUsd)
            ? Number(decision.context.bResult.structuralDistanceUsd)
            : -1),
        expectedPnlUsd: Number.isFinite(Number(decision?.expectedUsd))
          ? Number(decision.expectedUsd)
          : (Number.isFinite(decision?.context?.bResult?.expectedUsd)
            ? Number(decision.context.bResult.expectedUsd)
            : 0),
        marketRegime: (() => {
          const validRegimes = ["UP", "DOWN", "RANGE", "UNKNOWN"];
          const regime = (
            decision?.context?.bResult?.regime
            ?? decision?.context?.aResult?.regime
            ?? decision?.state
            ?? "UNKNOWN"
          ).toString().toUpperCase();
          return validRegimes.includes(regime) ? regime : "UNKNOWN";
        })(),
        firepower: Number.isFinite(Number(decision?.firepower))
          ? Number(decision.firepower)
          : (Number.isFinite(decision?.context?.bResult?.firepower)
            ? Number(decision.context.bResult.firepower)
            : -1.0),
        entryProfileMode: String(decision?.entryProfile?.mode ?? 'unknown'),
        entryAggressiveness: String(decision?.entryProfile?.aggressiveness ?? 'unknown'),
        entryQualityScore: Number.isFinite(Number(decision?.entryProfile?.entryQualityScore))
          ? Number(decision.entryProfile.entryQualityScore)
          : null,
        higherTfAlignScore: Number.isFinite(Number(decision?.entryProfile?.higherTf?.alignScore))
          ? Number(decision.entryProfile.higherTf.alignScore)
          : null,
        higherTfSizeMul: Number.isFinite(Number(decision?.entryProfile?.higherTf?.sizeMul))
          ? Number(decision.entryProfile.higherTf.sizeMul)
          : null,
        higherTfTpMul: Number.isFinite(Number(decision?.entryProfile?.higherTf?.tpMul))
          ? Number(decision.entryProfile.higherTf.tpMul)
          : null,
        higherTfDir15m: toUpperOr(decision?.entryProfile?.higherTf?.dir15m, 'NONE'),
        higherTfDir1h: toUpperOr(decision?.entryProfile?.higherTf?.dir1h, 'NONE'),
        plannedTpSource: String(decision?.tpSource ?? decision?.context?.bResult?.tpSource ?? 'unknown'),
        plannedTpPhase: String(decision?.tpPhase ?? decision?.context?.bResult?.tpPhase ?? 'unknown'),
        supportPrice: Number.isFinite(Number(decision?.supportPrice)) ? Number(decision.supportPrice) : null,
        resistancePrice: Number.isFinite(Number(decision?.resistancePrice)) ? Number(decision.resistancePrice) : null,
        distToSupport: Number.isFinite(Number(decision?.distToSupport)) ? Number(decision.distToSupport) : null,
        distToResistance: Number.isFinite(Number(decision?.distToResistance)) ? Number(decision.distToResistance) : null,
        bandLower: Number.isFinite(Number(decision?.bandLower)) ? Number(decision.bandLower) : null,
        bandUpper: Number.isFinite(Number(decision?.bandUpper)) ? Number(decision.bandUpper) : null,
        structuralPairType: decision?.structuralPairType ?? decision?.context?.bResult?.structuralPairType ?? null,
        distanceReason: decision?.distanceReason ?? decision?.context?.bResult?.distanceReason ?? null,
        plannedStructureSource: String(
          decision?.structureSnapshot?.structureSource
          ?? decision?.context?.structureSnapshot?.structureSource
          ?? 'unknown'
        ),
        plannedStructureBasis: String(
          decision?.structureSnapshot?.basis
          ?? decision?.context?.structureSnapshot?.basis
          ?? 'unknown'
        ),
        plannedStructureSpanUsd: Number.isFinite(Number(
          decision?.structureSnapshot?.span
          ?? decision?.structureSnapshot?.spanUsd
          ?? decision?.context?.structureSnapshot?.spanUsd
        ))
          ? Number(
            decision?.structureSnapshot?.span
            ?? decision?.structureSnapshot?.spanUsd
            ?? decision?.context?.structureSnapshot?.spanUsd
          )
          : null,
        mapClusterCount: Number.isFinite(Number(decision?.phase1?.srClusters?.count ?? decision?.context?.bResult?.phase1?.srClusters?.count))
          ? Number(decision?.phase1?.srClusters?.count ?? decision?.context?.bResult?.phase1?.srClusters?.count)
          : null,
        mapPathDepth: Number.isFinite(Number(decision?.phase1?.srClusters?.pathDepth ?? decision?.context?.bResult?.phase1?.srClusters?.pathDepth))
          ? Number(decision?.phase1?.srClusters?.pathDepth ?? decision?.context?.bResult?.phase1?.srClusters?.pathDepth)
          : null,
        mapStrength: Number.isFinite(Number(decision?.phase1?.srClusters?.mapStrength ?? decision?.context?.bResult?.phase1?.srClusters?.mapStrength))
          ? Number(decision?.phase1?.srClusters?.mapStrength ?? decision?.context?.bResult?.phase1?.srClusters?.mapStrength)
          : null,
        mapStatus: String(decision?.phase1?.srClusters?.mapStatus ?? decision?.context?.bResult?.phase1?.srClusters?.mapStatus ?? 'unknown'),
        plannedTp1: Number.isFinite(Number(decision?.tpLadder?.tp1)) ? Number(decision.tpLadder.tp1) : null,
        plannedTp2: Number.isFinite(Number(decision?.tpLadder?.tp2)) ? Number(decision.tpLadder.tp2) : null,
        plannedTpEdge: Number.isFinite(Number(decision?.tpLadder?.edge)) ? Number(decision.tpLadder.edge) : null,
        ladderAttackScalar: Number.isFinite(Number(decision?.sizeFactors?.ladderAttackScalar))
          ? Number(decision.sizeFactors.ladderAttackScalar)
          : null,
        feeEdgeBoosted: !!decision?.entryProfile?.feeEdgeBoosted,
        feeEdgeBoostMul: Number.isFinite(Number(decision?.sizeFactors?.feeEdgeBoostMul))
          ? Number(decision.sizeFactors.feeEdgeBoostMul)
          : null,
        sizeScalarCombined: Number.isFinite(Number(decision?.sizeFactors?.combined))
          ? Number(decision.sizeFactors.combined)
          : null
      }
    };
    
    const newState = {
      ...state,
      openPosition: newPosition,
      lastDecision: {
        side,
        size: effectiveSize,
        reason: effectiveReason || 'entry',
        decidedAt: nowTs
      },
      lastUpdate: nowTs
    };
    emitDebugEngine(newState, decision);
    emitEngineEvent('ENGINE_POSITION_UPDATE', {
      type: 'entry',
      state: newState,
      ts: nowTs,
      positionBefore: state.openPosition,
      positionAfter: newState.openPosition,
      decision: { side, size: effectiveSize, action: 'entry' },
      reason: effectiveReason || 'entry'
    });
    return newState;
  }
  
  // ────────────────────────
  // Case 3: 同サイド (追加エントリーなし)
  // ────────────────────────
  
  if (state.openPosition.side === side) {
    const newState = {
      ...state,
      lastDecision: {
        side,
        size,
        reason: reason || 'same_side_hold',
        decidedAt: nowTs
      },
      lastUpdate: nowTs
    };
    emitDebugEngine(newState, decision);
    emitEngineEvent('ENGINE_POSITION_UPDATE', {
      type: 'hold',
      state: newState,
      ts: nowTs,
      positionBefore: state.openPosition,
      positionAfter: newState.openPosition,
      decision: { side, size, action: 'hold' },
      reason: reason || 'same_side_hold'
    });
    return newState;
  }
  
  // ────────────────────────
  // Case 4: 逆サイド → EXIT処理
  // ────────────────────────
  // 
  // 【決定木ロジック】
  // このコード段に到達するのは以下の条件をすべて満たす場合のみ：
  //   1. openPosition exists (ポジション保持中)
  //   2. decision.side !== 'none' (新しい判定あり)
  //   3. decision.side !== pos.side (逆サイド判定)
  //   4. decision.side !== 'none' || decision.side === pos.side の条件を満たさない
  //
  // 逆に、openPosition 監視ブロック（L264-425）での通常 EXIT
  // (tp_hit / hard_sl_ratio / soft_sl_timeout / timeout_loss_only) は
  // 以下の条件により Case4 には到達しない：
  //   - exitDecision が生成されて decision ← exitDecision が実行される
  //   - decision.side !== 'none' になるが、decision.side === pos.side なので
  //     if (decisionSide === 'none' || decisionSide === pos.side) 内で処理
  //   - appendTradeLog は即座に実行、openPosition ← null に設定
  //   - case 2 / case 3 に分岐して関数 return（Case4 到達なし）
  //
  // つまり：
  //   • 通常 EXIT: openPosition ブロック → case 2/3 → return（logging済み）
  //   • 逆サイド: Case 4 のみで exit （logging はここで実行）
  //   • 重複ロギング: 決定木の構造により物理的に不可能 ✓
  //
  const pos = state.openPosition;
  const exitPxRaw = Number(midPx);
  const entryPxRaw = Number(pos.entryPx);
  const posSizeRaw = Number(pos.size);
  const validPnlInputs =
    Number.isFinite(exitPxRaw) &&
    exitPxRaw > 0 &&
    Number.isFinite(entryPxRaw) &&
    entryPxRaw > 0 &&
    Number.isFinite(posSizeRaw) &&
    posSizeRaw > 0;
  const exitPx = validPnlInputs ? exitPxRaw : 0;
  const entryPx = validPnlInputs ? entryPxRaw : 0;
  const posSize = validPnlInputs ? posSizeRaw : 0;
  if (!validPnlInputs) {
    try {
      console.warn('[ENGINE] invalid pnl inputs detected on reverse-side close; fallback to zero pnl');
    } catch (_) {}
  }
  // PnL計算
  let pnl = 0;
  if (pos.side === 'buy') {
    // buy → sell
    pnl = (exitPx - entryPx) * posSize;
  } else {
    // sell → buy
    pnl = (entryPx - exitPx) * posSize;
  }
  const notional = entryPx * posSize;
  const pnlPct = (notional > 0) ? (pnl / notional) * 100 : 0;
  const entryExecMode = resolveExecMode(pos.entryExecMode, 'taker');
  const exitExecMode = 'taker';
  const fee = estimateFeesUsd(notional, entryExecMode, exitExecMode, tradeConfig);
  const pnlNet = pnl - fee.feeUsd;
  const pnlPctNet = (notional > 0) ? (pnlNet / notional) * 100 : 0;
  // TradeRecord作成
  const tradeId = crypto.randomUUID();
  const isNormalExitPath = decision?.isNormalExit === true;
  const closeReason = isNormalExitPath
    ? (typeof reason === 'string' && reason.length > 0 ? reason : 'exit')
    : 'reverse_side_close';
  const trade = {
    tradeId,
    side: pos.side,
    size: posSize,
    entryPx,
    exitPx,
    pnl,
    pnlNet,
    pnlPct,
    pnlPctNet,
    feeUsd: fee.feeUsd,
    entryFeeUsd: fee.entryFeeUsd,
    exitFeeUsd: fee.exitFeeUsd,
    entryExecMode,
    exitExecMode,
    openedAt: pos.entryTs,
    closedAt: nowTs,
    reason: closeReason,
    tpDistanceUsd: Number.isFinite(Number(pos.tpDistanceUsd)) ? Number(pos.tpDistanceUsd) : null,
    tpPx: Number.isFinite(Number(pos.tpPx)) ? Number(pos.tpPx) : null,
    tp2TrailMul: Number.isFinite(Number(pos.tp2TrailMul)) ? Number(pos.tp2TrailMul) : null,
    maxAdverseRatio: Number.isFinite(Number(pos.maxAdverseRatio)) ? Number(pos.maxAdverseRatio) : null,
    bLogicRevision: pos.bLogicRevision || BLOGIC_REVISION
  };
  // 勝敗判定（FLATは除外）
  let winTrades = state.stats.winTrades;
  let loseTrades = state.stats.loseTrades;
  let longTrades = state.stats.longTrades ?? 0;
  let shortTrades = state.stats.shortTrades ?? 0;
  let longWins = state.stats.longWins ?? 0;
  let shortWins = state.stats.shortWins ?? 0;
  const isLong = pos.side === 'buy';
  if (pnl > 0) {
    winTrades++;
    if (isLong) {
      longTrades++;
      longWins++;
    } else {
      shortTrades++;
      shortWins++;
    }
  } else if (pnl < 0) {
    loseTrades++;
    if (isLong) {
      longTrades++;
    } else {
      shortTrades++;
    }
  }
  const totalTrades = winTrades + loseTrades;
  // realizedPnl / realizedPnlPct 更新
  const safePnl = Number.isFinite(pnl) ? pnl : 0;
  const safePnlPct = Number.isFinite(pnlPct) ? pnlPct : 0;
  const realizedPnl = state.stats.realizedPnl + safePnl;
  const realizedPnlPct = state.stats.realizedPnlPct + safePnlPct;
  // history7d に追加
  let history7d = [...state.stats.history7d, trade];
  // 7日より古いものを削除
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoffTs = nowTs - SEVEN_DAYS_MS;
  // 7日より古いものを削除（境界値は除外し、常に「直近7日間」のみ保持）
  history7d = history7d.filter(t => t.closedAt > cutoffTs);
  // APR7d 計算
  const apr7d = calculateAPR7d(history7d);
  // trades に追加 (最大50件)
  let newState = pushTrade(state, trade, 50);
  const nextRiskGuards = updateRiskGuardState(state.riskGuards, reason, pnl, nowTs);
  // Stats更新
  newState = {
    ...newState,
    openPosition: null, // EXIT完了
    riskGuards: nextRiskGuards,
    stats: {
      realizedPnl,
      realizedPnlPct,
      winTrades,
      loseTrades,
      totalTrades,
      longTrades,
      longWins,
      shortTrades,
      shortWins,
      apr7d,
      history7d,
      midPx: state.stats.midPx,
      prevMidPx: state.stats.prevMidPx,
      oi: state.stats.oi
    },
    lastDecision: {
      side,
      size,
      reason: reason || 'exit',
      decidedAt: nowTs
    },
    lastUpdate: nowTs
  };
  emitDebugEngine(newState, decision);
  emitEngineEvent('ENGINE_PNL_UPDATE', {
    type: 'exit',
    trade,
    state: newState,
    ts: nowTs,
    positionBefore: state.openPosition,
    positionAfter: newState.openPosition,
    realizedPnlBefore: state.stats.realizedPnl,
    realizedPnlAfter: newState.stats.realizedPnl,
    decision: { side, size, action: 'exit' },
    reason: reason || 'exit'
  });
  const holdMs = nowTs - pos.entryTs;
  const exitReasonContext = {
    tpDistanceUsd: Number.isFinite(Number(pos.tpDistanceUsd)) ? Number(pos.tpDistanceUsd) : null,
    maxAdverseRatio: Number.isFinite(Number(pos.maxAdverseRatio)) ? Number(pos.maxAdverseRatio) : null,
    holdMs
  };
  const exitReasonMapped = mapExitReason(reason, entryPx, exitPx, exitReasonContext);
  
  // Case4: 逆サイド exit の場合のみここに到達
  // ┌─ 重複ロギング防止の仕組み ──────────────────────────────
  // │
  // │ openPosition 監視ブロックでの exit（tp_hit/hard_sl_ratio など）:
  // │   → decision = exitDecision となり、decisionSide === pos.side
  // │   → logging 実行後、openPosition → null
  // │   → case 2/3 に分岐（normal exit）
  // │   → Case4 には到達しない ✓
  // │
  // │ 逆サイド entry（decision.side != pos.side）:
  // │   → exitDecision は null（normal exit ではない）
  // │   → case 4 に分岐（reverse_side_close）
  // │   → logging 実行（ここ） ✓
  // │
  // └─────────────────────────────────────────────────────────
  // つまり、決定木により normal exit と reverse_side_close は
  // 同一 tick 内で同時発生不可能。
  
  // 分析用トレードログ（確定時のみ）
  if (!normalExitLoggedThisTick) {
    const reverseExitTrade = withDerivedTradeKpis({
      tradeId,
      ts: nowTs,
      entryTs: pos.entryTs,
      exitTs: nowTs,
      timestampEntry: pos.entryTs,
      timestampExit: nowTs,
      holdMs,
      side: isLong ? 'LONG' : 'SHORT',
      zone: null,
      marketState: MARKET_STATE_UNKNOWN,
      signal: decision?.reason ?? null,
      safety: state?.safety?.status ?? null,
      entryPrice: entryPx,
      exitPrice: exitPx,
      size: posSize,
      notional,
      realizedPnlUsd: pnl,
      realizedPnlNetUsd: pnlNet,
      feeUsd: fee.feeUsd,
      entryFeeUsd: fee.entryFeeUsd,
      exitFeeUsd: fee.exitFeeUsd,
      entryExecMode,
      exitExecMode,
      realizedPnlPctTrade: pnlPct,
      realizedPnlPctTradeNet: pnlPctNet,
        result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT',
        wsStateAtEntry: null,
        wsStateAtExit: null,
        exitReason: exitReasonMapped.reason,
        exitSignal: exitReasonMapped.signal,
        exitReasonDetail: exitReasonMapped.detail,
        exitLabel: null,
        latencyMs: null,
        tpDistanceUsd: Number.isFinite(Number(pos.tpDistanceUsd)) ? Number(pos.tpDistanceUsd) : null,
        tpPx: Number.isFinite(Number(pos.tpPx)) ? Number(pos.tpPx) : null,
        tp2TrailMul: Number.isFinite(Number(pos.tp2TrailMul)) ? Number(pos.tp2TrailMul) : null,
        maxAdverseRatio: Number.isFinite(Number(pos.maxAdverseRatio)) ? Number(pos.maxAdverseRatio) : null,
        hitSoftAtTs: pos.hitSoftAtTs ?? null,
        bLogicRevision: pos.bLogicRevision || BLOGIC_REVISION,
        structuralDistanceUsd: Number.isFinite((pos.entryContext ?? {}).structuralDistanceUsd)
          ? Number(pos.entryContext.structuralDistanceUsd)
          : -1,
        expectedPnlUsd: Number.isFinite((pos.entryContext ?? {}).expectedPnlUsd)
          ? Number(pos.entryContext.expectedPnlUsd)
          : 0,
        marketRegime: ((pos.entryContext ?? {}).marketRegime || "UNKNOWN").toString().toUpperCase(),
        firepower: Number.isFinite((pos.entryContext ?? {}).firepower)
          ? Number(pos.entryContext.firepower)
          : -1.0,
        ...computeCaptureMetrics(pos, exitPx),
        ...computeCounterfactualRegret(pos, market, pnlNet, tradeConfig),
        ...extractEntryDiag(pos.entryContext)
      });
    appendTradeLog(reverseExitTrade, (err) => {
        if (err) {
          console.warn('[TRADE_LOG] failed to append trade log', err?.message || err);
          return;
        }
      });
    updateTimeoutLossOnlyAlert(state, reverseExitTrade, tradeConfig, nowTs);
    notifyLine(trade, newState.stats.realizedPnl);
    checkWinRateMilestones(newState.stats.realizedPnl);
  }
  return newState;
}

/**
 * calculateAPR7d
 * 仕様に基づき「累積PnL / baseAsset × 365 / days」で算出する単利APR
 * - baseAsset: 1000 (fixture)
 * - days: history7d の経過日数 (最小1日, 最大7日)
 * - pnl: history7d の pnl 合計 (USD)
 * @param {Array} history7d - TradeRecord[]
 * @returns {number} APR7d (年率%)
 */
function calculateAPR7d(history7d) {
  if (!history7d || history7d.length === 0) {
    return null;
  }

  const baseAsset = getInitialCapitalUsd();
  if (!baseAsset) {
    return null;
  }

  // 累積PnL（USD合計）
  const totalPnl = history7d.reduce((sum, t) => sum + (Number.isFinite(Number(t?.pnlNet)) ? Number(t.pnlNet) : (Number(t?.pnl) || 0)), 0);

  // 経過日数を算出（最小1日, 最大7日）
  const msPerDay = 24 * 60 * 60 * 1000;
  const times = history7d
    .map(t => Number(t.closedAt))
    .filter(ts => Number.isFinite(ts));
  let days = 1;
  if (times.length > 0) {
    const minTs = Math.min(...times);
    const maxTs = Math.max(...times);
    const spanDays = Math.ceil((maxTs - minTs) / msPerDay) + 1; // 同日なら1日
    days = Math.min(7, Math.max(1, spanDays));
  }

  // 仕様: APR = (累積PnL / baseAsset) * (365 / days)
  let apr = (totalPnl / baseAsset) * (365 / days);
  
  if (isNaN(apr) || !isFinite(apr)) {
    return null;
  }

  // 浮動小数誤差で 3.65 が 3.7 に丸まらないよう微小調整（ゼロ方向にバイアス）
  const bias = 1e-9 * Math.sign(apr || 0);
  return apr - bias;
}

export { updateEngine, touchTick, evaluateSafety };

function emitDebugEngine(state, decision) {
  try {
    const pos = state?.openPosition;
    bridgeEmitter.emit('debug-packet', {
      layer: 'engine',
      ts: Date.now(),
      data: {
        decision: decision?.side || 'none',
        pnl: state?.stats?.realizedPnl,
        pnlPct: state?.stats?.realizedPnlPct,
        apr7d: state?.stats?.apr7d,
        winTrades: state?.stats?.winTrades,
        loseTrades: state?.stats?.loseTrades,
        totalTrades: state?.stats?.totalTrades,
        openPosition: pos ? { side: pos.side, qty: pos.size, price: pos.entryPx, ts: pos.entryTs } : null
      }
    });
  } catch (err) {
    console.error('[ENGINE] emitDebugEngine failed', err);
  }
}

function emitEngineError(message) {
  try {
    bridgeEmitter.emit('debug-error', { layer: 'engine', message, ts: Date.now() });
  } catch (err) {
    console.error('[ENGINE] emitEngineError failed', err);
  }
}
