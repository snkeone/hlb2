function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function evaluateBContainmentGate(ioMetrics, aResult, tradeConfig) {
  const cfg = tradeConfig?.b2Upgrade?.containmentGate ?? {};
  if (cfg.enabled !== true) {
    return { blocked: false, reason: null, diagnostics: { enabled: false } };
  }

  const minInclusionRatio = clamp(toNumber(cfg.minInclusionRatio, 0.7), 0.1, 1.0);
  const requireReady = cfg.requireReady !== false;
  const arena = aResult?.arena ?? {};
  const b15m = ioMetrics?.lrcTvState ?? {};
  const aTop = toNumber(arena?.channelTop);
  const aBottom = toNumber(arena?.channelBottom);
  const bTop = toNumber(b15m?.channelTop);
  const bBottom = toNumber(b15m?.channelBottom);
  const bReady = b15m?.ready === true;

  const hasValidA = Number.isFinite(aTop) && Number.isFinite(aBottom) && aTop > aBottom;
  const hasValidB = Number.isFinite(bTop) && Number.isFinite(bBottom) && bTop > bBottom;
  if (!hasValidA) {
    return {
      blocked: false,
      reason: null,
      diagnostics: {
        enabled: true,
        blocked: false,
        reason: 'invalid_a_arena',
        requireReady,
        minInclusionRatio,
        aTop: null,
        aBottom: null,
        bTop: hasValidB ? bTop : null,
        bBottom: hasValidB ? bBottom : null,
        bReady
      }
    };
  }
  if (!hasValidB || (requireReady && !bReady)) {
    const blocked = true;
    return {
      blocked,
      reason: blocked ? 'B: 15m channel not ready' : null,
      diagnostics: {
        enabled: true,
        blocked,
        reason: !hasValidB ? 'invalid_b15m_channel' : 'b15m_not_ready',
        requireReady,
        minInclusionRatio,
        aTop,
        aBottom,
        bTop: hasValidB ? bTop : null,
        bBottom: hasValidB ? bBottom : null,
        bReady
      }
    };
  }

  const bWidth = bTop - bBottom;
  const overlapTop = Math.min(aTop, bTop);
  const overlapBottom = Math.max(aBottom, bBottom);
  const overlapWidth = Math.max(0, overlapTop - overlapBottom);
  const inclusionRatio = bWidth > 0 ? overlapWidth / bWidth : 0;
  const blocked = inclusionRatio < minInclusionRatio;

  return {
    blocked,
    reason: blocked ? 'B: 15m channel not contained in A arena' : null,
    diagnostics: {
      enabled: true,
      blocked,
      minInclusionRatio,
      inclusionRatio,
      overlapWidth,
      bWidth,
      aTop,
      aBottom,
      bTop,
      bBottom,
      bReady
    }
  };
}