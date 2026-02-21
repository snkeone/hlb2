export function formatEntryFlowInactiveDiagnostics(mode, reason) {
  return { enabled: true, active: false, mode, reason };
}

export function formatEntryFlowBaseDiagnostics(params) {
  const {
    mode,
    windowMs,
    minTrades,
    tradeCount,
    flowPressure,
    normalizedFlowPressure,
    source
  } = params;

  return {
    enabled: true,
    active: true,
    mode,
    windowMs,
    minTrades,
    tradeCount,
    flowPressure,
    normalizedFlowPressure,
    source
  };
}

export function formatEntryFlowDivergenceDiagnostics(baseDiagnostics, divergence) {
  const {
    fp5,
    fp60,
    w5Count,
    w60Count,
    minTrades5,
    minTrades60,
    shortStrongTh
  } = divergence;

  return {
    ...baseDiagnostics,
    divergence: {
      enabled: true,
      flowPressure5s: fp5,
      flowPressure60s: fp60,
      trades5s: w5Count,
      trades60s: w60Count,
      minTrades5,
      minTrades60,
      shortStrengthThreshold: shortStrongTh
    }
  };
}

export function formatEntryFlowInsufficientSampleDiagnostics(baseDiagnostics) {
  return { ...baseDiagnostics, active: false, reason: 'insufficient_sample' };
}

export function formatEntryFlowAlignedDiagnostics(baseDiagnostics, alignedThreshold, decidedSide) {
  return {
    ...baseDiagnostics,
    alignedThreshold,
    decidedSide
  };
}

export function formatEntryFlowHostileDiagnostics(baseDiagnostics, hostileThreshold) {
  return { ...baseDiagnostics, hostileThreshold };
}

export function formatEntryFlowFinalDiagnostics(baseDiagnostics, decidedSide, hostileThresholdLong, hostileThresholdShort) {
  return {
    ...baseDiagnostics,
    hostileThreshold: decidedSide === 'buy' ? -hostileThresholdLong : hostileThresholdShort
  };
}