function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeEdgeAffinity(channelPos) {
  // 0 at center, 1 at edges.
  return clamp(Math.abs(channelPos - 0.5) * 2, 0, 1);
}

function computeAlignment(regime, side, channelPos) {
  const r = String(regime || '').toUpperCase();
  const s = String(side || '').toLowerCase();
  if (r === 'UP') {
    if (s === 'buy') return clamp((0.55 - channelPos) / 0.55, 0, 1);
    if (s === 'sell') return clamp((channelPos - 0.45) / 0.55, 0, 1) * 0.35;
  }
  if (r === 'DOWN') {
    if (s === 'sell') return clamp((channelPos - 0.45) / 0.55, 0, 1);
    if (s === 'buy') return clamp((0.55 - channelPos) / 0.55, 0, 1) * 0.35;
  }
  // RANGE: edge reversions both sides.
  return clamp(Math.abs(channelPos - 0.5) * 2, 0, 1);
}

export function computeLrcWsOrbit(payload, regime, side, executionSignals, tradeConfig) {
  const cfg = tradeConfig?.lrcWsOrbit ?? {};
  const enabled = cfg.enabled === true;
  if (!enabled) {
    return {
      enabled: false,
      score: 0,
      edgeRatioMul: 1,
      sizeScalarMul: 1,
      tpStretchMul: 1,
      forceMaker: false,
      diagnostics: { reason: 'disabled' }
    };
  }

  const lrc = payload?.ioMetrics?.lrcState ?? null;
  const mid = toNumber(payload?.market?.midPx);
  const top = toNumber(lrc?.channelTop);
  const bottom = toNumber(lrc?.channelBottom);
  const validChannel = Number.isFinite(mid) && Number.isFinite(top) && Number.isFinite(bottom) && top > bottom;
  if (!validChannel) {
    return {
      enabled: true,
      score: 0,
      edgeRatioMul: 1,
      sizeScalarMul: 1,
      tpStretchMul: 1,
      forceMaker: false,
      diagnostics: { reason: 'no_lrc_channel' }
    };
  }

  const channelPos = clamp((mid - bottom) / (top - bottom), 0, 1);
  const edgeAffinity = computeEdgeAffinity(channelPos);
  const alignment = computeAlignment(regime, side, channelPos);

  const spreadRef = Math.max(0.1, toNumber(cfg.microSpreadBpsRef, 0.8));
  const velocityRef = Math.max(0.1, toNumber(cfg.microVelocityBpsRef, 0.8));
  const shockRef = Math.max(0.05, toNumber(cfg.microShockRef, 0.25));

  const spreadPenalty = clamp(toNumber(executionSignals?.spreadBps, 0) / spreadRef, 0, 1.6);
  const velocityPenalty = clamp(toNumber(executionSignals?.velocityBps, 0) / velocityRef, 0, 1.6);
  const shockPenalty = clamp(toNumber(executionSignals?.cShock, 0) / shockRef, 0, 1.6);
  const friction = clamp(spreadPenalty * 0.45 + velocityPenalty * 0.35 + shockPenalty * 0.2, 0, 1.6);

  const opportunity = clamp(edgeAffinity * 0.55 + alignment * 0.45, 0, 1);
  const score = clamp(opportunity - friction * 0.75, -1, 1);

  const edgeBoostMax = clamp(toNumber(cfg.edgeRatioBoostMax, 0.22), 0, 0.5);
  const edgePenaltyMax = clamp(toNumber(cfg.edgeRatioPenaltyMax, 0.18), 0, 0.5);
  const sizeBoostMax = clamp(toNumber(cfg.zoneBoostMax, 0.2), 0, 0.8);
  const sizePenaltyMax = clamp(toNumber(cfg.zonePenaltyMax, 0.25), 0, 0.8);
  const tpBoostMax = clamp(toNumber(cfg.tpStretchBoostMax, 0.12), 0, 0.5);
  const tpPenaltyMax = clamp(toNumber(cfg.tpStretchPenaltyMax, 0.08), 0, 0.5);

  const edgeRatioMul = score >= 0
    ? 1 + edgeBoostMax * score
    : 1 + edgePenaltyMax * score;
  const sizeScalarMul = score >= 0
    ? 1 + sizeBoostMax * score
    : 1 + sizePenaltyMax * score;
  const tpStretchMul = score >= 0
    ? 1 + tpBoostMax * score
    : 1 + tpPenaltyMax * score;

  const forceMaker = friction >= 1.05;

  return {
    enabled: true,
    score,
    edgeRatioMul: clamp(edgeRatioMul, 0.7, 1.5),
    sizeScalarMul: clamp(sizeScalarMul, 0.6, 1.8),
    tpStretchMul: clamp(tpStretchMul, 0.8, 1.4),
    forceMaker,
    diagnostics: {
      channelPos,
      edgeAffinity,
      alignment,
      spreadPenalty,
      velocityPenalty,
      shockPenalty,
      friction,
      opportunity
    }
  };
}

