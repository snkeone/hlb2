// 実体ランタイム: WSサーバとエンジンループ
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInitialState } from '../engine/state.js';
import { updateEngine, touchTick, evaluateSafety } from '../engine/update.js';
import { decideTrade } from '../logic/index.js';
import { getIOPacket, getExecutorPayload } from '../io/index.js';
import { loadEngineState, saveEngineState } from '../engine/stateStore.js';
import { resolveTradesPath } from '../config/tradesPath.js';
import { resolveStatePath } from '../config/statePath.js';
import bridgeEmitter from '../core/bridgeEmitter.js';
import { evaluateDataState } from './status/evaluator.js';
import { STOP_REASONS } from '../core/stopReasons.js';
import { loadCapitalFromFile, getInitialCapitalUsd } from '../config/capital.js';
import { loadBaseEquityLiveFromFile, getBaseEquityLiveUsd, getFallbackEquityUsd } from '../config/equity.js';
import { createDecisionMonitor } from './decision_monitor.js';
import { write as writeLog } from './utils/logger.js';
import { buildHealthReport } from '../core/healthState.js';
import { getTradeConfig, resolveB1SnapshotRefreshSetting, startTradeConfigAutoReload } from '../config/trade.js';
import { updateIOConfigForHotReload } from '../io/index.js';
import { fetchLiveEquity } from '../core/balanceFetcher.js';
import { getDecisionTraceSnapshot } from '../core/decisionTraceCache.js';
import { resolveReasonCode, REASON_CODE } from '../logic/reasonCodes.js';

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function calcBookImbalance(market) {
  const bids = Array.isArray(market?.bids) ? market.bids : [];
  const asks = Array.isArray(market?.asks) ? market.asks : [];
  const sumUsd = (levels) => levels.slice(0, 20).reduce((acc, lv) => {
    const px = toFiniteNumber(lv?.price ?? lv?.px, null);
    const sz = toFiniteNumber(lv?.size ?? lv?.sz, null);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) return acc;
    return acc + (px * sz);
  }, 0);
  const bidUsd = sumUsd(bids);
  const askUsd = sumUsd(asks);
  const total = bidUsd + askUsd;
  return total > 0 ? (bidUsd - askUsd) / total : 0;
}

function calcSpreadBps(market) {
  const bid = toFiniteNumber(market?.bestBidPx, null);
  const ask = toFiniteNumber(market?.bestAskPx, null);
  const mid = toFiniteNumber(market?.midPx, null);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(mid) || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10000;
}

function calcBurstUsd1s(market) {
  const windows = market?.tradeFlow?.windows ?? {};
  const w5 = windows['5000'] ?? windows[5000] ?? null;
  const vol5 = toFiniteNumber(w5?.volumeUsd, 0);
  return vol5 > 0 ? (vol5 / 5) : 0;
}

function calcDynSlipBps(spreadBps, pressureImb, burstUsd1s) {
  const s = Number.isFinite(spreadBps) ? spreadBps : 0;
  const imbAbs = Number.isFinite(pressureImb) ? Math.abs(pressureImb) : 0;
  const burst = Number.isFinite(burstUsd1s) ? burstUsd1s : 0;
  return 1.5 + (1.0 * s) + (0.5 * imbAbs) + (0.1 * (burst / 100000));
}

function buildWsLiveSnapshot(market, ioMetrics = null) {
  const tradeFlow = market?.tradeFlow ?? null;
  const windows = tradeFlow?.windows ?? {};
  const w5 = windows['5000'] ?? windows[5000] ?? null;
  const w60 = windows['60000'] ?? windows[60000] ?? null;
  const midPx = toFiniteNumber(market?.midPx, null);
  const impactBidPx = toFiniteNumber(market?.impactBidPx, null);
  const impactAskPx = toFiniteNumber(market?.impactAskPx, null);
  const impactSpreadBps = (Number.isFinite(midPx) && midPx > 0 && Number.isFinite(impactBidPx) && Number.isFinite(impactAskPx))
    ? ((impactAskPx - impactBidPx) / midPx) * 10000
    : null;
  const buyRatio5s = Number.isFinite(toFiniteNumber(w5?.volumeUsd, null)) && Number(w5.volumeUsd) > 0
    ? Number(w5.buyVolumeUsd ?? 0) / Number(w5.volumeUsd)
    : null;
  const buyRatio60s = Number.isFinite(toFiniteNumber(w60?.volumeUsd, null)) && Number(w60.volumeUsd) > 0
    ? Number(w60.buyVolumeUsd ?? 0) / Number(w60.volumeUsd)
    : null;
  const bar1hState = ioMetrics?.bar1hState ?? null;
  const bLrcSlope = toFiniteNumber(ioMetrics?.lrcTvState?.slope ?? ioMetrics?.lrcState?.slope, null);
  const bLrcAngleDeg = Number.isFinite(bLrcSlope)
    ? (Math.atan(bLrcSlope) * 180) / Math.PI
    : null;
  const bar15mBackfill = ioMetrics?.bar15mBackfill ?? null;
  const bar1hBackfill = ioMetrics?.bar1hBackfill ?? null;
  return {
    flowPressure: toFiniteNumber(tradeFlow?.flowPressure, null),
    acceleration: toFiniteNumber(tradeFlow?.acceleration, null),
    tradeCount: toFiniteNumber(tradeFlow?.tradeCount, 0),
    tradeRate5s: toFiniteNumber(w5?.tradeRatePerSec, null),
    tradeRate60s: toFiniteNumber(w60?.tradeRatePerSec, null),
    buyRatio5s,
    buyRatio60s,
    largeTradeCount5s: toFiniteNumber(w5?.largeTradeCount, 0),
    largeTradeCount60s: toFiniteNumber(w60?.largeTradeCount, 0),
    oiDelta: toFiniteNumber(tradeFlow?.oiDelta, null),
    funding: toFiniteNumber(market?.funding, null),
    premium: toFiniteNumber(market?.premium, null),
    impactSpreadBps,
    aCandleReady: bar1hState?.ready === true,
    aCandleBarCount: toFiniteNumber(bar1hState?.barCount, null),
    aCandleHigh: toFiniteNumber(bar1hState?.high, null),
    aCandleLow: toFiniteNumber(bar1hState?.low, null),
    bLrcAngleDeg,
    vwap5s: toFiniteNumber(w5?.vwap, null),
    vwap60s: toFiniteNumber(w60?.vwap, null),
    dayNtlVlm: toFiniteNumber(market?.dayNtlVlm, null),
    bar15mBackfill: bar15mBackfill ? {
      enabled: bar15mBackfill?.enabled === true,
      inFlight: bar15mBackfill?.inFlight === true,
      completed: bar15mBackfill?.completed === true,
      attempts: toFiniteNumber(bar15mBackfill?.attempts, 0),
      neededBars: toFiniteNumber(bar15mBackfill?.neededBars, 0),
      currentCount: toFiniteNumber(bar15mBackfill?.currentCount, 0),
      remainingBars: toFiniteNumber(bar15mBackfill?.remainingBars, 0),
      nextRetryInMs: toFiniteNumber(bar15mBackfill?.nextRetryInMs, 0),
      lastError: bar15mBackfill?.lastError ?? null
    } : null,
    bar1hBackfill: bar1hBackfill ? {
      enabled: bar1hBackfill?.enabled === true,
      inFlight: bar1hBackfill?.inFlight === true,
      completed: bar1hBackfill?.completed === true,
      attempts: toFiniteNumber(bar1hBackfill?.attempts, 0),
      neededBars: toFiniteNumber(bar1hBackfill?.neededBars, 0),
      currentCount: toFiniteNumber(bar1hBackfill?.currentCount, 0),
      remainingBars: toFiniteNumber(bar1hBackfill?.remainingBars, 0),
      nextRetryInMs: toFiniteNumber(bar1hBackfill?.nextRetryInMs, 0),
      lastError: bar1hBackfill?.lastError ?? null
    } : null
  };
}

function buildGateSnapshot(decision) {
  const context = decision?.context ?? {};
  const aResult = context?.aResult ?? {};
  const bResult = context?.bResult ?? {};
  const metaGate = context?.metaGate ?? {};
  const phase4 = decision?.phase4 ?? bResult?.phase4 ?? {};
  const entryProfile = bResult?.entryProfile ?? decision?.entryProfile ?? {};
  const startupGuard = phase4?.startupGuard ?? bResult?.startupGuard ?? decision?.startupGuard ?? null;
  const startupElapsedMs = toFiniteNumber(startupGuard?.elapsedMs, 0);
  const startupNoOrderMs = Math.max(0, toFiniteNumber(startupGuard?.noOrderMs, 0));
  const startupWindowMs = Math.max(0, toFiniteNumber(startupGuard?.windowMs, 0));
  const startupNoOrderRemainingMs = startupGuard
    ? Math.max(0, startupNoOrderMs - startupElapsedMs)
    : null;
  const startupWindowRemainingMs = startupGuard
    ? Math.max(0, startupWindowMs - startupElapsedMs)
    : null;
  return {
    regime: aResult?.regime ?? bResult?.state ?? null,
    metaAllow: metaGate?.allow ?? null,
    metaScore: toFiniteNumber(metaGate?.score, null),
    metaReason: metaGate?.reason ?? null,
    metaDiag: metaGate?.diagnostics ?? null,
    aAllow: aResult?.allow ?? aResult?.aValid ?? null,
    aReason: aResult?.reason ?? aResult?.aReason ?? null,
    bSide: bResult?.side ?? decision?.side ?? null,
    bReason: decision?.reason ?? bResult?.reason ?? null,
    bZone: bResult?.zone ?? decision?.zone ?? null,
    firepower: toFiniteNumber(bResult?.firepower ?? decision?.firepower, null),
    entryMode: entryProfile?.mode ?? null,
    aggressiveness: entryProfile?.aggressiveness ?? null,
    flowGate: phase4?.flowGate ?? null,
    ctxGate: phase4?.ctxGate ?? null,
    oiTrapGate: phase4?.oiTrapGate ?? null,
    startupGuard: startupGuard ? {
      active: startupGuard?.active === true,
      phase: startupGuard?.phase ?? null,
      noOrderActive: startupGuard?.noOrderActive === true,
      restrictedActive: startupGuard?.restrictedActive === true,
      elapsedMs: startupElapsedMs,
      noOrderMs: startupNoOrderMs,
      windowMs: startupWindowMs,
      noOrderRemainingMs: startupNoOrderRemainingMs,
      windowRemainingMs: startupWindowRemainingMs,
      liveBlockUntilAStable: startupGuard?.liveBlockUntilAStable === true
    } : null
  };
}

function buildExitSignalsSnapshot(openPosition, market, tradeConfig, nowTs = Date.now()) {
  if (!openPosition || typeof openPosition !== 'object') return null;
  const midPx = toFiniteNumber(market?.midPx, null);
  const isLong = openPosition.side === 'buy';
  const holdMs = Math.max(0, nowTs - toFiniteNumber(openPosition.entryTs, nowTs));
  const entryPx = toFiniteNumber(openPosition.entryPx, null);
  const size = toFiniteNumber(openPosition.size, null);
  const tpPx = toFiniteNumber(openPosition.tpPx, null);
  const tpDist = toFiniteNumber(openPosition.tpDistanceUsd, null);
  const forwardUsd = (Number.isFinite(midPx) && Number.isFinite(entryPx))
    ? (isLong ? (midPx - entryPx) : (entryPx - midPx))
    : null;
  const tpProgressRatio = (Number.isFinite(forwardUsd) && Number.isFinite(tpDist) && tpDist > 0)
    ? clamp(forwardUsd / tpDist, -1, 2)
    : null;
  const unrealizedUsd = (Number.isFinite(forwardUsd) && Number.isFinite(size))
    ? forwardUsd * size
    : null;
  const worstPx = toFiniteNumber(openPosition.worstPx, entryPx);
  const adverseUsd = (Number.isFinite(entryPx) && Number.isFinite(worstPx))
    ? Math.max(0, isLong ? (entryPx - worstPx) : (worstPx - entryPx))
    : null;
  const adverseRatio = (Number.isFinite(adverseUsd) && Number.isFinite(tpDist) && tpDist > 0)
    ? adverseUsd / tpDist
    : null;
  const depthExitState = (openPosition.depthExitState && typeof openPosition.depthExitState === 'object')
    ? openPosition.depthExitState
    : {};
  const flowCfg = tradeConfig?.flowAdaptiveExit ?? {};
  const earlyTakeProfitCfg = flowCfg?.earlyTakeProfit ?? {};
  const depthAwareCfg = tradeConfig?.depthAwareExit ?? {};
  const envCfg = flowCfg?.environmentDrift ?? {};
  const burstCfg = flowCfg?.burstExit ?? {};
  const required = {
    flowTp: Math.max(1, Math.floor(toFiniteNumber(earlyTakeProfitCfg?.minConsecutiveTicks, 2))),
    burst: Math.max(1, Math.floor(toFiniteNumber(burstCfg?.minTicks, 1))),
    drift: Math.max(1, Math.floor(toFiniteNumber(envCfg?.minConsecutiveTicks, 2))),
    shield: Math.max(1, Math.floor(toFiniteNumber(depthAwareCfg?.shieldConsecutiveTicks, 3))),
    wall: Math.max(1, Math.floor(toFiniteNumber(depthAwareCfg?.wallConsecutiveTicks, 2))),
    flow: Math.max(1, Math.floor(toFiniteNumber(depthAwareCfg?.flowConsecutiveTicks, 2)))
  };
  const lastSignalAt = toFiniteNumber(depthExitState?.lastSignalAt, null);
  return {
    side: openPosition.side ?? null,
    holdSec: Math.floor(holdMs / 1000),
    unrealizedUsd,
    tpProgressRatio,
    adverseRatio,
    entryMode: openPosition?.entryContext?.entryProfileMode ?? null,
    entryQualityScore: toFiniteNumber(openPosition?.entryContext?.entryQualityScore, null),
    lastSignal: depthExitState?.lastSignal ?? null,
    lastSignalAgeSec: Number.isFinite(lastSignalAt) ? Math.max(0, Math.floor((nowTs - lastSignalAt) / 1000)) : null,
    streaks: {
      flowTp: Math.max(0, Math.floor(toFiniteNumber(depthExitState?.flowTpStreak, 0))),
      burst: Math.max(0, Math.floor(toFiniteNumber(depthExitState?.burstStreak, 0))),
      drift: Math.max(0, Math.floor(toFiniteNumber(depthExitState?.driftStreak, 0))),
      shield: Math.max(0, Math.floor(toFiniteNumber(depthExitState?.shieldStreak, 0))),
      wall: Math.max(0, Math.floor(toFiniteNumber(depthExitState?.wallStreak, 0))),
      flow: Math.max(0, Math.floor(toFiniteNumber(depthExitState?.flowStreak, 0)))
    },
    required
  };
}

function buildPositionSnapshot(openPosition, market, tradeConfig, nowTs = Date.now()) {
  if (!openPosition || typeof openPosition !== 'object') return null;
  const side = String(openPosition?.side ?? '').toLowerCase();
  const isLong = side === 'buy';
  const entryPx = toFiniteNumber(openPosition?.entryPx, null);
  const currentPx = toFiniteNumber(market?.midPx, null);
  const size = toFiniteNumber(openPosition?.size, null);
  const holdSec = Math.max(0, Math.floor((nowTs - toFiniteNumber(openPosition?.entryTs, nowTs)) / 1000));
  const unrealizedPnl = (Number.isFinite(entryPx) && Number.isFinite(currentPx) && Number.isFinite(size))
    ? (isLong ? (currentPx - entryPx) : (entryPx - currentPx)) * size
    : null;
  const unrealizedPnlPct = (Number.isFinite(unrealizedPnl) && Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(size) && size > 0)
    ? (unrealizedPnl / (entryPx * size)) * 100
    : null;
  const worstPx = toFiniteNumber(openPosition?.worstPx, null);
  const worstPnl = (Number.isFinite(entryPx) && Number.isFinite(worstPx) && Number.isFinite(size))
    ? (isLong ? (worstPx - entryPx) : (entryPx - worstPx)) * size
    : null;
  const lossTimeout = tradeConfig?.lossTimeout ?? {};
  const timeoutMs = toFiniteNumber(lossTimeout?.timeoutMs, null);
  return {
    side,
    size,
    entryPx,
    currentPx,
    tpPx: toFiniteNumber(openPosition?.tpPx, null),
    tpDistanceUsd: toFiniteNumber(openPosition?.tpDistanceUsd, null),
    holdingSec: holdSec,
    unrealizedPnl,
    unrealizedPnlPct,
    worstPnl,
    worstPx,
    softSLRatio: toFiniteNumber(lossTimeout?.softRatio, null),
    hardSLRatio: toFiniteNumber(lossTimeout?.hardRatio, null),
    timeoutSec: Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs / 1000)) : null,
    entryProfile: openPosition?.entryContext?.entryProfileMode ?? null,
    entryFirepower: toFiniteNumber(openPosition?.entryContext?.firepower, null),
    entryRegime: openPosition?.entryContext?.marketRegime ?? null,
    entryZone: openPosition?.entryContext?.zone ?? null,
    entryQualityScore: toFiniteNumber(openPosition?.entryContext?.entryQualityScore, null),
    depthExitState: (openPosition?.depthExitState && typeof openPosition.depthExitState === 'object')
      ? openPosition.depthExitState
      : null
  };
}

function buildRecentTradesSnapshot(trades, limit = 10) {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const maxRows = Math.max(1, Math.floor(toFiniteNumber(limit, 10)));
  return [...trades]
    .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))
    .slice(0, maxRows)
    .map((trade) => ({
      id: trade?.tradeId ?? null,
      side: trade?.side ?? null,
      entryPx: toFiniteNumber(trade?.entryPx, null),
      exitPx: toFiniteNumber(trade?.exitPx, null),
      pnl: toFiniteNumber(trade?.pnlNet, toFiniteNumber(trade?.pnl, 0)),
      grossPnl: toFiniteNumber(trade?.grossPnl, toFiniteNumber(trade?.pnl, null)),
      fee: toFiniteNumber(trade?.fee, null),
      pnlPct: toFiniteNumber(trade?.pnlPctNet, toFiniteNumber(trade?.pnlPct, null)),
      size: toFiniteNumber(trade?.size, null),
      exitReason: trade?.exitReason ?? null,
      exitSignal: trade?.exitSignal ?? null,
      holdingSec: toFiniteNumber(trade?.holdSec, null),
      entryProfile: trade?.entryProfile ?? null,
      entryReason: trade?.entryReason ?? null,
      entryTs: toFiniteNumber(trade?.entryTs, null),
      exitTs: toFiniteNumber(trade?.timestamp, null),
      entrySlippage: toFiniteNumber(trade?.entrySlippage, null),
      exitSlippage: toFiniteNumber(trade?.exitSlippage, null),
      isMakerEntry: String(trade?.entryExecMode ?? '').toLowerCase() === 'maker',
      isMakerExit: String(trade?.exitExecMode ?? '').toLowerCase() === 'maker',
      maxAdverseUsd: toFiniteNumber(trade?.maxAdverseUsd, null),
      maxAdversePct: toFiniteNumber(trade?.maxAdversePct, null),
      maxFavorableUsd: toFiniteNumber(trade?.maxFavorableUsd, toFiniteNumber(trade?.capturedMoveUsd, null)),
      maxFavorablePct: toFiniteNumber(trade?.maxFavorablePct, toFiniteNumber(trade?.capturedMovePct, null)),
      result: trade?.result ?? null
    }));
}

function filterLastDaysTrades(trades, days = 30, nowTs = Date.now()) {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const windowMs = Math.max(1, Math.floor(toFiniteNumber(days, 30))) * 24 * 60 * 60 * 1000;
  const cutoff = nowTs - windowMs;
  return trades.filter((trade) => {
    const ts = toFiniteNumber(trade?.exitTs, null) ?? toFiniteNumber(trade?.entryTs, null);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function buildAllTradesSnapshot(trades30d) {
  if (!Array.isArray(trades30d) || trades30d.length === 0) return [];
  return [...trades30d]
    .sort((a, b) => {
      const ta = toFiniteNumber(a?.exitTs, null) ?? toFiniteNumber(a?.entryTs, 0);
      const tb = toFiniteNumber(b?.exitTs, null) ?? toFiniteNumber(b?.entryTs, 0);
      return tb - ta;
    })
    .map((trade) => ({
      id: trade?.id ?? null,
      side: trade?.side ?? null,
      entryPx: toFiniteNumber(trade?.entryPx, null),
      exitPx: toFiniteNumber(trade?.exitPx, null),
      entryTs: toFiniteNumber(trade?.entryTs, null),
      exitTs: toFiniteNumber(trade?.exitTs, null),
      pnl: toFiniteNumber(trade?.pnl, 0),
      grossPnl: toFiniteNumber(trade?.grossPnl, toFiniteNumber(trade?.pnl, null)),
      fee: toFiniteNumber(trade?.fee, null),
      pnlPct: toFiniteNumber(trade?.pnlPct, null),
      size: toFiniteNumber(trade?.size, null),
      holdingSec: toFiniteNumber(trade?.holdingSec, null),
      exitReason: trade?.exitReason ?? null,
      entryProfile: trade?.entryProfile ?? null,
      entryReason: trade?.entryReason ?? null,
      entrySlippage: toFiniteNumber(trade?.entrySlippage, null),
      exitSlippage: toFiniteNumber(trade?.exitSlippage, null),
      isMakerEntry: trade?.isMakerEntry === true,
      isMakerExit: trade?.isMakerExit === true,
      maxAdverseUsd: toFiniteNumber(trade?.maxAdverseUsd, null),
      maxAdversePct: toFiniteNumber(trade?.maxAdversePct, null),
      maxFavorableUsd: toFiniteNumber(trade?.maxFavorableUsd, null),
      maxFavorablePct: toFiniteNumber(trade?.maxFavorablePct, null)
    }));
}

function buildEquityTimeSeries(trades30d, initialEquity, startTs = processStartAt) {
  const seedEquity = toFiniteNumber(initialEquity, 0);
  const series = [{ ts: toFiniteNumber(startTs, Date.now()), equity: seedEquity }];
  if (!Array.isArray(trades30d) || trades30d.length === 0) return series;
  let running = seedEquity;
  const ordered = [...trades30d]
    .filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
    .sort((a, b) => (toFiniteNumber(a?.exitTs, 0) - toFiniteNumber(b?.exitTs, 0)));
  for (const trade of ordered) {
    running += toFiniteNumber(trade?.pnl, 0);
    series.push({
      ts: toFiniteNumber(trade?.exitTs, Date.now()),
      equity: running
    });
  }
  return series;
}

function calculate30DayStats(trades30d, initialEquity) {
  const settled = Array.isArray(trades30d)
    ? trades30d.filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
    : [];
  if (settled.length === 0) {
    return {
      totalPnl: 0,
      totalVolume: 0,
      maxDrawdown: 0,
      tradeCount: 0,
      winCount: 0,
      winRate: 0,
      profitFactor: 0,
      avgPnl: 0,
      bestTrade: 0,
      worstTrade: 0,
      avgHoldingSec: 0
    };
  }

  const totalPnl = settled.reduce((sum, trade) => sum + toFiniteNumber(trade?.pnl, 0), 0);
  const totalVolume = settled.reduce((sum, trade) => {
    const size = Math.abs(toFiniteNumber(trade?.size, 0));
    const entryPx = Math.abs(toFiniteNumber(trade?.entryPx, 0));
    return sum + (size * entryPx);
  }, 0);
  const wins = settled.filter((trade) => toFiniteNumber(trade?.pnl, 0) > 0);
  const losses = settled.filter((trade) => toFiniteNumber(trade?.pnl, 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + toFiniteNumber(trade?.pnl, 0), 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, trade) => sum + toFiniteNumber(trade?.pnl, 0), 0));
  const tradeCount = settled.length;
  const winCount = wins.length;

  let peak = toFiniteNumber(initialEquity, 0);
  let running = toFiniteNumber(initialEquity, 0);
  let maxDrawdown = 0;
  const ordered = [...settled].sort((a, b) => (toFiniteNumber(a?.exitTs, 0) - toFiniteNumber(b?.exitTs, 0)));
  for (const trade of ordered) {
    running += toFiniteNumber(trade?.pnl, 0);
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const pnlValues = settled.map((trade) => toFiniteNumber(trade?.pnl, 0));
  const holdingAvg = settled.reduce((sum, trade) => sum + Math.max(0, toFiniteNumber(trade?.holdingSec, 0)), 0) / Math.max(1, tradeCount);

  return {
    totalPnl,
    totalVolume,
    maxDrawdown,
    tradeCount,
    winCount,
    winRate: tradeCount > 0 ? (winCount / tradeCount) * 100 : 0,
    profitFactor: grossLossAbs > 0 ? (grossProfit / grossLossAbs) : 0,
    avgPnl: tradeCount > 0 ? (totalPnl / tradeCount) : 0,
    bestTrade: pnlValues.length > 0 ? Math.max(...pnlValues) : 0,
    worstTrade: pnlValues.length > 0 ? Math.min(...pnlValues) : 0,
    avgHoldingSec: holdingAvg
  };
}

function buildDailyPnl(trades30d) {
  if (!Array.isArray(trades30d) || trades30d.length === 0) return [];
  const dailyMap = new Map();
  for (const trade of trades30d) {
    const exitTs = toFiniteNumber(trade?.exitTs, null);
    if (!Number.isFinite(exitTs)) continue;
    const date = new Date(exitTs).toISOString().slice(0, 10);
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { pnl: 0, tradeCount: 0 });
    }
    const row = dailyMap.get(date);
    row.pnl += toFiniteNumber(trade?.pnl, 0);
    row.tradeCount += 1;
  }
  return [...dailyMap.entries()]
    .map(([date, row]) => ({ date, pnl: row.pnl, tradeCount: row.tradeCount }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildExitBreakdown(trades30d) {
  const settled = Array.isArray(trades30d)
    ? trades30d.filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
    : [];
  const map = new Map();
  for (const trade of settled) {
    const reason = String(trade?.exitSignal ?? trade?.exitReason ?? 'unknown').trim() || 'unknown';
    if (!map.has(reason)) {
      map.set(reason, { reason, count: 0, totalPnl: 0, winCount: 0 });
    }
    const row = map.get(reason);
    const pnl = toFiniteNumber(trade?.pnl, 0);
    row.count += 1;
    row.totalPnl += pnl;
    if (pnl > 0) row.winCount += 1;
  }
  const byReason = [...map.values()]
    .map((row) => ({
      reason: row.reason,
      count: row.count,
      totalPnl: row.totalPnl,
      avgPnl: row.count > 0 ? (row.totalPnl / row.count) : 0,
      winRate: row.count > 0 ? (row.winCount / row.count) * 100 : 0
    }))
    .sort((a, b) => b.count - a.count);
  return { byReason, totalTrades: settled.length };
}

function buildExecutionQuality(trades30d) {
  const settled = Array.isArray(trades30d)
    ? trades30d.filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
    : [];
  const entrySlipVals = settled.map((t) => toFiniteNumber(t?.entrySlippage, null)).filter(Number.isFinite);
  const exitSlipVals = settled.map((t) => toFiniteNumber(t?.exitSlippage, null)).filter(Number.isFinite);
  const makerSamples = settled.filter((t) => typeof t?.isMakerEntry === 'boolean' || typeof t?.isMakerExit === 'boolean');
  const makerHits = makerSamples.reduce((sum, t) => {
    const e = t?.isMakerEntry === true ? 1 : 0;
    const x = t?.isMakerExit === true ? 1 : 0;
    return sum + e + x;
  }, 0);
  const makerTotal = makerSamples.reduce((sum, t) => {
    const e = typeof t?.isMakerEntry === 'boolean' ? 1 : 0;
    const x = typeof t?.isMakerExit === 'boolean' ? 1 : 0;
    return sum + e + x;
  }, 0);
  const totalFee = settled.reduce((sum, t) => sum + Math.max(0, toFiniteNumber(t?.fee, 0)), 0);
  const totalGrossAbs = settled.reduce((sum, t) => sum + Math.abs(toFiniteNumber(t?.grossPnl, toFiniteNumber(t?.pnl, 0))), 0);
  return {
    entrySlippage: {
      avg: entrySlipVals.length > 0 ? entrySlipVals.reduce((a, b) => a + b, 0) / entrySlipVals.length : null,
      max: entrySlipVals.length > 0 ? Math.max(...entrySlipVals) : null,
      count: entrySlipVals.length
    },
    exitSlippage: {
      avg: exitSlipVals.length > 0 ? exitSlipVals.reduce((a, b) => a + b, 0) / exitSlipVals.length : null,
      max: exitSlipVals.length > 0 ? Math.max(...exitSlipVals) : null,
      count: exitSlipVals.length
    },
    makerRate: makerTotal > 0 ? (makerHits / makerTotal) * 100 : null,
    feeToGross: totalGrossAbs > 0 ? (totalFee / totalGrossAbs) * 100 : null
  };
}

function buildExpectancy(trades30d, recentN = 30) {
  const settled = Array.isArray(trades30d)
    ? trades30d
      .filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
      .sort((a, b) => (toFiniteNumber(b?.exitTs, 0) - toFiniteNumber(a?.exitTs, 0)))
      .slice(0, Math.max(1, Math.floor(toFiniteNumber(recentN, 30))))
    : [];
  const wins = [];
  const lossesAbs = [];
  for (const trade of settled) {
    const pnl = toFiniteNumber(trade?.pnl, 0);
    if (pnl > 0) wins.push(pnl);
    if (pnl < 0) lossesAbs.push(Math.abs(pnl));
  }
  const total = settled.length;
  const winRate = total > 0 ? (wins.length / total) : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = lossesAbs.length > 0 ? lossesAbs.reduce((a, b) => a + b, 0) / lossesAbs.length : 0;
  const expectedValue = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  return {
    recentN: Math.max(1, Math.floor(toFiniteNumber(recentN, 30))),
    winRate: winRate * 100,
    avgWin,
    avgLoss,
    expectedValue,
    totalTrades: total
  };
}

function buildMaeStats(trades30d) {
  const settled = Array.isArray(trades30d)
    ? trades30d.filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
    : [];
  const maeUsdVals = settled.map((t) => toFiniteNumber(t?.maxAdverseUsd, null)).filter(Number.isFinite);
  const mfeUsdVals = settled.map((t) => toFiniteNumber(t?.maxFavorableUsd, null)).filter(Number.isFinite);
  const maePctVals = settled.map((t) => toFiniteNumber(t?.maxAdversePct, null)).filter(Number.isFinite);
  const mfePctVals = settled.map((t) => toFiniteNumber(t?.maxFavorablePct, null)).filter(Number.isFinite);
  const tpLike = settled
    .filter((t) => {
      const sig = String(t?.exitReason ?? '').toLowerCase();
      return sig.includes('tp') || sig.includes('take_profit');
    })
    .map((t) => toFiniteNumber(t?.maxFavorableUsd, null))
    .filter(Number.isFinite);
  return {
    avgMAE: maeUsdVals.length > 0 ? maeUsdVals.reduce((a, b) => a + b, 0) / maeUsdVals.length : null,
    avgMFE: mfeUsdVals.length > 0 ? mfeUsdVals.reduce((a, b) => a + b, 0) / mfeUsdVals.length : null,
    avgMAEPct: maePctVals.length > 0 ? maePctVals.reduce((a, b) => a + b, 0) / maePctVals.length : null,
    avgMFEPct: mfePctVals.length > 0 ? mfePctVals.reduce((a, b) => a + b, 0) / mfePctVals.length : null,
    mfeAtTP: tpLike.length > 0 ? tpLike.reduce((a, b) => a + b, 0) / tpLike.length : null
  };
}

function buildGateBlockReasons(monitorSnapshot) {
  const top = Array.isArray(monitorSnapshot?.topRawReasons) ? monitorSnapshot.topRawReasons : [];
  const totalBlocks = Number.isFinite(toFiniteNumber(monitorSnapshot?.skippedTotal, null))
    ? Number(monitorSnapshot.skippedTotal)
    : top.reduce((sum, row) => sum + Math.max(0, toFiniteNumber(row?.count, 0)), 0);
  const reasons = top.map((row) => {
    const count = Math.max(0, toFiniteNumber(row?.count, 0));
    const pct = Number.isFinite(toFiniteNumber(row?.pct, null))
      ? Number(row.pct)
      : (totalBlocks > 0 ? (count / totalBlocks) * 100 : 0);
    return {
      reason: row?.reason ?? 'unknown',
      count,
      pct
    };
  });
  return { gateBlockReasons: reasons, totalBlocks };
}

function buildRegimeMapSnapshot() {
  const toUpper = (value) => String(value ?? '').toUpperCase();
  const toLower = (value) => String(value ?? '').toLowerCase();
  const slopeToAngleDeg = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return (Math.atan(n) * 180) / Math.PI;
  };
  const normalizeRegimeLabel = (value) => {
    const v = toUpper(value);
    return (v === 'UP' || v === 'DOWN' || v === 'RANGE') ? v : null;
  };
  const slopeToTrendLabel = (value, eps = 1e-9) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n > eps) return 'UP';
    if (n < -eps) return 'DOWN';
    return 'RANGE';
  };
  const normalizeB2ReasonCode = (rawReason, side) => {
    const sideRaw = String(side ?? '').toLowerCase();
    if (sideRaw === 'buy' || sideRaw === 'sell') return REASON_CODE.ENTRY_ALLOWED;
    const reason = String(rawReason ?? '').toLowerCase();
    if (!reason) return REASON_CODE.STATE_HOLD;
    if (
      reason.includes('no_local_channel') ||
      reason.includes('no local channel') ||
      reason.includes('no_structure') ||
      reason.includes('no structure') ||
      reason.includes('no b1 structure') ||
      reason.includes('outside a arena')
    ) return REASON_CODE.NO_ARENA;
    if (
      reason.includes('no_near_sr') ||
      reason.includes('no near sr') ||
      reason.includes('no structural tp') ||
      reason.includes('no structural path')
    ) return REASON_CODE.INSUFFICIENT_TP_DISTANCE;
    if (
      reason.includes('edge_negative') ||
      reason.includes('noise_filter') ||
      reason.includes('noisy')
    ) return REASON_CODE.TOO_FAR_FROM_SR;
    if (
      reason.includes('execution_invalid') ||
      reason.includes('execution invalid')
    ) return REASON_CODE.EXECUTION_INVALID;
    const resolved = resolveReasonCode(rawReason, REASON_CODE.STATE_HOLD);
    return resolved === REASON_CODE.UNKNOWN ? REASON_CODE.STATE_HOLD : resolved;
  };
  const sideToTrendLabel = (value) => {
    const v = String(value ?? '').toLowerCase();
    if (v === 'buy' || v === 'long') return 'UP';
    if (v === 'sell' || v === 'short') return 'DOWN';
    return null;
  };
  const trace = getDecisionTraceSnapshot();
  const payload = trace?.payload ?? null;
  const context = payload?.context ?? {};
  const aResult = context?.aResult ?? {};
  const bResult = context?.bResult ?? {};
  const depthSR = context?.depthSR ?? {};
  const bar1h = context?.bar1h ?? {};
  const bar15m = context?.bar15m ?? {};
  const structureSnapshot = context?.structureSnapshot ?? {};
  const ioMetrics = payload?.ioMetrics ?? {};
  const lrcState = ioMetrics?.lrcState ?? null;
  const arenaLegacy = aResult?.arena ?? {};
  const dailyArena = aResult?.dailyArena ?? null;
  const arena1h = aResult?.arena1h ?? null;
  const dailyTop = toFiniteNumber(dailyArena?.top ?? dailyArena?.channelTop, null);
  const dailyBottom = toFiniteNumber(dailyArena?.bottom ?? dailyArena?.channelBottom, null);
  const aDailyWideUsd = (Number.isFinite(dailyTop) && Number.isFinite(dailyBottom))
    ? Math.max(0, dailyTop - dailyBottom)
    : null;
  const channelTop = toFiniteNumber(arenaLegacy?.channelTop ?? arena1h?.top, null);
  const channelBottom = toFiniteNumber(arenaLegacy?.channelBottom ?? arena1h?.bottom, null);
  const channelWidthUsd = (Number.isFinite(channelTop) && Number.isFinite(channelBottom))
    ? Math.max(0, channelTop - channelBottom)
    : null;
  // UI契約: B 1H WIDE は「1hバー幅」を表示する（構造spanとは別概念）
  const b1High = toFiniteNumber(bar1h?.high, null);
  const b1Low = toFiniteNumber(bar1h?.low, null);
  const b1WideUsd = (Number.isFinite(b1High) && Number.isFinite(b1Low))
    ? Math.max(0, b1High - b1Low)
    : null;
  // 構造幅は診断用途として別キーで保持
  const bStructWideUsd = toFiniteNumber(structureSnapshot?.spanUsd, null);
  const b15mLrcTop = toFiniteNumber(ioMetrics?.lrcTvState?.channelTop, null);
  const b15mLrcBottom = toFiniteNumber(ioMetrics?.lrcTvState?.channelBottom, null);
  const b15mLrcWideUsd = (Number.isFinite(b15mLrcTop) && Number.isFinite(b15mLrcBottom) && b15mLrcTop > b15mLrcBottom)
    ? Math.max(0, b15mLrcTop - b15mLrcBottom)
    : null;
  const b15mHigh = toFiniteNumber(bar15m?.high, null);
  const b15mLow = toFiniteNumber(bar15m?.low, null);
  const b15mBarWideUsd = (Number.isFinite(b15mHigh) && Number.isFinite(b15mLow))
    ? Math.max(0, b15mHigh - b15mLow)
    : null;
  const b15mWideUsd = Number.isFinite(b15mLrcWideUsd) ? b15mLrcWideUsd : b15mBarWideUsd;
  const b15mWideSource = Number.isFinite(b15mLrcWideUsd)
    ? 'lrc_tv_channel'
    : (Number.isFinite(b15mBarWideUsd) ? 'bar15m_range_fallback' : 'unavailable');
  const clusterCountFromMap = toFiniteNumber(bResult?.mapClusterCount, null);
  const clusterCountFromPhase1 = toFiniteNumber(bResult?.phase1?.srClusters?.count, null);
  const clusterCountFromPhase4 = toFiniteNumber(bResult?.phase4?.srReferenceClusterGate?.clusterCount, null);
  const clusterCountFromSrRefDiag = toFiniteNumber(bResult?.phase2?.srReferenceClusterGate?.clusterCount, null);
  const clusterCountFromView = toFiniteNumber(context?.srClusterView?.clusterCount, null);
  const hasClusterSource =
    Number.isFinite(clusterCountFromMap) ||
    Number.isFinite(clusterCountFromPhase1) ||
    Number.isFinite(clusterCountFromPhase4) ||
    Number.isFinite(clusterCountFromSrRefDiag) ||
    Number.isFinite(clusterCountFromView);
  const clusterCountRaw = Number.isFinite(clusterCountFromMap)
    ? clusterCountFromMap
    : (Number.isFinite(clusterCountFromPhase1)
      ? clusterCountFromPhase1
      : (Number.isFinite(clusterCountFromPhase4)
        ? clusterCountFromPhase4
        : (Number.isFinite(clusterCountFromSrRefDiag)
          ? clusterCountFromSrRefDiag
          : clusterCountFromView)));
  const srCountFromDiag = Math.max(
    0,
    Math.floor(toFiniteNumber(depthSR?.srDiag?.supportCount, 0)) +
    Math.floor(toFiniteNumber(depthSR?.srDiag?.resistanceCount, 0))
  );
  const srCountFromCenters =
    (Number.isFinite(toFiniteNumber(depthSR?.supportCenter, null)) ? 1 : 0) +
    (Number.isFinite(toFiniteNumber(depthSR?.resistanceCenter, null)) ? 1 : 0);
  const clusterCount = hasClusterSource && Number.isFinite(clusterCountRaw)
    ? Math.max(0, Math.floor(clusterCountRaw))
    : null;
  const srCount = clusterCount ?? (srCountFromDiag > 0 ? srCountFromDiag : (srCountFromCenters > 0 ? srCountFromCenters : null));
  const supportRefPrice = toFiniteNumber(bResult?.supportPrice, null);
  const resistanceRefPrice = toFiniteNumber(bResult?.resistancePrice, null);
  const distToSupport = toFiniteNumber(bResult?.distToSupport, null);
  const distToResistance = toFiniteNumber(bResult?.distToResistance, null);
  const srReferenceWindowUsd = Math.max(
    1,
    toFiniteNumber(getTradeConfig()?.b2Upgrade?.executionModel?.srReferenceGuard?.windowUsd, 80)
  );
  const bReason = toLower(bResult?.reason ?? '');
  const noNearbySrReason =
    bReason.includes('no nearby sr cluster') ||
    bReason.includes('no b1 structure') ||
    bReason.includes('no b0 structure');
  const hasNearSrPair =
    Number.isFinite(supportRefPrice) &&
    Number.isFinite(resistanceRefPrice) &&
    Number.isFinite(distToSupport) &&
    Number.isFinite(distToResistance) &&
    Math.min(distToSupport, distToResistance) <= srReferenceWindowUsd;
  const supportCenter = (!noNearbySrReason && hasNearSrPair) ? supportRefPrice : null;
  const resistanceCenter = (!noNearbySrReason && hasNearSrPair) ? resistanceRefPrice : null;
  const trendStrength = toFiniteNumber(aResult?.trend_strength, null);
  const h1Strength = toFiniteNumber(aResult?.h1Strength, null);
  const dailyStrength = toFiniteNumber(aResult?.dailyStrength, null);
  const aConstraints = Array.isArray(aResult?.constraints) ? aResult.constraints : [];
  const warmupConstraintSet = new Set([
    'bar1h_warmup',
    'depth_warmup',
    'NO_METRICS'
  ]);
  const aAllow = aResult?.allow === true;
  const aReasonRaw = String(aResult?.reason ?? '').trim();
  const aReason = toLower(aReasonRaw);
  const aRegimeRaw = toUpper(aResult?.regime);
  const aNotReady =
    aRegimeRaw === 'NONE' ||
    aReason.includes('bar1h not ready') ||
    aReason.includes('data not ready') ||
    aReason.includes('data stale');
  const isWarmup = aNotReady || (!aAllow && aConstraints.some((code) => warmupConstraintSet.has(String(code))));
  const aSlopeRaw = toFiniteNumber(
    aResult?.aTrendAngle?.h1Slope ??
    aResult?.aTrendAngle?.dailySlope ??
    ioMetrics?.lrcAState?.slope,
    null
  );
  const aSlopeReady = Number.isFinite(aSlopeRaw);
  const rawARegime = aSlopeReady
    ? (slopeToTrendLabel(aSlopeRaw) ?? null)
    : null;
  const rawBRegime =
    slopeToTrendLabel(ioMetrics?.lrcTvState?.slope ?? ioMetrics?.lrcState?.slope) ??
    normalizeRegimeLabel(sideToTrendLabel(bResult?.phase4?.decidedSide ?? bResult?.side)) ??
    normalizeRegimeLabel(bResult?.phase4?.bRegime) ??
    normalizeRegimeLabel(bResult?.phase1?.bRegime) ??
    normalizeRegimeLabel(bResult?.state) ??
    null;
  const rawDecisionRegime =
    normalizeRegimeLabel(bResult?.state) ??
    rawBRegime ??
    rawARegime ??
    null;
  const aRegime = (isWarmup || !aSlopeReady) ? null : rawARegime;
  const bRegime = isWarmup ? null : rawBRegime;
  const decisionRegime = isWarmup ? null : rawDecisionRegime;
  const bSlopeRaw = toFiniteNumber(
    ioMetrics?.lrcTvState?.slope ??
    ioMetrics?.lrcState?.slope ??
    bResult?.phase4?.executionSignals?.trendSlope,
    null
  );
  const b1SlopeRaw = toFiniteNumber(
    structureSnapshot?.channelSlope ?? structureSnapshot?._legacy?.channelSlope,
    bSlopeRaw
  );
  const aAngleDeg = (isWarmup || !aSlopeReady) ? null : slopeToAngleDeg(aSlopeRaw);
  const bAngleDeg = isWarmup ? null : slopeToAngleDeg(bSlopeRaw);
  const b1AngleDeg = isWarmup ? null : slopeToAngleDeg(b1SlopeRaw);
  const bRailsUpper = toFiniteNumber(structureSnapshot?.rails?.upper, null);
  const bRailsLower = toFiniteNumber(structureSnapshot?.rails?.lower, null);
  const bStructureReady = Number.isFinite(bRailsUpper) && Number.isFinite(bRailsLower) && bRailsUpper > bRailsLower;
  const derivedOverlapRatio = (() => {
    if (
      !Number.isFinite(bRailsUpper) ||
      !Number.isFinite(bRailsLower) ||
      !Number.isFinite(channelTop) ||
      !Number.isFinite(channelBottom)
    ) return null;
    if (bRailsUpper <= bRailsLower || channelTop <= channelBottom) return null;
    const overlapUpper = Math.min(bRailsUpper, channelTop);
    const overlapLower = Math.max(bRailsLower, channelBottom);
    const overlapWidth = overlapUpper - overlapLower;
    if (!Number.isFinite(overlapWidth) || overlapWidth <= 0) return 0;
    const aWidth = channelTop - channelBottom;
    if (!Number.isFinite(aWidth) || aWidth <= 0) return null;
    return clamp(overlapWidth / aWidth, 0, 1);
  })();
  const bOverlapRatio = toFiniteNumber(
    structureSnapshot?._legacy?.overlapRatio ??
    bResult?.phase1?.overlapRatio ??
    bResult?.phase4?.bStructure?.overlapRatio ??
    derivedOverlapRatio,
    null
  );
  const bMinOverlapRatio = toFiniteNumber(
    structureSnapshot?._legacy?.minOverlapRatio ?? bResult?.phase1?.minOverlapRatio,
    toFiniteNumber(getTradeConfig()?.b1?.minOverlapRatio, null)
  );
  const bOverlapPass = Number.isFinite(bOverlapRatio) && Number.isFinite(bMinOverlapRatio)
    ? bOverlapRatio >= bMinOverlapRatio
    : null;
  const b1Cfg = getTradeConfig()?.b1 ?? {};
  const b1BlockCfg = b1Cfg?.block ?? {};
  const b1Enabled = b1Cfg?.enabled !== false;
  const b1MinBarsRequired = Math.max(1, Math.floor(toFiniteNumber(b1Cfg?.minBarsRequired, 50)));
  const b1BarsLoaded = toFiniteNumber(bar15m?.barCount ?? ioMetrics?.bar15mState?.barCount, null);
  const b1UpperRail = bRailsUpper;
  const b1LowerRail = bRailsLower;
  const b1Width = (Number.isFinite(b1UpperRail) && Number.isFinite(b1LowerRail) && b1UpperRail > b1LowerRail)
    ? (b1UpperRail - b1LowerRail)
    : null;
  const b1Center = Number.isFinite(b1Width) ? ((b1UpperRail + b1LowerRail) / 2) : null;
  const b2Position = (bResult?.phase2?.position && typeof bResult.phase2.position === 'object')
    ? bResult.phase2.position
    : null;
  const b2CurrentPrice = toFiniteNumber(
    b2Position?.mid,
    toFiniteNumber(
      bResult?.midPrice,
      toFiniteNumber(context?.mid, null)
    )
  );
  const b2ChannelUpper = toFiniteNumber(b2Position?.channelUpper, b1UpperRail);
  const b2ChannelLower = toFiniteNumber(b2Position?.channelLower, b1LowerRail);
  const b2ChannelCenter = toFiniteNumber(
    b2Position?.channelCenter,
    (Number.isFinite(b2ChannelUpper) && Number.isFinite(b2ChannelLower))
      ? ((b2ChannelUpper + b2ChannelLower) / 2)
      : b1Center
  );
  const b2DistToUpper = toFiniteNumber(
    b2Position?.distToUpper,
    (Number.isFinite(b2ChannelUpper) && Number.isFinite(b2CurrentPrice))
      ? (b2ChannelUpper - b2CurrentPrice)
      : null
  );
  const b2DistToLower = toFiniteNumber(
    b2Position?.distToLower,
    (Number.isFinite(b2CurrentPrice) && Number.isFinite(b2ChannelLower))
      ? (b2CurrentPrice - b2ChannelLower)
      : null
  );
  const b2SpanUsd = toFiniteNumber(
    b2Position?.spanUsd,
    (Number.isFinite(b2ChannelUpper) && Number.isFinite(b2ChannelLower) && b2ChannelUpper > b2ChannelLower)
      ? (b2ChannelUpper - b2ChannelLower)
      : b1Width
  );
  const b2ChannelT = (Number.isFinite(b2SpanUsd) && b2SpanUsd > 0 && Number.isFinite(b2DistToLower))
    ? clamp(b2DistToLower / b2SpanUsd, 0, 1)
    : null;
  const aUpper = channelTop;
  const aLower = channelBottom;
  const aWidth = (Number.isFinite(aUpper) && Number.isFinite(aLower) && aUpper > aLower)
    ? (aUpper - aLower)
    : null;
  const insideA = (Number.isFinite(b1Center) && Number.isFinite(aLower) && Number.isFinite(aUpper))
    ? (b1Center >= aLower && b1Center <= aUpper)
    : null;
  const centerPosRaw = (Number.isFinite(b1Center) && Number.isFinite(aLower) && Number.isFinite(aWidth) && aWidth > 0)
    ? ((b1Center - aLower) / aWidth)
    : null;
  const centerPos = Number.isFinite(centerPosRaw)
    ? clamp(centerPosRaw, 0, 1)
    : null;
  const distToALower = (Number.isFinite(b1Center) && Number.isFinite(aLower))
    ? (b1Center - aLower)
    : null;
  const distToAUpper = (Number.isFinite(b1Center) && Number.isFinite(aUpper))
    ? (aUpper - b1Center)
    : null;
  const lowerGapPct = (Number.isFinite(b1LowerRail) && Number.isFinite(aLower) && Number.isFinite(aWidth) && aWidth > 0)
    ? ((b1LowerRail - aLower) / aWidth)
    : null;
  const upperGapPct = (Number.isFinite(aUpper) && Number.isFinite(b1UpperRail) && Number.isFinite(aWidth) && aWidth > 0)
    ? ((aUpper - b1UpperRail) / aWidth)
    : null;
  const centerOutside = Number.isFinite(centerPosRaw)
    ? (centerPosRaw < 0 ? Math.abs(centerPosRaw) : (centerPosRaw > 1 ? Math.abs(centerPosRaw - 1) : 0))
    : null;
  const blockEnabled = b1BlockCfg?.enabled === true;
  const requireInsideA = b1BlockCfg?.requireInsideA === true;
  const maxUpperGapPct = Math.max(0, toFiniteNumber(b1BlockCfg?.maxUpperGapPct, 0.3));
  const maxLowerGapPct = Math.max(0, toFiniteNumber(b1BlockCfg?.maxLowerGapPct, 0.3));
  const maxCenterOutsidePct = Math.max(0, toFiniteNumber(b1BlockCfg?.maxCenterOutsidePct, 0.2));
  let b1Status = 'PASS';
  if (!b1Enabled) {
    b1Status = 'PASS';
  } else if (!Number.isFinite(b1BarsLoaded) || b1BarsLoaded < b1MinBarsRequired) {
    b1Status = 'WAIT';
  } else if (!bStructureReady || !Number.isFinite(b1Width) || b1Width <= 0) {
    b1Status = 'WAIT';
  } else if (!blockEnabled) {
    b1Status = 'PASS';
  } else if (requireInsideA && insideA === false) {
    b1Status = 'BLOCK';
  } else if (Number.isFinite(upperGapPct) && upperGapPct > maxUpperGapPct) {
    b1Status = 'BLOCK';
  } else if (Number.isFinite(lowerGapPct) && lowerGapPct > maxLowerGapPct) {
    b1Status = 'BLOCK';
  } else if (Number.isFinite(centerOutside) && centerOutside > maxCenterOutsidePct) {
    b1Status = 'BLOCK';
  }
  const flowGate = bResult?.phase4?.flowGate ?? null;
  const flowBlocked = flowGate?.blocked === true || toLower(bResult?.reason ?? '').includes('flow');
  const flowReason = flowGate?.reason ?? (flowBlocked ? bResult?.reason : null);
  const srClustersPhase1 = bResult?.phase1?.srClusters ?? null;
  const srDetection = srClustersPhase1?.detection ?? null;
  const srFilter = srClustersPhase1?.filter ?? null;
  const bClusterDetectionStatus = String(srDetection?.status ?? srClustersPhase1?.status ?? 'UNKNOWN').toUpperCase();
  const bClusterFilterStatus = String(srFilter?.status ?? srClustersPhase1?.status ?? 'UNKNOWN').toUpperCase();
  const bClusterRawCount = toFiniteNumber(srDetection?.rawClusterCount, toFiniteNumber(srClustersPhase1?.rawClusterCount, null));
  const bClusterRejectedCount = toFiniteNumber(srDetection?.outOfChannelRejectedCount, toFiniteNumber(srClustersPhase1?.outOfChannelRejectedCount, null));
  const bClusterFilteredCount = toFiniteNumber(srFilter?.filteredClusterCount, toFiniteNumber(srClustersPhase1?.filteredClusterCount, null));
  const bClusterDetectionWidthUsd = toFiniteNumber(srDetection?.width, null);
  const bClusterDetectionAngle = toFiniteNumber(srDetection?.angle, null);
  const bClusterDetectionAngleDeg = slopeToAngleDeg(bClusterDetectionAngle);
  const bClusterDetectionUpperRail = toFiniteNumber(srDetection?.upperRail, null);
  const bClusterDetectionCenterRail = toFiniteNumber(srDetection?.centerRail, null);
  const bClusterDetectionLowerRail = toFiniteNumber(srDetection?.lowerRail, null);
  const bClusterFilterNearRatio = toFiniteNumber(srFilter?.nearRatio, null);
  const bClusterFilterMinDistanceUsd = toFiniteNumber(srFilter?.minDistance, null);
  const bClusterFilterMaxLevels = toFiniteNumber(srFilter?.maxLevels, null);
  const bClusterFilteredLines = Array.isArray(srClustersPhase1?.filteredLines)
    ? srClustersPhase1.filteredLines
      .map((line) => ({
        type: String(line?.type ?? '').toLowerCase(),
        price: toFiniteNumber(line?.price, null),
        distanceFromNow: toFiniteNumber(line?.distanceFromNow, null),
        rank: toFiniteNumber(line?.rank, null)
      }))
      .filter((line) => Number.isFinite(line.price))
    : [];
  const b2ReasonRaw = String(bResult?.reasonRaw ?? bResult?.reason ?? '');
  const b2ReasonCode = normalizeB2ReasonCode(b2ReasonRaw, bResult?.side);
  const b2EntryAllowed = String(bResult?.side ?? '').toLowerCase() === 'buy' || String(bResult?.side ?? '').toLowerCase() === 'sell';
  const b2TpBasePrice = toFiniteNumber(bResult?.tpPx, null);
  const b2TpDistanceUsd = toFiniteNumber(bResult?.tpDistanceUsd, null);
  const feeEdgeDiag = bResult?.phase4?.feeEdgeGuard ?? null;
  const edgeGrossUsd = toFiniteNumber(feeEdgeDiag?.estimatedGrossUsd, null);
  const edgeFeeUsd = toFiniteNumber(feeEdgeDiag?.estimatedFeeUsd, null);
  const edgeNetUsd = toFiniteNumber(feeEdgeDiag?.estimatedNetUsd, null);
  const edgeMinNetUsd = toFiniteNumber(feeEdgeDiag?.minNetUsd, null);
  const entryQualityScore = toFiniteNumber(bResult?.entryProfile?.entryQualityScore ?? bResult?.phase4?.entryQualityScore, null);
  const minEntryQuality = toFiniteNumber(bResult?.phase4?.executionModel?.minEntryQuality, null);
  const edgeDiagnostics = {
    grossUsd: edgeGrossUsd,
    feeUsd: edgeFeeUsd,
    netUsd: edgeNetUsd,
    minNetUsd: edgeMinNetUsd,
    source: feeEdgeDiag ? 'fee_edge_guard' : 'unavailable'
  };
  return {
    regime: decisionRegime,
    regimeLabel: isWarmup ? '—' : (aResult?.regimeLabel ?? decisionRegime),
    isWaiting: isWarmup,
    aRegime,
    bRegime,
    aAngleDeg,
    bAngleDeg,
    trendStrength: trendStrength ?? h1Strength ?? dailyStrength,
    mapStrength: toFiniteNumber(bResult?.mapStrength, null),
    c: toFiniteNumber(payload?.c, null),
    supportCenter,
    resistanceCenter,
    bar1hMid: toFiniteNumber(bar1h?.mid, null),
    bar15mMid: toFiniteNumber(bar15m?.mid, null),
    lrcReady: lrcState?.ready === true,
    lrcBandLower: toFiniteNumber(lrcState?.bandLower, null),
    lrcBandUpper: toFiniteNumber(lrcState?.bandUpper, null),
    channelTop,
    channelBottom,
    channelWidthUsd,
    aDailyWideUsd,
    b1WideUsd,
    bStructWideUsd,
    b15mWideUsd,
    b15mWideSource,
    b15mLrcWideUsd,
    b15mBarWideUsd,
    bOverlapRatio,
    bMinOverlapRatio,
    bOverlapPass,
    aCandleReady: bar1h?.ready === true,
    aCandleBarCount: toFiniteNumber(bar1h?.barCount, null),
    bCandleReady: bar15m?.ready === true,
    bCandleBarCount: toFiniteNumber(bar15m?.barCount, null),
    bChannelClusterCount: clusterCount,
    clusterCount,
    srCount,
    b2ReasonCode,
    b2ReasonRaw,
    b2EntryAllowed,
    b2CurrentPrice,
    b2ChannelCenter,
    b2ChannelUpper,
    b2ChannelLower,
    b2DistToUpper,
    b2DistToLower,
    b2SpanUsd,
    b2ChannelT,
    bClusterRawCount,
    bClusterRejectedCount,
    bClusterFilteredCount,
    bClusterDetection: {
      status: bClusterDetectionStatus,
      widthUsd: bClusterDetectionWidthUsd,
      angleDeg: bClusterDetectionAngleDeg,
      upperRail: bClusterDetectionUpperRail,
      centerRail: bClusterDetectionCenterRail,
      lowerRail: bClusterDetectionLowerRail,
      rawClusterCount: bClusterRawCount,
      outOfChannelRejectedCount: bClusterRejectedCount
    },
    bClusterFilter: {
      status: bClusterFilterStatus,
      filteredClusterCount: bClusterFilteredCount,
      nearRatio: bClusterFilterNearRatio,
      minDistanceUsd: bClusterFilterMinDistanceUsd,
      maxLevels: bClusterFilterMaxLevels,
      lines: bClusterFilteredLines
    },
    edgeDiagnostics,
    entryQualityScore,
    minEntryQuality,
    topDown: {
      a: {
        allow: aAllow,
        regime: aRegime,
        reason: aResult?.reason ?? null,
        angleDeg: aAngleDeg,
        dailyWideUsd: aDailyWideUsd,
        channelWidthUsd,
        fallbackUsed: aResult?.fallbackUsed === true,
        fallbackSource: aResult?.fallbackSource ?? 'PRIMARY',
        biasRoute: aResult?.biasRoute ?? null,
        dailyTrendSource: aResult?.dailyTrendSource ?? null,
        h1TrendSource: aResult?.h1TrendSource ?? null,
        biasFallbackUsed: aResult?.biasFallbackUsed === true,
        candleReady: bar1h?.ready === true,
        candleBars: toFiniteNumber(bar1h?.barCount, null)
      },
      b: {
        ready: bStructureReady,
        overlapRatio: bOverlapRatio,
        minOverlapRatio: bMinOverlapRatio,
        overlapPass: bOverlapPass,
        structureSource: structureSnapshot?.structureSource ?? null,
        b1WideUsd,
        b15mWideUsd,
        b15mWideSource,
        rails: {
          upper: bRailsUpper,
          lower: bRailsLower
        }
      },
      b1: {
        status: b1Status,
        enabled: b1Enabled,
        minBarsRequired: b1MinBarsRequired,
        barsLoaded: b1BarsLoaded,
        width: b1Width,
        angleDeg: b1AngleDeg,
        center: b1Center,
        upperRail: b1UpperRail,
        lowerRail: b1LowerRail,
        insideA,
        centerPos,
        centerPosRaw,
        distToALower,
        distToAUpper,
        lowerGapPct,
        upperGapPct,
        centerOutside,
        block: {
          enabled: blockEnabled,
          requireInsideA,
          maxUpperGapPct,
          maxLowerGapPct,
          maxCenterOutsidePct
        }
      },
      flow: {
        pass: flowBlocked ? false : (bStructureReady ? true : null),
        blocked: flowBlocked,
        reason: flowReason ?? null,
        pressure: toFiniteNumber(ioMetrics?.flowState?.pressure, null)
      },
      b2: {
        side: bResult?.side ?? 'none',
        allow: b2EntryAllowed,
        reasonCode: b2ReasonCode,
        reasonRaw: b2ReasonRaw || null,
        supportPrice: supportRefPrice,
        resistancePrice: resistanceRefPrice,
        tpBasePrice: b2TpBasePrice,
        tpDistanceUsd: b2TpDistanceUsd,
        currentPrice: b2CurrentPrice,
        channelCenter: b2ChannelCenter,
        channelUpper: b2ChannelUpper,
        channelLower: b2ChannelLower,
        distToUpper: b2DistToUpper,
        distToLower: b2DistToLower,
        spanUsd: b2SpanUsd,
        channelT: b2ChannelT,
        edge: edgeDiagnostics,
        execution: {
          score: entryQualityScore,
          minScore: minEntryQuality
        }
      }
    },
    ts: toFiniteNumber(payload?.ts, null)
  };
}

function buildOrderBookSnapshot(market, depth = 5) {
  if (!market || typeof market !== 'object') return null;
  const bestBidPx = toFiniteNumber(market?.bestBidPx, null);
  const bestAskPx = toFiniteNumber(market?.bestAskPx, null);
  const midPx = toFiniteNumber(market?.midPx, null);
  const spread = (Number.isFinite(bestAskPx) && Number.isFinite(bestBidPx))
    ? (bestAskPx - bestBidPx)
    : null;
  const spreadBps = (Number.isFinite(spread) && Number.isFinite(midPx) && midPx > 0)
    ? (spread / midPx) * 10000
    : null;
  const maxLevels = Math.max(1, Math.floor(toFiniteNumber(depth, 5)));

  const normalizeLevel = (level) => {
    const px = toFiniteNumber(level?.px ?? level?.price ?? level?.[0], null);
    const sz = toFiniteNumber(level?.sz ?? level?.size ?? level?.[1], null);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) return null;
    return { px, sz };
  };

  const bids = Array.isArray(market?.bids)
    ? market.bids.map(normalizeLevel).filter(Boolean).slice(0, maxLevels)
    : [];
  const asks = Array.isArray(market?.asks)
    ? market.asks.map(normalizeLevel).filter(Boolean).slice(0, maxLevels)
    : [];

  return {
    bestBidPx,
    bestAskPx,
    midPx,
    spread,
    spreadBps,
    bids,
    asks
  };
}

// --- ファイルパス設定 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// --- プロセス起動時刻 ---
const processStartAt = Date.now();

// --- CORS ヘッダー ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// --- 取引ログキャッシュ ---
let tradesCache = [];
let tradesCacheLastLoad = 0;
const TRADES_CACHE_TTL = 5 * 60 * 1000; // 5分
let tradesCacheMtime = 0;
let tradesCacheSize = 0;
// Live Equity snapshots (delta計算用)
let baseEquitySnapshot = null;   // { equityUsd, ts, source }
let lastEquitySnapshot = { equityUsd: null, deltaUsd: null, ts: null, source: 'fallback' };
const BALANCE_FETCH_ENABLED = process.env.BALANCE_FETCH_ENABLED === '1';
const DASHBOARD_PAYLOAD_DEBUG = process.env.DASHBOARD_PAYLOAD_DEBUG === '1';
// State 保存間隔制御（毎ティック I/O ブロック防止）
let lastEngineStateSaveAt = 0;
const ENGINE_STATE_SAVE_INTERVAL_MS = 5000; // 5秒ごとに保存

function loadTradesFromLog(modeOverride = process.env.MODE, envOverride = process.env.LOG_TRADES_PATH) {
  const now = Date.now();
  try {
    const logPath = resolveTradesPath(modeOverride, envOverride);
    // グローバル state に TRADES SOURCE パスを保存（UI表示用）
    global._tradesSourcePath = logPath;
    if (!fs.existsSync(logPath)) {
      tradesCache = [];
      tradesCacheLastLoad = now;
      tradesCacheMtime = 0;
      tradesCacheSize = 0;
      return [];
    }
    const stat = fs.statSync(logPath);

    // ファイルが更新されていない && TTL 内ならキャッシュを返す
    if (
      tradesCache.length > 0 &&
      stat.mtimeMs === tradesCacheMtime &&
      stat.size === tradesCacheSize &&
      now - tradesCacheLastLoad < TRADES_CACHE_TTL
    ) {
      return tradesCache;
    }
    
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(l => l.length > 0);
    
    tradesCache = lines.map(line => {
      try {
        const record = JSON.parse(line);
        const timestampExit = toFiniteNumber(record.timestampExit, null)
          ?? toFiniteNumber(record.exitTs, null)
          ?? toFiniteNumber(record.ts, null)
          ?? Date.now();
        const pnlGross = toFiniteNumber(record.realizedPnlUsd, null)
          ?? toFiniteNumber(record.pnl, null)
          ?? 0;
        const pnlNet = toFiniteNumber(record.realizedPnlNetUsd, null)
          ?? toFiniteNumber(record.pnlNet, null)
          ?? pnlGross;
        const holdMs = toFiniteNumber(record.holdMs, null);
        return {
          pnl: pnlGross,
          pnlNet,
          grossPnl: pnlGross,
          fee: toFiniteNumber(record.feeUsd, null),
          pnlPct: toFiniteNumber(record.realizedPnlPctTrade, null) ?? toFiniteNumber(record.pnlPct, null),
          pnlPctNet: toFiniteNumber(record.realizedPnlPctTradeNet, null) ?? toFiniteNumber(record.pnlPctNet, null),
          side: record.side || 'UNKNOWN',
          result: record.result || 'UNKNOWN',
          timestamp: timestampExit,
          tradeId: record.tradeId ?? record.id ?? null,
          entryPx: toFiniteNumber(record.entryPrice, null) ?? toFiniteNumber(record.entryPx, null),
          exitPx: toFiniteNumber(record.exitPrice, null) ?? toFiniteNumber(record.exitPx, null),
          exitReason: record.exitReason ?? record.exitReasonDetail ?? null,
          exitSignal: record.exitSignal ?? null,
          holdSec: Number.isFinite(holdMs) ? Math.max(0, Math.floor(holdMs / 1000)) : null,
          size: toFiniteNumber(record.size, null) ?? toFiniteNumber(record.positionSize, null),
          notional: toFiniteNumber(record.notional, null),
          tpDistanceUsd: toFiniteNumber(record.tpDistanceUsd, null),
          maxAdverseRatio: toFiniteNumber(record.maxAdverseRatio, null),
          maxAdverseUsd: toFiniteNumber(record.maxAdverseUsd, null),
          maxAdversePct: toFiniteNumber(record.maxAdversePct, null),
          maxFavorableUsd: toFiniteNumber(record.maxFavorableUsd, null),
          maxFavorablePct: toFiniteNumber(record.maxFavorablePct, null),
          capturedMoveUsd: toFiniteNumber(record.capturedMoveUsd, null),
          capturedMovePct: toFiniteNumber(record.capturedMovePct, null),
          entrySlippage: toFiniteNumber(record.entrySlippage, null),
          exitSlippage: toFiniteNumber(record.exitSlippage, null),
          entryExecMode: record.entryExecMode ?? null,
          exitExecMode: record.exitExecMode ?? null,
          entryProfile: record.entryProfileMode ?? record.entryProfile ?? null,
          entryReason: record.entryReason ?? record.reason ?? null,
          entryTs: toFiniteNumber(record.timestampEntry, null) ?? toFiniteNumber(record.entryTs, null)
        };
      } catch (err) {
        return null;
      }
    }).filter(t => t !== null);
    
    tradesCacheLastLoad = now;
    tradesCacheMtime = stat.mtimeMs;
    tradesCacheSize = stat.size;
    return tradesCache;
  } catch (err) {
    console.error('[TRADES] loadTradesFromLog failed', err);
    tradesCacheLastLoad = now;
    return tradesCache;
  }
}

function getTradesSourcePath(modeOverride = process.env.MODE, envOverride = process.env.LOG_TRADES_PATH) {
  try {
    return resolveTradesPath(modeOverride, envOverride);
  } catch (_) {
    return global._tradesSourcePath ?? 'unknown';
  }
}

function resolveDashboardTradesEnvOverride() {
  const p = process.env.DASHBOARD_LOG_TRADES_PATH;
  if (typeof p === 'string' && p.trim().length > 0) return p.trim();
  const logPath = process.env.LOG_TRADES_PATH;
  if (typeof logPath === 'string' && logPath.trim().length > 0) return logPath.trim();
  return undefined;
}

function calcDashboardMetrics(trades, baseEquity) {
  const pnlOf = (trade) => toFiniteNumber(trade?.pnlNet, toFiniteNumber(trade?.pnl, 0));
  const wins = trades.filter(t => pnlOf(t) > 0).reduce((s, t) => s + pnlOf(t), 0);
  const losses = Math.abs(trades.filter(t => pnlOf(t) < 0).reduce((s, t) => s + pnlOf(t), 0));
  const totalPnl = wins - Math.abs(losses);  // 【追加】総損益を計算
  const metrics = {
    pf: null,
    pfDisplay: '-- (N/A)',
    pfLabel: '',
    winRate: null,
    winRateDisplay: '-- (N/A)',
    longTrades: 0,
    longWins: 0,
    longWinRate: '--',
    shortTrades: 0,
    shortWins: 0,
    shortWinRate: '--',
    tradeCount: trades.length,
    totalPnl,  // 【追加】総損益をメトリクスに含める
    // Phase 2 指標
    rr: null,
    rrDisplay: '-- (N/A)',
    rrLabel: '',
    avWin: 0,
    avWinDisplay: '▲ $0.00',
    avLoss: 0,
    avLossDisplay: '▼ $0.00',
    // Phase 3 指標
    maxDD: 0,
    maxDDDisplay: '$0.00'
  };
  
  if (trades.length === 0) {
    return metrics;
  }
  
  // PF calculation
  
  if (losses === 0) {
    if (wins > 0) {
      metrics.pf = Infinity;
      metrics.pfDisplay = '∞ (ALL_WIN)';
      metrics.pfLabel = 'STRONG';
    }
  } else {
    const pfValue = wins / losses;
    metrics.pf = pfValue;
    metrics.pfDisplay = pfValue.toFixed(2);
    
    // PF Label
    if (pfValue < 1.2) metrics.pfLabel = 'BAD';
    else if (pfValue < 1.3) metrics.pfLabel = 'POOR';
    else if (pfValue < 1.6) metrics.pfLabel = 'OK';
    else if (pfValue < 2.0) metrics.pfLabel = 'GOOD';
    else metrics.pfLabel = 'STRONG';
  }
  
  // WIN RATE
  const winTrades = trades.filter(t => pnlOf(t) > 0).length;
  metrics.winRate = (winTrades / trades.length) * 100;
  metrics.winRateDisplay = `${metrics.winRate.toFixed(1)}%`;
  
  // LONG/SHORT
  const longTrades = trades.filter(t => t.side === 'LONG');
  const shortTrades = trades.filter(t => t.side === 'SHORT');
  
  metrics.longTrades = longTrades.length;
  metrics.longWins = longTrades.filter(t => pnlOf(t) > 0).length;
  metrics.longWinRate = longTrades.length > 0
    ? `${((metrics.longWins / metrics.longTrades) * 100).toFixed(0)}%`
    : '--';
  
  metrics.shortTrades = shortTrades.length;
  metrics.shortWins = shortTrades.filter(t => pnlOf(t) > 0).length;
  metrics.shortWinRate = shortTrades.length > 0
    ? `${((metrics.shortWins / metrics.shortTrades) * 100).toFixed(0)}%`
    : '--';
  

  // Phase 2: RR / AV.WIN / AV.LOSS
  const winTradesList = trades.filter(t => pnlOf(t) > 0);
  const lossTradesList = trades.filter(t => pnlOf(t) < 0);
  
  const avgWin = winTradesList.length > 0
    ? winTradesList.reduce((sum, t) => sum + pnlOf(t), 0) / winTradesList.length
    : 0;
  
  const avgLoss = lossTradesList.length > 0
    ? Math.abs(lossTradesList.reduce((sum, t) => sum + pnlOf(t), 0) / lossTradesList.length)
    : 0;
  
  // RR (Risk-Reward Ratio)
  if (avgLoss === 0) {
    metrics.rr = avgWin > 0 ? Infinity : 0;
    metrics.rrDisplay = avgWin > 0 ? '∞' : '0.00';
    metrics.rrLabel = avgWin > 0 ? 'GOOD' : 'BAD';
  } else {
    const rrValue = avgWin / avgLoss;
    metrics.rr = rrValue;
    metrics.rrDisplay = rrValue.toFixed(2);
    
    // RR Label
    if (rrValue < 1.0) metrics.rrLabel = 'BAD';
    else if (rrValue < 1.2) metrics.rrLabel = 'POOR';
    else if (rrValue < 1.5) metrics.rrLabel = 'OK';
    else metrics.rrLabel = 'GOOD';
  }
  
  // AV.WIN (average win) - format with ▲ and color
  if (avgWin >= 1000) {
    metrics.avWinDisplay = `▲ $${(avgWin / 1000).toFixed(2)}K`;
  } else {
    metrics.avWinDisplay = `▲ $${avgWin.toFixed(2)}`;
  }
  metrics.avWin = avgWin;
  
  // AV.LOSS (average loss) - format with ▼ and color
  if (avgLoss >= 1000) {
    metrics.avLossDisplay = `▼ $${(avgLoss / 1000).toFixed(2)}K`;
  } else {
    metrics.avLossDisplay = `▼ $${avgLoss.toFixed(2)}`;
  }
  metrics.avLoss = avgLoss;
  
  // Phase 3: MAX DD (Maximum Drawdown)
  let maxDD = 0;
  let peak = baseEquity;
  let cumPnL = 0;
  
  // 時系列順に累積PnLを計算し、ピークからの最大落差を記録
  [...trades]
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach(trade => {
      cumPnL += pnlOf(trade);
      const currentEquity = baseEquity + cumPnL;
      
      if (currentEquity > peak) {
        peak = currentEquity;
      }
      
      const dd = currentEquity - peak;
      if (dd < maxDD) {
        maxDD = dd;
      }
    });
  
  metrics.maxDD = maxDD;
  
  // MAX DD display formatting (always negative or zero) - 整数表示
  const absMaxDD = Math.abs(maxDD);
  metrics.maxDDDisplay = `$${Math.round(absMaxDD)}`;
  
  return metrics;
}

function buildPnlSummary(trades) {
  const settled = Array.isArray(trades)
    ? trades.filter((trade) => Number.isFinite(toFiniteNumber(trade?.exitTs, null)))
    : [];
  const totalNetPnl = settled.reduce((sum, trade) => sum + toFiniteNumber(trade?.pnl, 0), 0);
  const totalGrossPnl = settled.reduce((sum, trade) => {
    return sum + toFiniteNumber(trade?.grossPnl, toFiniteNumber(trade?.pnl, 0));
  }, 0);
  const totalFeeAbs = settled.reduce((sum, trade) => sum + Math.abs(toFiniteNumber(trade?.fee, 0)), 0);
  const grossAbs = Math.abs(totalGrossPnl);
  return {
    scope: '30d',
    tradeCount: settled.length,
    totalGrossPnl,
    totalNetPnl,
    totalFeeAbs,
    feeImpact: totalGrossPnl - totalNetPnl,
    feeToGrossPct: grossAbs > 0 ? (totalFeeAbs / grossAbs) * 100 : null,
    pnlBasis: 'net_after_fee',
    pnlIncludesFee: true
  };
}

async function resolveLiveEquity(mode) {
  // 非live は初期資本ベース
  if (mode !== 'live') {
    const initial = getInitialCapitalUsd();
    lastEquitySnapshot = {
      equityUsd: Number.isFinite(initial) ? initial : null,
      deltaUsd: null,
      ts: Date.now(),
      source: 'fallback'
    };
    return lastEquitySnapshot;
  }

  const res = await fetchLiveEquity({ force: false });
  const equityUsd = Number.isFinite(res?.equityUsd) ? Number(res.equityUsd) : null;

  if (!baseEquitySnapshot && Number.isFinite(equityUsd)) {
    baseEquitySnapshot = {
      equityUsd,
      ts: res?.ts ?? Date.now(),
      source: res?.source ?? 'live'
    };
  }

  const base = baseEquitySnapshot?.equityUsd;
  const delta = Number.isFinite(base) && Number.isFinite(equityUsd) ? equityUsd - base : null;

  lastEquitySnapshot = {
    equityUsd,
    deltaUsd: delta,
    ts: res?.ts ?? Date.now(),
    source: res?.source ?? 'live'
  };

  return lastEquitySnapshot;
}

// --- UPTIME フォーマット関数 ---
function formatUptime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const hhmmss = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return days > 0 ? `${days}d ${hhmmss}` : hhmmss;
}

// --- SAFETY手動復帰関数 ---
function resetSafety(engineState) {
  if (engineState && engineState.safety) {
    engineState.safety.status = 'NORMAL';
    engineState.safety.reason = null;
    engineState.safety.since = Date.now();
    engineState.lastTickTs = Date.now();
    console.log('[SAFETY] MANUAL RESET');
  }
}

function shouldAutoHaltFromRecentTrades({ mode, tradeConfig, trades }) {
  const rg = tradeConfig?.riskGuards ?? {};
  if (rg.awayAutoHaltEnabled !== true) return null;
  if (mode !== 'live' && rg.awayApplyInTestMode !== true) return null;

  const settled = (Array.isArray(trades) ? trades : []).filter(t => {
    const pnl = toFiniteNumber(t?.pnlNet, toFiniteNumber(t?.pnl, null));
    return Number.isFinite(pnl);
  });
  if (settled.length === 0) return null;

  const hardSlStreakThreshold = Math.max(1, Math.floor(toFiniteNumber(rg.awayHardSlStreak, 2)));
  let hardSlStreak = 0;
  for (let i = settled.length - 1; i >= 0; i -= 1) {
    const sig = String(settled[i]?.exitSignal ?? settled[i]?.exitReason ?? '').toLowerCase();
    if (sig.includes('hard_sl') || sig.includes('hard sl')) {
      hardSlStreak += 1;
      continue;
    }
    break;
  }
  if (hardSlStreak >= hardSlStreakThreshold) {
    return {
      reason: 'AUTO_HALT_HARD_SL_STREAK',
      detail: `hard_sl_streak=${hardSlStreak} threshold=${hardSlStreakThreshold}`
    };
  }

  const windowTrades = Math.max(1, Math.floor(toFiniteNumber(rg.awayNetWindowTrades, 10)));
  const minTrades = Math.max(1, Math.floor(toFiniteNumber(rg.awayMinTrades, 6)));
  const minNetPerTradeUsd = toFiniteNumber(rg.awayMinNetPerTradeUsd, -0.2);
  const window = settled.slice(-windowTrades);
  if (window.length < minTrades) return null;

  const netSum = window.reduce((sum, t) => {
    const pnl = toFiniteNumber(t?.pnlNet, toFiniteNumber(t?.pnl, 0));
    return sum + pnl;
  }, 0);
  const netPerTrade = netSum / window.length;
  if (netPerTrade <= minNetPerTradeUsd) {
    return {
      reason: 'AUTO_HALT_NET_PER_TRADE',
      detail: `window=${window.length} netPerTrade=${netPerTrade.toFixed(3)} min=${minNetPerTradeUsd.toFixed(3)}`
    };
  }
  return null;
}

const STALLED_THRESHOLD_MS = 10_000;
const DASHBOARD_HEARTBEAT_WARN_MS = 5_000;
const DECISION_MONITOR_WINDOW_MS = 60 * 60 * 1000;
const DECISION_MONITOR_MAX_LEN = 50000;

function mapDecisionMonitorReason(rawReason, regime = null) {
  const normalized = String(rawReason ?? '');
  // A gate denied
  if (normalized === 'B: not allowed by A' || normalized === 'B: regime not approved') return 'gate_denied';
  // No depth SR
  if (normalized === 'B: no_depth_sr') return 'no_depth_sr';
  // SR distance guard
  if (normalized.includes('SR_DISTANCE_TOO_NEAR') || normalized.includes('SR_DISTANCE_TOO_FAR')) return 'sr_distance';
  // TP/SL failed
  if (normalized.includes('NO_TP') || normalized === 'B: NO_TP_LINE' || normalized === 'B: NO_TP_DISTANCE' || normalized === 'B: NO_TP_LIQUIDITY') return 'tp_failed';
  // Expected value low
  if (normalized.includes('expected_value') || normalized === 'B: expected_value_below_min') return 'expected_value_low';
  // Pre-entry depth recheck failed
  if (normalized.includes('DEPTH_DETERIORATED')) return 'depth_deteriorated';
  // B2 execution quality gate
  if (normalized.includes('execution_invalid')) return 'execution_invalid';
  // B2 no nearby structural SR
  if (normalized.includes('no_near_sr')) return 'no_near_sr';
  // Fallback: old reason codes
  if (normalized === 'skip_short_distance') return 'sr_distance';
  if (normalized === 'skip_low_expectancy') return 'expected_value_low';
  return null;
}

function resolveDecisionCoin(ioPacket) {
  const cur = ioPacket?.marketState?.current ?? null;
  return cur?.coin ?? cur?.symbol ?? 'BTC';
}

async function handleBalanceRequest(res, mode) {
  try {
    const info = await resolveLiveEquity(mode);
    const fallbackEquity = mode === 'live' ? getFallbackEquityUsd() : getInitialCapitalUsd();
    const equityUsd = Number.isFinite(info?.equityUsd) ? info.equityUsd : fallbackEquity;
    const payload = {
      equityUsd,
      deltaUsd: Number.isFinite(info?.deltaUsd) ? info.deltaUsd : null,
      ts: info?.ts ?? Date.now(),
      source: info?.source ?? 'fallback'
    };
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(payload));
  } catch (err) {
    try { console.warn('[runtime] handleBalanceRequest failed', err?.message || err); } catch (_) {}
    const fallbackEquity = mode === 'live' ? getFallbackEquityUsd() : getInitialCapitalUsd();
    const payload = {
      equityUsd: Number.isFinite(fallbackEquity) ? fallbackEquity : null,
      deltaUsd: null,
      ts: Date.now(),
      source: 'fallback'
    };
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(payload));
  }
}

function evaluateStatus({ lastMarketAt, now, hlEnabled, registryReport, heartbeatDelta }) {
  // registry起因のエラーを最優先
  if (registryReport?.severity === 'ERROR') {
    return {
      state: 'ERROR',
      severity: 'ERROR',
      hint: registryReport?.hint ?? 'missing required core',
      stoppedAt: null,
    };
  }

  if (!lastMarketAt) {
    return {
      state: 'NO_FEED',
      severity: 'OK',
      hint: hlEnabled ? 'market not supplied yet' : 'HL disabled (no feed by design)',
      stoppedAt: null,
    };
  }

  const since = now - lastMarketAt;
  if (since > STALLED_THRESHOLD_MS) {
    return {
      state: 'STALLED',
      severity: 'WARN',
      hint: `market stalled (${since}ms)`,
      stoppedAt: lastMarketAt,
    };
  }

  // heartbeat遅延をWARNに昇格
  if (heartbeatDelta != null && heartbeatDelta > DASHBOARD_HEARTBEAT_WARN_MS) {
    return {
      state: 'STABLE',
      severity: 'WARN',
      hint: 'No dashboard sent recently',
      stoppedAt: null,
    };
  }

  return {
    state: 'STABLE',
    severity: 'OK',
    hint: 'market feed OK',
    stoppedAt: null,
  };
}

export async function startRuntime({ mode, hlEnabled, registryReport }) {
  globalThis.__runtimeActive = true;
  // TEST_MODE=1 のときは強制的に test 経路へ（live混在による誤送信防止）
  if (process.env.TEST_MODE === '1') {
    mode = 'test';
  }
  process.env.MODE = mode;
  const decisionMonitor = createDecisionMonitor({
    windowMs: DECISION_MONITOR_WINDOW_MS,
    maxLen: DECISION_MONITOR_MAX_LEN
  });
  bridgeEmitter.on('decision:monitor:v1', (event) => {
    decisionMonitor.addEvent(event);
  });
  // 60分窓のサマリを jsonl にも残す（UI依存を避ける）
  const monitorRoute = mode === 'live' ? 'LIVE' : 'TEST';
  const entryRateAlertAt = { low: 0, high: 0 };
  setInterval(() => {
    try {
      const snapshot = decisionMonitor.getSnapshot({ route: monitorRoute });
      writeLog({ type: 'decision_monitor', ts: Date.now(), route: monitorRoute, snapshot });
      const entryRateMonitorCfg = getTradeConfig()?.entryRateMonitor ?? {};
      if (entryRateMonitorCfg.enabled !== false) {
        const nowTs = Date.now();
        const evaluated = Number.isFinite(Number(snapshot?.evaluated)) ? Number(snapshot.evaluated) : 0;
        const entered = Number.isFinite(Number(snapshot?.entered)) ? Number(snapshot.entered) : 0;
        const rate = evaluated > 0 ? entered / evaluated : 0;
        const minRate = Number.isFinite(Number(entryRateMonitorCfg?.minEntryRate)) ? Number(entryRateMonitorCfg.minEntryRate) : 0.02;
        const maxRate = Number.isFinite(Number(entryRateMonitorCfg?.maxEntryRate)) ? Number(entryRateMonitorCfg.maxEntryRate) : 0.1;
        const minEvaluated = Number.isFinite(Number(entryRateMonitorCfg?.minEvaluated))
          ? Number(entryRateMonitorCfg.minEvaluated)
          : 50;
        const cooldownMs = Number.isFinite(Number(entryRateMonitorCfg?.alertCooldownMs))
          ? Number(entryRateMonitorCfg.alertCooldownMs)
          : 30 * 60 * 1000;
        const rateBand = rate < minRate ? 'LOW' : (rate > maxRate ? 'HIGH' : 'OK');
        writeLog({
          type: 'entry_rate_monitor',
          ts: nowTs,
          route: monitorRoute,
          evaluated,
          entered,
          entryRate: rate,
          entryRatePct: rate * 100,
          minEntryRate: minRate,
          maxEntryRate: maxRate,
          minEvaluated,
          band: rateBand
        });
        const canAlert = evaluated >= minEvaluated;
        if (canAlert && rateBand === 'LOW' && nowTs - entryRateAlertAt.low >= cooldownMs) {
          entryRateAlertAt.low = nowTs;
          writeLog({
            type: 'notification_signal',
            ts: nowTs,
            channelTargets: ['line', 'email'],
            signal: 'ENTRY_RATE_LOW',
            route: monitorRoute,
            evaluated,
            entered,
            entryRate: rate
          });
          if (entryRateMonitorCfg.lineAlertEnabled !== false) {
            import('../engine/lineNotify.js')
              .then(({ sendLineAlert }) => sendLineAlert({
                type: 'ENTRY_RATE_LOW',
                message: `entry_rate=${(rate * 100).toFixed(2)}% (entered=${entered}/evaluated=${evaluated}, route=${monitorRoute})`,
                action: `threshold(min=${(minRate * 100).toFixed(2)}%, max=${(maxRate * 100).toFixed(2)}%)`
              }))
              .catch((err) => {
                console.error('[RUNTIME] ENTRY_RATE_LOW line alert failed:', err?.message || err);
              });
          }
        }
        if (canAlert && rateBand === 'HIGH' && nowTs - entryRateAlertAt.high >= cooldownMs) {
          entryRateAlertAt.high = nowTs;
          writeLog({
            type: 'notification_signal',
            ts: nowTs,
            channelTargets: ['line', 'email'],
            signal: 'ENTRY_RATE_HIGH',
            route: monitorRoute,
            evaluated,
            entered,
            entryRate: rate
          });
          if (entryRateMonitorCfg.lineAlertEnabled !== false) {
            import('../engine/lineNotify.js')
              .then(({ sendLineAlert }) => sendLineAlert({
                type: 'ENTRY_RATE_HIGH',
                message: `entry_rate=${(rate * 100).toFixed(2)}% (entered=${entered}/evaluated=${evaluated}, route=${monitorRoute})`,
                action: `threshold(min=${(minRate * 100).toFixed(2)}%, max=${(maxRate * 100).toFixed(2)}%)`
              }))
              .catch((err) => {
                console.error('[RUNTIME] ENTRY_RATE_HIGH line alert failed:', err?.message || err);
              });
          }
        }
      }
    } catch (err) {
      console.error('[RUNTIME] decision_monitor emit failed', err);
    }
  }, 60_000);
  // trade.json を定期的に再読込（Bリブートなしでパラメータ反映）
  startTradeConfigAutoReload(60_000, (hash) => {
    try {
      updateIOConfigForHotReload(getTradeConfig());
      console.log(`[trade] config auto-reloaded hash=${hash ?? 'unknown'}`);
    } catch (_) {}
  });
  
  // IO層とEngine層の配線（必須）
  const { bindUpdateMarketState } = await import('../io/index.js');
  const { updateMarketState } = await import('../engine/state.js');
  bindUpdateMarketState(updateMarketState);
  console.log('[RUNTIME] IO-Engine binding completed');
  
  if (mode === 'test' || mode === 'dry') {
    loadCapitalFromFile();
  } else if (mode === 'live') {
    loadBaseEquityLiveFromFile();
  }
  const startTs = Date.now();
  let noFeedWarned = false;
  let wsCore = null;
  if (hlEnabled) {
    wsCore = await import('./index.js');
    if (typeof wsCore?.HLWSClient === 'function') {
      const tradeConfig = getTradeConfig();
      const symbols = Array.isArray(tradeConfig?.symbols) ? tradeConfig.symbols : null;
      const wsClient = await wsCore.HLWSClient({ WebSocket, config: { symbols } });
      wsClient.start();
      console.log('[WS CLIENT] started');
      const marketCore = registryReport?.cores?.find(c => c?.id === 'marketFeed');
      if (marketCore && marketCore.state !== 'loaded') {
        marketCore.state = 'loaded';
        marketCore.reason = 'hlws client';
      }
    }
  }

  // 優先度4: State永続化（resolveStatePath で統一決定・環境変数対応）
  const STATE_PATH = resolveStatePath(mode, process.env.ENGINE_STATE_PATH);
  
  let engineState = loadEngineState(createInitialState, STATE_PATH);
  if (!engineState) {
    console.log('[RUNTIME] State not found, creating initial state');
    engineState = createInitialState();
  } else {
    console.log('[RUNTIME] State restored from', STATE_PATH);
    console.log('[RUNTIME] Loaded safety:', JSON.stringify(engineState.safety));
    
    // 起動時に HALTED/DATA_STALE 状態だった場合、即座に NORMAL にリセット
    // （前回シャットダウン時の DATA_STALE を引き継がない）
    if (engineState.safety?.status === 'HALTED' && engineState.safety?.reason === 'DATA_STALE') {
      console.log('[RUNTIME] Clearing stale DATA_STALE from previous session');
      engineState.safety.status = 'NORMAL';
      engineState.safety.reason = null;
      engineState.safety.since = null;
      engineState.lastMarketAtMs = Date.now(); // evaluateSafety() 対策
      saveEngineState(engineState, STATE_PATH);
    }
  }
  
  // io/index.js からの参照用にグローバルに設定（lastMarketAtMs更新用）
  global.engineState = engineState;
  
  let lastWsSendTs = Date.now();
  let lastDecisionSnapshot = {
    side: null,
    size: null,
    reason: null,
    reasonCode: null,
    zone: null,
    safety: null,
    gates: null
  };
  let lastDataStatus = { dataState: 'OK', stopReason: null, dataHint: 'OK' };
  let lastMarketAt = null;
  let FORCE_TEST_TRADE = process.env.FORCE_TEST_TRADE === '1';
  const FORCE_TEST_TRADE_FILE = new URL('../debug/force-test-trade.once', import.meta.url);
  if (!FORCE_TEST_TRADE) {
    try {
      if (fs.existsSync(FORCE_TEST_TRADE_FILE)) {
        FORCE_TEST_TRADE = true;
        try {
          fs.unlinkSync(FORCE_TEST_TRADE_FILE);
        } catch (err) {
          console.error('[RUNTIME] remove force-test flag failed', err);
        }
      }
    } catch (err) {
      console.error('[RUNTIME] force-test flag check failed', err);
    }
  }
  let forcedEntryDone = false;
  let forcedExitDone = false;
  let forcedEntryTick = null;
  const FORCE_EXIT_AFTER_TICKS = 3;
  const shadowCfg = {
    enabled: process.env.V2_SHADOW_ENABLED === '1',
    holdMs: Math.max(1000, Math.floor(toFiniteNumber(process.env.V2_SHADOW_HOLD_MS, 30000))),
    notionalUsd: Math.max(1, toFiniteNumber(process.env.V2_SHADOW_NOTIONAL_USD, 1000)),
    takerBps: Math.max(0, toFiniteNumber(process.env.V2_SHADOW_TAKER_BPS, 4.5))
  };
  const shadowState = {
    open: null,
    seq: 0
  };

  // --- STDINリスナー（手動リセット用） ---
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function(data) {
    const cmd = data.trim().toLowerCase();
    if (cmd === 'reset' || cmd === 'r') {
      resetSafety(engineState);
    }
  });

  // 実ロジック: decideTradeを使ってENGINEイベントを流す
  let tickCount = 0;
  let haltedConfirmed = false;
  let isEngineLoopRunning = false;  // 【重要】async setInterval 再入防止フラグ
  
  setInterval(async () => {
    if (isEngineLoopRunning) return;  // 並行実行を完全遮断
    isEngineLoopRunning = true;
    
    try {
      const ioPacket = getIOPacket();
      const dataStatus = evaluateDataState({ 
        c: ioPacket?.ioMetrics?.c ?? null, 
        ioMetrics: ioPacket?.ioMetrics 
      });
      lastDataStatus = dataStatus;
      const market = ioPacket?.marketState?.current ?? null;
      const skippedSnapshot = decisionMonitor.getSnapshot({ route: monitorRoute });
      if (!market) {
        if (hlEnabled && !noFeedWarned && Date.now() - startTs > 60_000) {
          noFeedWarned = true;
          console.warn('[WARN] NO_FEED for 60s: market feed not supplied yet');
        }
        const decision = {
          side: 'none',
          size: 0,
          reason: dataStatus.stopReason ?? STOP_REASONS.WAIT_TRADES
        };
        lastDecisionSnapshot = {
          side: 'none',
          size: 0,
          reason: decision.reason,
          reasonCode: resolveReasonCode(decision.reason, REASON_CODE.UNKNOWN),
          zone: ioPacket?.ioMetrics?.zone ?? null,
          safety: engineState?.safety?.status ?? null,
          gates: null
        };
        const route = mode === 'live' ? 'LIVE' : 'TEST';
        bridgeEmitter.emit('decision:monitor:v1', {
          ts: Date.now(),
          coin: resolveDecisionCoin(ioPacket),
          decision: 'none',
          reason: mapDecisionMonitorReason(decision.reason),
          rawReason: String(decision.reason ?? ''),
          route
        });
        return;
      }
      const marketTs = ioPacket?.timestamp ?? Date.now();
      lastMarketAt = marketTs;
      const marketState = { ...market, ts: marketTs };
      console.log('[MARKET FEED]', marketState.midPx, marketState.oi);
      let equityInfo = { equityUsd: null, deltaUsd: null, source: 'fallback', ts: Date.now() };
      try {
        equityInfo = await resolveLiveEquity(mode);
      } catch (err) {
        try { console.warn('[runtime] resolveLiveEquity failed', err?.message || err); } catch (_) {}
      }
      const fallbackEquity = mode === 'live' ? getFallbackEquityUsd() : getInitialCapitalUsd();
      const accountEquity = Number.isFinite(equityInfo.equityUsd) ? equityInfo.equityUsd : fallbackEquity;
      
      // ────────────────────────
      // 優先度1: Warmup制約チェック（起動直後の誤発注防止）
      // ────────────────────────
      // Note: decideTrade() を呼ぶ前にチェックし、無駄な処理を回避
      const constraints = ioPacket?.ioMetrics?.constraints ?? [];
      const hasWarmup = constraints.some(
        (c) => c === 'warmup' || (typeof c === 'object' && c?.type === 'warmup')
      );
      if (hasWarmup) {
        const decision = { side: 'none', size: 0, reason: 'warmup_in_progress' };
        console.log('[DECISION]', decision);
        engineState = updateEngine(engineState, marketState, decision, marketTs);
        engineState.market = marketState;
        global.engineState = engineState;
        tickCount++;
        touchTick(engineState);
        const now = Date.now();
        if (now - lastEngineStateSaveAt >= ENGINE_STATE_SAVE_INTERVAL_MS) {
          saveEngineState(engineState, STATE_PATH);
          lastEngineStateSaveAt = now;
        }
        return; // 次のループへ
      }
      
      // ────────────────────────
      // Safety リセット処理（DataState チェックの前に配置）
      // ────────────────────────
      // Note: dataFreshness=OK で DATA_STALE を解除（bar1hReady は不要）
      // Note: データ復旧時に dataStatus を更新し、後段の DataState チェックを通過可能にする
      const dataFreshness = ioPacket?.ioMetrics?.dataFreshness;
      const freshnessHint = ioPacket?.ioMetrics?.freshnessHint;
      const bar1hReady = ioPacket?.ioMetrics?.bar1hState?.ready ?? false;
      
      // DATA_STALE 解除: dataFreshness=OK なら即座に解除
      if (engineState.safety?.status === 'HALTED' && 
          engineState.safety?.reason === 'DATA_STALE' &&
          dataFreshness === 'OK') {
        
        // WARMUP 中は ACTIVE に戻すが、reason を WARMUP に変更
        if (freshnessHint === 'WARMUP_BAR1H' && !bar1hReady) {
          console.log('[SAFETY] Resetting from DATA_STALE to ACTIVE (WARMUP mode)');
          engineState.safety.status = 'ACTIVE';
          engineState.safety.reason = 'WARMUP';
          engineState.safety.since = Date.now();
          
          // lastMarketAtMs を更新（evaluateSafety() で再度 HALTED に戻されるのを防ぐ）
          engineState.lastMarketAtMs = Date.now();
          
          // dataStatus を更新（後段の DataState チェックを通過可能にする）
          dataStatus.dataState = 'OK';
          dataStatus.stopReason = null;
          
          writeLog({
            ts: Date.now(),
            type: 'safety_reset',
            from: 'HALTED/DATA_STALE',
            to: 'ACTIVE/WARMUP',
            dataFreshness: dataFreshness,
            bar1hReady: bar1hReady
          });
          
          // 即座に保存（次のループを待たずにリセットを永続化）
          saveEngineState(engineState, STATE_PATH);
        } else {
          // 完全に正常化（bar1hReady=true または freshnessHint が null）
          console.log('[SAFETY] Resetting from DATA_STALE to ACTIVE (fully recovered)');
          engineState.safety.status = 'ACTIVE';
          engineState.safety.reason = null;
          engineState.safety.since = null;
          
          // lastMarketAtMs を更新（evaluateSafety() で再度 HALTED に戻されるのを防ぐ）
          engineState.lastMarketAtMs = Date.now();
          
          // dataStatus を更新（後段の DataState チェックを通過可能にする）
          dataStatus.dataState = 'OK';
          dataStatus.stopReason = null;
          
          writeLog({
            ts: Date.now(),
            type: 'safety_reset',
            from: 'HALTED/DATA_STALE',
            to: 'ACTIVE',
            dataFreshness: dataFreshness,
            bar1hReady: bar1hReady
          });
          
          // 即座に保存（次のループを待たずにリセットを永続化）
          saveEngineState(engineState, STATE_PATH);
        }
      }
      
      // WARMUP 完了時に reason を null に戻す
      if (engineState.safety?.status === 'ACTIVE' &&
          engineState.safety?.reason === 'WARMUP' &&
          bar1hReady) {
        console.log('[SAFETY] WARMUP completed, reason cleared');
        engineState.safety.reason = null;
        engineState.safety.since = null;
        
        writeLog({
          ts: Date.now(),
          type: 'safety_warmup_complete',
          from: 'ACTIVE/WARMUP',
          to: 'ACTIVE',
          bar1hReady: bar1hReady
        });
        
        // 即座に保存（次のループを待たずに完了を永続化）
        saveEngineState(engineState, STATE_PATH);
      }
      
      // ────────────────────────
      // 優先度2: DataState チェック
      // ────────────────────────
      // Note: decideTrade() を呼ぶ前にチェックし、無駄な処理を回避
      // Note: Safety リセットで dataStatus が更新されている可能性がある
      if (dataStatus.dataState && dataStatus.dataState !== 'OK') {
        const decision = { side: 'none', size: 0, reason: dataStatus.stopReason ?? STOP_REASONS.WAIT_TRADES };
        console.log('[DECISION]', decision);
        engineState = updateEngine(engineState, marketState, decision, marketTs);
        engineState.market = marketState;
        global.engineState = engineState;
        tickCount++;
        touchTick(engineState);
        const now = Date.now();
        if (now - lastEngineStateSaveAt >= ENGINE_STATE_SAVE_INTERVAL_MS) {
          saveEngineState(engineState, STATE_PATH);
          lastEngineStateSaveAt = now;
        }
        return; // 次のループへ
      }
      
      // ────────────────────────
      // Logic 判定実行
      // ────────────────────────
      // Note: Warmup/DataState チェックを通過した時のみ実行
      const decisionPayload = {
        ...ioPacket,
        market: ioPacket?.marketState?.current ?? null,
        accountEquity,
        engineState,
        mode,
        wsState: dataStatus?.dataState ?? null,
        skippedSnapshot
      };
      let decision = decideTrade(decisionPayload);
      
      // ────────────────────────
      // FORCE_TEST_TRADE オーバーライド
      // ────────────────────────
      // Note: テスト専用の強制エントリー/出口（本番では無効）
      if (FORCE_TEST_TRADE && dataStatus.dataState === 'OK' && !dataStatus.stopReason) {
        if (!forcedEntryDone && !engineState.openPosition) {
          decision = { side: 'buy', size: 0.01, reason: 'force_test_entry' };
          forcedEntryDone = true;
          forcedEntryTick = tickCount;
        } else if (forcedEntryDone && !forcedExitDone && engineState.openPosition) {
          const ticksSinceEntry = forcedEntryTick === null ? 0 : tickCount - forcedEntryTick;
          if (ticksSinceEntry >= FORCE_EXIT_AFTER_TICKS) {
            const exitSide = engineState.openPosition.side === 'buy' ? 'sell' : 'buy';
            decision = { side: exitSide, size: engineState.openPosition.size, reason: 'force_test_exit' };
            forcedExitDone = true;
          }
        }
      }
      const route = mode === 'live' ? 'LIVE' : 'TEST';
      const monitor = decision?.monitor ?? null;
      console.log('[DECISION]', decision);
      engineState = updateEngine(engineState, marketState, decision, marketTs);
      engineState.market = marketState;
      global.engineState = engineState;  // 【重要】グローバル参照を毎ループ更新（io/index.js との同期）

      const engineLastDecision = engineState?.lastDecision ?? null;
      const monitorSideRaw = typeof engineLastDecision?.side === 'string'
        ? engineLastDecision.side
        : (typeof decision?.side === 'string' ? decision.side : 'none');
      const monitorSide = String(monitorSideRaw).toLowerCase();
      const monitorDecisionType = monitorSide === 'none' ? 'none' : 'enter';
      const monitorReasonRaw = typeof engineLastDecision?.reason === 'string'
        ? engineLastDecision.reason
        : (typeof decision?.reason === 'string' ? decision.reason : null);
      bridgeEmitter.emit('decision:monitor:v1', {
        ts: Date.now(),
        coin: resolveDecisionCoin(ioPacket),
        decision: monitorDecisionType,
        reason: monitorDecisionType === 'none' ? mapDecisionMonitorReason(monitorReasonRaw) : null,
        rawReason: monitorDecisionType === 'none' ? String(monitorReasonRaw ?? '') : null,
        reasonCode: resolveReasonCode(
          monitorReasonRaw ?? null,
          monitorDecisionType === 'none' ? REASON_CODE.UNKNOWN : REASON_CODE.ENTRY_ALLOWED
        ),
        route,
        logic: monitor?.logic ?? decision?.logic ?? null,
        channelWidth: monitor?.channelWidth ?? null,
        anchorDistance: monitor?.anchorDistance ?? null,
        minBandDistanceUsd: monitor?.minBandDistanceUsd ?? null,
        plannedExitDistance: monitor?.plannedExitDistance ?? null
      });

      // Live Shadow Test (no real orders): same pessimistic fill model in realtime.
      if (shadowCfg.enabled) {
        try {
          const nowTsShadow = Date.now();
          const mid = toFiniteNumber(marketState?.midPx, null);
          if (Number.isFinite(mid) && mid > 0) {
            const spreadBps = calcSpreadBps(marketState);
            const pressureImb = calcBookImbalance(marketState);
            const burstUsd1s = calcBurstUsd1s(marketState);
            const dynSlipBps = calcDynSlipBps(spreadBps, pressureImb, burstUsd1s);
            const slipUsd = mid * (dynSlipBps / 10000);
            const qty = shadowCfg.notionalUsd / mid;

            const decisionSide = String(monitorSideRaw || '').toLowerCase();
            const isBuy = decisionSide === 'buy';
            const isSell = decisionSide === 'sell';

            if (!shadowState.open && (isBuy || isSell)) {
              const dir = isBuy ? 'LONG' : 'SHORT';
              const entryPx = dir === 'LONG' ? (mid + slipUsd) : (mid - slipUsd);
              shadowState.open = {
                id: `${nowTsShadow}_${shadowState.seq += 1}`,
                dir,
                ts: nowTsShadow,
                entryPx,
                entryMid: mid,
                qty,
                spreadBps,
                pressureImb,
                burstUsd1s,
                dynSlipBps,
                reason: monitorReasonRaw ?? null
              };
              writeLog({
                ts: nowTsShadow,
                type: 'shadow_open',
                shadowId: shadowState.open.id,
                dir,
                entryPx,
                entryMid: mid,
                qty,
                dynSlipBps,
                spreadBps,
                pressureImb,
                burstUsd1s,
                reason: shadowState.open.reason
              }).catch(() => {});
            } else if (shadowState.open) {
              const open = shadowState.open;
              const timedOut = (nowTsShadow - open.ts) >= shadowCfg.holdMs;
              const flipped = (open.dir === 'LONG' && isSell) || (open.dir === 'SHORT' && isBuy);
              if (timedOut || flipped) {
                const exitPx = open.dir === 'LONG' ? (mid - slipUsd) : (mid + slipUsd);
                const gross = open.dir === 'LONG'
                  ? ((exitPx - open.entryPx) * open.qty)
                  : ((open.entryPx - exitPx) * open.qty);
                const fee = shadowCfg.notionalUsd * (2 * shadowCfg.takerBps / 10000);
                const net = gross - fee;
                writeLog({
                  ts: nowTsShadow,
                  type: 'shadow_close',
                  shadowId: open.id,
                  dir: open.dir,
                  openTs: open.ts,
                  closeTs: nowTsShadow,
                  holdMs: nowTsShadow - open.ts,
                  entryPx: open.entryPx,
                  exitPx,
                  closeMid: mid,
                  qty: open.qty,
                  dynSlipBpsExit: dynSlipBps,
                  grossUsd: gross,
                  feeUsd: fee,
                  netUsd: net,
                  closeReason: flipped ? 'decision_flip' : 'timeout'
                }).catch(() => {});
                shadowState.open = null;
              }
            }
          }
        } catch (_) {}
      }
      
      // 優先度3: 時刻更新（最優先・save前に実行必須）
      tickCount++;
      touchTick(engineState);
      
      // 優先度4: State永続化（5秒ごとに保存、毎ティック I/O ブロック防止）
      // ここで保存される engineState は最新の lastLoopAtMs を含む
      const now = Date.now();
      if (now - lastEngineStateSaveAt >= ENGINE_STATE_SAVE_INTERVAL_MS) {
        saveEngineState(engineState, STATE_PATH);
        lastEngineStateSaveAt = now;
      }
      
      const decisionSideFinal = typeof engineLastDecision?.side === 'string'
        ? engineLastDecision.side
        : (typeof decision?.side === 'string' ? decision.side : null);
      const rawReason = typeof engineLastDecision?.reason === 'string'
        ? engineLastDecision.reason
        : (typeof decision?.reason === 'string' ? decision.reason : null);
      const decisionReason =
        decisionSideFinal && decisionSideFinal.toLowerCase() !== 'none' && rawReason === 'safety_mid_chop'
          ? null
          : rawReason;
      lastDecisionSnapshot = {
        side: decisionSideFinal,
        size: typeof decision?.size === 'number' ? decision.size : null,
        reason: decisionReason,
        reasonCode: resolveReasonCode(
          decisionReason,
          decisionSideFinal && decisionSideFinal.toLowerCase() !== 'none'
            ? REASON_CODE.ENTRY_ALLOWED
            : REASON_CODE.UNKNOWN
        ),
        zone: ioPacket?.ioMetrics?.zone ?? null,
        safety: engineState?.safety?.status ?? null,
        gates: buildGateSnapshot(decision),
        // ENGINE 表示用 context 情報
        supportPrice: decision?.supportPrice ?? null,
        resistancePrice: decision?.resistancePrice ?? null,
        distToSupport: decision?.distToSupport ?? null,
        distToResistance: decision?.distToResistance ?? null,
      };

      // 優先度5: 安全性評価（save後に実行・古い判定を避ける）
      // Note: runtime.js で safety をリセット済みの場合はスキップ（再度 HALTED に戻さない）
      if (engineState.safety?.status !== 'ACTIVE') {
        evaluateSafety(engineState);
      }
      if (!haltedConfirmed && engineState.safety && engineState.safety.status === 'HALTED') {
        haltedConfirmed = true;
        console.log('[TEST] HALTED状態を検知、以降tick再開テスト');
      }
    } finally {
      isEngineLoopRunning = false;  // 【重要】例外時も確実に解除
    }
  }, 1000); // 1秒ごとに実ロジックdecision

  const PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 8788;
  const server = http.createServer((req, res) => {
    // Always emit CORS headers so browser fetches to /health succeed
    Object.entries(corsHeaders).forEach(([key, value]) => res.setHeader(key, value));

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url && req.url.startsWith('/health')) {
      const tradeConfig = getTradeConfig();
      const thresholds = tradeConfig?.feedHealthThresholds;
      const payload = buildHealthReport(thresholds);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === 'GET' && req.url && req.url.startsWith('/balance')) {
      handleBalanceRequest(res, mode);
      return;
    }

    if (req.method === 'POST' && req.url && req.url.startsWith('/api/reset-safety')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          resetSafety(engineState);
          saveEngineState(engineState, STATE_PATH);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({
            success: true,
            safetyStatus: engineState?.safety?.status ?? null,
            updatedAt: Date.now()
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({
            success: false,
            error: err?.message ?? 'reset_safety_failed'
          }));
        }
      });
      return;
    }

    // UI ファイルのサーブ（Ver3）
    // ルート `/` アクセスは `/index.html` として扱う（リダイレクトなし）
    if (req.method === 'GET' && req.url) {
      // クエリパラメータを除去
      const urlWithoutQuery = req.url.split('?')[0];
      
      // ルート `/` は `/index.html` として扱う
      let targetPath = urlWithoutQuery === '/' || urlWithoutQuery === '' ? '/index.html' : urlWithoutQuery;
      
      // ui-web ディレクトリ内のファイルパスに変換
      const filePath = path.join(ROOT, 'ui-web', targetPath);
      console.log(`[UI-SERVE] req.url=${req.url}, targetPath=${targetPath}, filePath=${filePath}`);
      
      // ディレクトリトラバーサル対策
      if (!filePath.startsWith(path.join(ROOT, 'ui-web'))) {
        console.log(`[UI-SERVE] Forbidden: path traversal detected`);
        res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders });
        res.end('Forbidden');
        return;
      }

      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          console.log(`[UI-SERVE] Serving: ${filePath}`);
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const mimeTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.gif': 'image/gif'
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          
          // HTML/JavaScript/CSS は常に最新版を取得（キャッシュ無効化）
          const headers = { 'Content-Type': contentType, ...corsHeaders };
          if (ext === '.html' || ext === '.js' || ext === '.css') {
            headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            headers['Pragma'] = 'no-cache';
            headers['Expires'] = '0';
          }
          
          res.writeHead(200, headers);
          res.end(content);
          return;
        } else {
          console.log(`[UI-SERVE] File not found: ${filePath}, exists=${fs.existsSync(filePath)}`);
        }
      } catch (e) {
        console.log(`[UI-SERVE] Error: ${e.message}`);
      }
      
      res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders });
      res.end('Not found');
      return;
    }

    res.writeHead(404, corsHeaders);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WS] server + health listening on 0.0.0.0:${PORT}`);
  });

  // DASHBOARD: 2秒ごとにengineState.statsをemit
  setInterval(() => {
    try {
      const stats = engineState?.stats ?? {};
      console.log('[DEBUG stats]', stats);
      const history7d = Array.isArray(stats.history7d) ? stats.history7d : [];
      const dailyPnl7d = Array.from({ length: 7 }, () => null);
      const msPerDay = 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const trade of history7d) {
        if (!trade || typeof trade.closedAt !== 'number') continue;
        if (now - trade.closedAt > 6 * msPerDay) continue;
        // 日本時間(JST: UTC+9)で曜日を判定
        const jstTs = trade.closedAt + (9 * 60 * 60 * 1000);
        const weekday = new Date(jstTs).getUTCDay(); // 0=Sun..6=Sat（JST換算）
        const idx = (weekday + 6) % 7; // 0=Mon..6=Sun に並び替え
        const pnl = typeof trade.pnl === 'number' ? trade.pnl : 0;
        dailyPnl7d[idx] = (dailyPnl7d[idx] ?? 0) + pnl;
      }

    const initialCapital = getInitialCapitalUsd();

    // 表示用: USDは実測合計、%は資本ベースでのみ算出
    const totalPnlUsdDisplay = Number(stats.realizedPnl ?? 0);
    const pnlPctDisplay = initialCapital ? (totalPnlUsdDisplay / initialCapital) * 100 : null;
    const baseEquity = mode === 'live'
      ? (baseEquitySnapshot?.equityUsd ?? getBaseEquityLiveUsd())
      : initialCapital;
    const liveEquityUsd = mode === 'live' ? (lastEquitySnapshot?.equityUsd ?? null) : null;
    const liveDeltaUsd = mode === 'live' ? (lastEquitySnapshot?.deltaUsd ?? null) : null;

    const equityDeltaUsd = mode === 'live'
      ? liveDeltaUsd
      : (baseEquity ? totalPnlUsdDisplay : null);
    const counts = {
      longTrades: Number.isFinite(stats.longTrades) ? stats.longTrades : 0,
      longWins: Number.isFinite(stats.longWins) ? stats.longWins : 0,
      shortTrades: Number.isFinite(stats.shortTrades) ? stats.shortTrades : 0,
      shortWins: Number.isFinite(stats.shortWins) ? stats.shortWins : 0,
    };
    const monitorSnapshot = decisionMonitor.getSnapshot({
      nowMs: Date.now(),
      route: mode === 'live' ? 'LIVE' : 'TEST'
    });

    // 5分ごとに取引データを再読み込み・指標計算
    const dashboardTradesPathEnv = resolveDashboardTradesEnvOverride();
    const trades = loadTradesFromLog(mode, dashboardTradesPathEnv) ?? [];
    const dashMetrics = calcDashboardMetrics(trades, baseEquity || getBaseEquityLiveUsd() || 2000);
    
    // 【DEBUG】dashMetrics の状態をログ出力
    console.log('[DASHBOARD] dashMetrics calc', {
      tradesCount: trades.length,
      tradeCount: dashMetrics.tradeCount,
      totalPnl: dashMetrics.totalPnl,
      pfDisplay: dashMetrics.pfDisplay,
      winRateDisplay: dashMetrics.winRateDisplay,
    });
    
    // 【修正】equityUsd を dashMetrics.totalPnl から計算（stats.realizedPnl ではなく trades.jsonl ベース）
    const equityUsd = mode === 'live'
      ? liveEquityUsd ?? baseEquity ?? null
      : (baseEquity ? baseEquity + (dashMetrics.totalPnl ?? 0) : null);
    
    const tradeConfig = getTradeConfig();
    const autoHalt = shouldAutoHaltFromRecentTrades({ mode, tradeConfig, trades });
    if (autoHalt) {
      const currentStatus = String(engineState?.safety?.status ?? 'NORMAL').toUpperCase();
      const currentReason = String(engineState?.safety?.reason ?? '');
      if (currentStatus !== 'HALTED' || currentReason !== autoHalt.reason) {
        if (!engineState.safety) engineState.safety = { status: 'NORMAL', reason: null, since: null };
        engineState.safety.status = 'HALTED';
        engineState.safety.reason = autoHalt.reason;
        engineState.safety.since = Date.now();
        console.warn(`[AUTO_HALT] ${autoHalt.reason} ${autoHalt.detail}`);
        saveEngineState(engineState, STATE_PATH);
      }
    }
    // FEED HEALTH データを取得
    const b1SnapshotRefresh = resolveB1SnapshotRefreshSetting(tradeConfig);
    const thresholds = tradeConfig?.feedHealthThresholds;
    const healthReport = buildHealthReport(thresholds);
    const ioPacket = getIOPacket();
    const market = ioPacket?.marketState?.current ?? engineState?.market ?? null;
    const wsLive = buildWsLiveSnapshot(market, ioPacket?.ioMetrics ?? null);
    const exitSignals = buildExitSignalsSnapshot(engineState?.openPosition ?? null, market, tradeConfig, Date.now());
    const position = buildPositionSnapshot(engineState?.openPosition ?? null, market, tradeConfig, Date.now());
    const recentTrades = buildRecentTradesSnapshot(trades, 10);
    const normalizedTrades = buildRecentTradesSnapshot(trades, Math.max(1, trades.length));
    const trades30d = filterLastDaysTrades(normalizedTrades, 30, Date.now());
    const allTrades = buildAllTradesSnapshot(trades30d);
    const startingEquity = (Number.isFinite(baseEquity) ? baseEquity : initialCapital) ?? 0;
    const equityTimeSeries = buildEquityTimeSeries(trades30d, startingEquity);
    const stats30d = calculate30DayStats(trades30d, startingEquity);
    const dailyPnl = buildDailyPnl(trades30d);
    const pnlSummary30d = buildPnlSummary(trades30d);
    const exitBreakdown = buildExitBreakdown(trades30d);
    const executionQuality = buildExecutionQuality(trades30d);
    const expectancy = buildExpectancy(trades30d, 30);
    const maeStats = buildMaeStats(trades30d);
    const gateBlocks = buildGateBlockReasons(monitorSnapshot);
    const regimeMap = buildRegimeMapSnapshot();
    if (wsLive && typeof wsLive === 'object') {
      wsLive.bLrcAngleDeg = toFiniteNumber(regimeMap?.bAngleDeg, toFiniteNumber(wsLive?.bLrcAngleDeg, null));
      wsLive.bChannelClusterCount = toFiniteNumber(regimeMap?.bChannelClusterCount ?? regimeMap?.clusterCount, null);
      wsLive.aCandleReady = regimeMap?.aCandleReady === true || wsLive.aCandleReady === true;
      wsLive.aCandleBarCount = toFiniteNumber(regimeMap?.aCandleBarCount, toFiniteNumber(wsLive?.aCandleBarCount, null));
    }
    const orderBook = buildOrderBookSnapshot(market, 5);
    
    const dashboardPayload = {
      type: 'dashboard',
      runtimeMode: mode,
      runtimeTestMode: String(process.env.TEST_MODE ?? ''),
      equitySourceMode: (mode === 'live' && String(process.env.TEST_MODE ?? '') !== '1')
        ? 'account_live'
        : 'strategy_simulated',
      pnlEquityComparable: !((mode === 'live' && String(process.env.TEST_MODE ?? '') !== '1')),
      // USDと%を明確に分離（旧フィールドは後方互換）
      totalPnlUsd: totalPnlUsdDisplay,
      pnlPct: pnlPctDisplay,
      equityUsd,
      equityDeltaUsd,
      realizedPnl: stats.realizedPnl ?? 0,
      realizedPnlPct: stats.realizedPnlPct ?? 0,
      win_rate:
        typeof stats.totalTrades === 'number' && stats.totalTrades > 0
          ? (stats.winTrades / stats.totalTrades) * 100
          : null,
      apr_7d: initialCapital ? stats.apr7d ?? null : null,
      apr_30d: null,
      apr_180d: null,
      apr_365d: null,
      daily_pnl_7d: dailyPnl7d,
      btcPrice: typeof stats.midPx === 'number' ? stats.midPx : null,
      btcOi: toFiniteNumber(market?.oi, toFiniteNumber(stats.oi, null)),
      btcChange:
        typeof stats.midPx === 'number' && typeof stats.prevMidPx === 'number'
          ? ((stats.midPx - stats.prevMidPx) / stats.prevMidPx) * 100
          : 0,
      safetyStatus: engineState.safety?.status ?? 'NORMAL',
      marketSrc: engineState.market?._src ?? (engineState.market ? 'io' : null),
      engineUpdatedAt:
        Math.max(
          Number.isFinite(engineState.lastUpdate) ? engineState.lastUpdate : 0,
          Number.isFinite(engineState.lastLoopAtMs) ? engineState.lastLoopAtMs : 0
        ) || null,
      dashboardSentAt: Date.now(),
      uptime: formatUptime(Date.now() - processStartAt),
      bar1hWarmupRemainingMs: (() => {
        const isTestMode = String(process.env.TEST_MODE ?? '') === '1';
        const bar1hReady = ioPacket?.ioMetrics?.bar1hState?.ready ?? false;
        if (bar1hReady) return 0;
        const bar1hLookbackBars = getTradeConfig()?.bar1h?.lookbackBars ?? 3;
        const gateRequiredBars = isTestMode ? 1 : bar1hLookbackBars;
        const requiredMs = gateRequiredBars * 60 * 60 * 1000;
        const elapsedMs = Date.now() - processStartAt;
        const remainingMs = Math.max(0, requiredMs - elapsedMs);
        return remainingMs;
      })(),
      decisionSide: lastDecisionSnapshot.side,
      decisionSize: lastDecisionSnapshot.size,
      decisionReason: lastDecisionSnapshot.reason,
      decisionReasonCode: lastDecisionSnapshot.reasonCode ?? null,
      decisionZone: lastDecisionSnapshot.zone,
      decisionSafety: lastDecisionSnapshot.safety,
      decisionSupportPrice: lastDecisionSnapshot.supportPrice,
      decisionResistancePrice: lastDecisionSnapshot.resistancePrice,
      decisionDistToSupport: lastDecisionSnapshot.distToSupport,
      decisionDistToResistance: lastDecisionSnapshot.distToResistance,
      gates: lastDecisionSnapshot.gates ?? null,
      startupGuard: lastDecisionSnapshot.gates?.startupGuard ?? null,
      startupNoOrderRemainingMs: toFiniteNumber(lastDecisionSnapshot.gates?.startupGuard?.noOrderRemainingMs, null),
      startupWindowRemainingMs: toFiniteNumber(lastDecisionSnapshot.gates?.startupGuard?.windowRemainingMs, null),
      wsLive,
      exitSignals,
      position,
      recentTrades,
      allTrades,
      equityTimeSeries,
      stats30d,
      dailyPnl,
      pnlSummary30d,
      exitBreakdown,
      executionQuality,
      expectancy,
      maeStats,
      gateBlockReasons: gateBlocks.gateBlockReasons,
      totalBlocks: gateBlocks.totalBlocks,
      regimeMap,
      orderBook,
      initialCapital,
      tradePnlPctSum: stats.realizedPnlPct ?? null,
      // --- ACTIVITY フィールド （Bロジック評価回数、エントリー実行数）---
      // ⚠️ Fix: decisionMonitor インスタンスではなく monitorSnapshot（L981）を使用
      activityEvaluated: monitorSnapshot?.evaluated ?? 0,
      activityEntered: monitorSnapshot?.entered ?? 0,
      activityEntryRate: Number.isFinite(toFiniteNumber(monitorSnapshot?.entryRate, null))
        ? Number(monitorSnapshot.entryRate)
        : ((monitorSnapshot?.evaluated ?? 0) > 0 ? (monitorSnapshot?.entered ?? 0) / (monitorSnapshot?.evaluated ?? 1) : 0),
      activityEntryRatePct: Number.isFinite(toFiniteNumber(monitorSnapshot?.entryRatePct, null))
        ? Number(monitorSnapshot.entryRatePct)
        : null,
      activityEntryRateMinTarget: toFiniteNumber(getTradeConfig()?.entryRateMonitor?.minEntryRate, 0.02),
      activityEntryRateMaxTarget: toFiniteNumber(getTradeConfig()?.entryRateMonitor?.maxEntryRate, 0.1),
      activityTopReasons: Array.isArray(monitorSnapshot?.topRawReasons) ? monitorSnapshot.topRawReasons : [],
      activityTopAGateReasons: Array.isArray(monitorSnapshot?.topAGateReasons) ? monitorSnapshot.topAGateReasons : [],
      // --- SAFETY フィールド ---
      safetyTriggered: (engineState.safety?.status ?? 'NORMAL') !== 'NORMAL',
      safetyMessage: engineState.safety?.reason ?? '—',
      safetySince: engineState.safety?.since ?? null,
      // --- PERFORMANCE フィールド （equity/trades/winRate/PF/MaxDD）---
      perfEquity: equityUsd ?? null,
      perfPnl: dashMetrics.totalPnl ?? 0,  // 取引による損益
      perfPnlPct: dashMetrics.totalPnl && initialCapital ? (dashMetrics.totalPnl / initialCapital) * 100 : 0,  // 損益率
      perfPnlBasis: 'net_after_fee',
      perfPnlIncludesFee: true,
      perfPnlScope: 'since_start_trades_log',
      perfEquityScope: mode === 'live' ? 'live_account_equity' : 'sim_equity',
      perfEquityDeltaUsd: Number.isFinite(toFiniteNumber(equityDeltaUsd, null)) ? Number(equityDeltaUsd) : null,
      perfPnlVsEquityGapUsd:
        Number.isFinite(toFiniteNumber(equityDeltaUsd, null)) && Number.isFinite(toFiniteNumber(dashMetrics.totalPnl, null))
          ? Number(equityDeltaUsd) - Number(dashMetrics.totalPnl)
          : null,
      perfTrades: dashMetrics.tradeCount ?? 0,  // 【修正】stats.totalTrades（メモリカウンター）ではなく dashMetrics.tradeCount（trades.jsonl から）を使用
      perfTradesSinceStart: dashMetrics.tradeCount ?? 0,
      perfTradesSession: Number.isFinite(stats.totalTrades) ? stats.totalTrades : 0,
      perfTradesScope: 'since_start',
      perfWinRate: dashMetrics.winRateDisplay ?? '—',
      perfPf: dashMetrics.pfDisplay ?? null,
      perfMaxDD: dashMetrics.maxDDDisplay ?? null,
      // LONG/SHORT は history7d を優先し、空なら stats の既存値をフォールバック
      longTrades: counts.longTrades,
      longWins: counts.longWins,
      shortTrades: counts.shortTrades,
      shortWins: counts.shortWins,
      dataState: lastDataStatus.dataState ?? null,
      stopReason: lastDataStatus.stopReason ?? null,
      dataHint: lastDataStatus.dataHint ?? null,
      decisionMonitor: monitorSnapshot,
      // ダッシュボード Phase 1 指標
      dashPf: dashMetrics.pfDisplay,
      dashPfLabel: dashMetrics.pfLabel,
      dashWinRate: dashMetrics.winRateDisplay,
      dashLongTrades: dashMetrics.longTrades,
      dashLongWins: dashMetrics.longWins,
      dashLongWinRate: dashMetrics.longWinRate,
      dashShortTrades: dashMetrics.shortTrades,
      dashShortWins: dashMetrics.shortWins,
      dashShortWinRate: dashMetrics.shortWinRate,
      dashTradeCount: dashMetrics.tradeCount,
      // Phase 2 指標
      dashRr: dashMetrics.rrDisplay,
      dashRrLabel: dashMetrics.rrLabel,
      dashAvWin: dashMetrics.avWinDisplay,
      dashAvLoss: dashMetrics.avLossDisplay,
      // Phase 3 指標
      dashMaxDD: dashMetrics.maxDDDisplay,
      // FEED HEALTH データ
      feedHealth: healthReport,
      // STRUCTURE SNAPSHOT (UI用フィールド名で送信)
      structureSnapshot: lastDecisionSnapshot.structureSnapshot ?? null,
      // TRADES LOG SOURCE（UI表示用）
      tradesSourcePath: getTradesSourcePath(mode, dashboardTradesPathEnv),
      b1SnapshotRefreshSec: b1SnapshotRefresh.sec,
      b1SnapshotRefreshSource: b1SnapshotRefresh.source
    };
    console.log('[DASHBOARD SEND]', {
      safetyStatus: dashboardPayload.safetyStatus,
      btcPrice: dashboardPayload.btcPrice,
      btcOi: dashboardPayload.btcOi,
      realizedPnl: dashboardPayload.realizedPnl,
      perfTrades: dashboardPayload.perfTrades,
      perfPnl: dashboardPayload.perfPnl,
      perfEquity: dashboardPayload.perfEquity,
      decisionMonitor: dashboardPayload.decisionMonitor ? { evaluated: dashboardPayload.decisionMonitor.evaluated, entered: dashboardPayload.decisionMonitor.entered } : null,
      activityEntryRate: dashboardPayload.activityEntryRate,
      b1SnapshotRefresh: `${dashboardPayload.b1SnapshotRefreshSec}s (${dashboardPayload.b1SnapshotRefreshSource})`,
    });
    if (DASHBOARD_PAYLOAD_DEBUG) {
      // DEBUG時のみペイロード全体をファイルにダンプ
      fs.appendFileSync('/tmp/dashboard_payload.jsonl', JSON.stringify({ ts: Date.now(), payload: dashboardPayload }) + '\n');
    }
    // ws-status-v1も同時送信
    const now2 = Date.now();
    const delta = now2 - lastWsSendTs;
    const status = evaluateStatus({
      lastMarketAt,
      now: now2,
      hlEnabled,
      registryReport,
      heartbeatDelta: delta,
    });
    const wsStatusV1Payload = {
      type: 'ws-status-v1',
      state: status.state,
      severity: status.severity,
      stoppedAt: status.stoppedAt ?? null,
      hint: status.hint,
      dataState: lastDataStatus.dataState ?? null,
      stopReason: lastDataStatus.stopReason ?? null,
      dataHint: lastDataStatus.dataHint ?? null,
      mode,
      hlEnabled,
      isTestMode: process.env.TEST_MODE === '1',
      tradesSourcePath: getTradesSourcePath(mode, resolveDashboardTradesEnvOverride()),
      cores: registryReport.cores,
      b1SnapshotRefreshSec: b1SnapshotRefresh.sec,
      b1SnapshotRefreshSource: b1SnapshotRefresh.source,
    };
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(dashboardPayload));
        client.send(JSON.stringify(wsStatusV1Payload));
        console.log('[WS STATUS V1 SEND]', wsStatusV1Payload);
      }
    });
      lastWsSendTs = Date.now();
    } catch (err) {
      console.error('[DASHBOARD] emit failed', err);
    }
  }, 2000);

  const initialStatus = evaluateStatus({
    lastMarketAt,
    now: Date.now(),
    hlEnabled,
    registryReport,
    heartbeatDelta: null,
  });
  const startupB1SnapshotRefresh = resolveB1SnapshotRefreshSetting(getTradeConfig());
  const startupStatusPayload = {
    type: 'ws-status-v1',
    state: initialStatus.state,
    severity: initialStatus.severity,
    stoppedAt: initialStatus.stoppedAt ?? null,
    hint: initialStatus.hint,
    dataState: lastDataStatus.dataState ?? null,
    stopReason: lastDataStatus.stopReason ?? null,
    dataHint: lastDataStatus.dataHint ?? null,
    mode,
    hlEnabled,
    isTestMode: process.env.TEST_MODE === '1',
    tradesSourcePath: getTradesSourcePath(mode, resolveDashboardTradesEnvOverride()),
    cores: registryReport.cores,
    b1SnapshotRefreshSec: startupB1SnapshotRefresh.sec,
    b1SnapshotRefreshSource: startupB1SnapshotRefresh.source,
  };

  wss.on('connection', (ws, req) => {
    // クライアント接続時にws-status: CONNECTEDを送信
    ws.send(JSON.stringify({ type: 'ws-status', state: 'CONNECTED' }));
    // 最新のstatusを送信（起動時のものではなく）
    const currentStatus = evaluateStatus({
      lastMarketAt,
      now: Date.now(),
      hlEnabled,
      registryReport,
      heartbeatDelta: null,
    });
    const currentB1SnapshotRefresh = resolveB1SnapshotRefreshSetting(getTradeConfig());
    const currentStatusPayload = {
      type: 'ws-status-v1',
      state: currentStatus.state,
      severity: currentStatus.severity,
      stoppedAt: currentStatus.stoppedAt ?? null,
      hint: currentStatus.hint,
      dataState: lastDataStatus.dataState ?? null,
      stopReason: lastDataStatus.stopReason ?? null,
      dataHint: lastDataStatus.dataHint ?? null,
      mode,
      hlEnabled,
      isTestMode: process.env.TEST_MODE === '1',
      tradesSourcePath: getTradesSourcePath(mode, resolveDashboardTradesEnvOverride()),
      cores: registryReport.cores,
      b1SnapshotRefreshSec: currentB1SnapshotRefresh.sec,
      b1SnapshotRefreshSource: currentB1SnapshotRefresh.source,
    };
    ws.send(JSON.stringify(currentStatusPayload));

    // wsCoreの接続ハンドラを呼び出し（未実装の場合はコメントアウト可）
    if (wsCore && typeof wsCore.handleConnection === 'function') {
      wsCore.handleConnection(ws, req);
    } else {
      ws.send(JSON.stringify({ type: 'info', message: 'WSサーバ稼働中 (handleConnection未実装)' }));
    }

    // クライアント切断時は他クライアントへは通知しない
    // （全クライアントへDISCONNECTEDをブロードキャストすると、
    //  未切断のクライアントでもUIが「disconnected」誤表示になるため）
    ws.on('close', () => {
      console.log('[WS CLIENT CLOSED]', { ip: req.socket.remoteAddress });
    });
  });

  // ★ Case B: 構造的分離 - runtime が完全に初期化されたここで ws-status-v1 を emit
  // これにより、depth.ts側のSR初期化とは無関係に起動ゲートを解放する
  // （listening ではなく、全リソース初期化完了後）
  const bootStatus = evaluateStatus({
    lastMarketAt: null,
    now: Date.now(),
    hlEnabled,
    registryReport,
    heartbeatDelta: null,
  });
  const bootB1SnapshotRefresh = resolveB1SnapshotRefreshSetting(getTradeConfig());
  const bootStatusPayload = {
    type: 'ws-status-v1',
    state: bootStatus.state,
    severity: bootStatus.severity,
    stoppedAt: bootStatus.stoppedAt ?? null,
    hint: 'runtime-ready',
    dataState: null,
    stopReason: null,
    dataHint: null,
    mode,
    hlEnabled,
    isTestMode: process.env.TEST_MODE === '1',
    tradesSourcePath: getTradesSourcePath(mode, resolveDashboardTradesEnvOverride()),
    cores: registryReport.cores,
    b1SnapshotRefreshSec: bootB1SnapshotRefresh.sec,
    b1SnapshotRefreshSource: bootB1SnapshotRefresh.source,
  };
  console.log('[BOOT STATUS] Emitting ws-status-v1 after full initialization:', bootStatus.state);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(bootStatusPayload));
    }
  });

  // イベントバッファ（リングバッファ最大100件）
  const eventBuffer = [];
  const MAX_EVENTS = 100;
  function pushEvent(event) {
    eventBuffer.push(event);
    if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
    broadcast({ type: 'event', event });
  }

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  // bridgeEmitter経由のengine-eventをバッファにpush
  bridgeEmitter.on('ENGINE_PNL_UPDATE', (payload) => pushEvent({ type: 'ENGINE_PNL_UPDATE', ...payload }));
  bridgeEmitter.on('ENGINE_POSITION_UPDATE', (payload) => pushEvent({ type: 'ENGINE_POSITION_UPDATE', ...payload }));
  bridgeEmitter.on('ENGINE_ERROR', (payload) => pushEvent({ type: 'ENGINE_ERROR', ...payload }));
  bridgeEmitter.on('debug-packet', (payload) => {
    if (payload?.layer === 'logic' && payload?.data?.line) {
      console.log(payload.data.line);
    }
  });

  wss.on('listening', () => {
    console.log(`WSサーバがポート${PORT}で待機中 (0.0.0.0)`);
  });

  wss.on('error', (err) => {
    console.error('WSサーバエラー:', err);
  });

  // 必要に応じてwsCoreの初期化関数を呼び出し
  if (wsCore && typeof wsCore.init === 'function') {
    wsCore.init();
  }
}
