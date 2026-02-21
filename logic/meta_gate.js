import { getTradeConfig } from '../config/trade.js';

const DEFAULT_STATE = {
  lastSpreadBps: null,
  lastToxicUntilTs: 0
};

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeSpreadBps(midPx, bestBid, bestAsk) {
  if (!Number.isFinite(midPx) || midPx <= 0) return null;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  const spread = bestAsk - bestBid;
  if (!Number.isFinite(spread) || spread < 0) return null;
  return (spread / midPx) * 10000;
}

export function createMetaGateState() {
  return { ...DEFAULT_STATE };
}

export function evaluateMetaGate(payload, state = createMetaGateState(), nowTs = Date.now()) {
  const tradeConfig = getTradeConfig();
  const cfg = tradeConfig?.metaGate ?? {};
  if (cfg.enabled === false) {
    return {
      allow: true,
      reason: 'meta_gate_disabled',
      score: 0,
      diagnostics: null,
      nextState: state
    };
  }

  const market = payload?.market ?? {};
  const ioMetrics = payload?.ioMetrics ?? {};
  const midPx = toNumber(market.midPx);
  const bestBid = toNumber(market.bestBid);
  const bestAsk = toNumber(market.bestAsk);
  const c = toNumber(ioMetrics.c);
  const cPrev = toNumber(ioMetrics.cPrev);

  const spreadBps = computeSpreadBps(midPx, bestBid, bestAsk);
  const prevSpreadBps = toNumber(state?.lastSpreadBps);
  const spreadJumpBps = Number.isFinite(spreadBps) && Number.isFinite(prevSpreadBps)
    ? Math.max(0, spreadBps - prevSpreadBps)
    : 0;
  const priceVelocityBps = Number.isFinite(midPx) && midPx > 0
    ? Math.abs(Number(ioMetrics?.diffs?.midPx ?? 0)) / midPx * 10000
    : 0;
  const cShock = Number.isFinite(c) && Number.isFinite(cPrev) ? Math.abs(c - cPrev) : 0;
  const stalePenalty = ioMetrics?.dataFreshness === 'STALE' ? 1 : 0;
  const noDepthPenalty = ioMetrics?.depthSR?.ready ? 0 : 1;

  const maxSpreadBps = toNumber(cfg.maxSpreadBps) ?? 2.5;
  const maxSpreadJumpBps = toNumber(cfg.maxSpreadJumpBps) ?? 0.8;
  const maxPriceVelocityBps = toNumber(cfg.maxPriceVelocityBps) ?? 1.8;
  const maxCShock = toNumber(cfg.maxCShock) ?? 0.6;
  const toxicityThreshold = toNumber(cfg.toxicityThreshold) ?? 1.25;
  const holdMs = Math.max(0, Math.floor(toNumber(cfg.holdMs) ?? 2500));

  const spreadScore = Number.isFinite(spreadBps) ? spreadBps / Math.max(0.01, maxSpreadBps) : 0;
  const spreadJumpScore = spreadJumpBps / Math.max(0.01, maxSpreadJumpBps);
  const velocityScore = priceVelocityBps / Math.max(0.01, maxPriceVelocityBps);
  const cShockScore = cShock / Math.max(0.01, maxCShock);
  const score = (
    spreadScore * 0.35 +
    spreadJumpScore * 0.2 +
    velocityScore * 0.2 +
    cShockScore * 0.15 +
    stalePenalty * 0.25 +
    noDepthPenalty * 0.2
  );

  const normalizedScore = clamp(score, 0, 3);
  const toxicNow = normalizedScore >= toxicityThreshold;
  const toxicUntil = toxicNow
    ? nowTs + holdMs
    : Math.max(0, Number(state?.lastToxicUntilTs ?? 0));
  const latched = nowTs < toxicUntil;
  const allow = !latched;
  const reason = allow ? 'meta_gate_ok' : 'meta_toxic_flow';

  const nextState = {
    lastSpreadBps: Number.isFinite(spreadBps) ? spreadBps : state?.lastSpreadBps ?? null,
    lastToxicUntilTs: toxicUntil
  };

  return {
    allow,
    reason,
    score: normalizedScore,
    diagnostics: {
      spreadBps,
      spreadJumpBps,
      priceVelocityBps,
      cShock,
      stalePenalty,
      noDepthPenalty,
      toxicityThreshold,
      toxicNow,
      latched,
      holdMs
    },
    nextState
  };
}
