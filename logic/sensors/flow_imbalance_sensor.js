function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function collectFlowImbalanceSensor(ioMetrics = {}, tradeConfig = {}) {
  const cfg = tradeConfig?.entryFlowGate ?? {};
  const flow = ioMetrics?.tradeFlow;
  if (!flow || typeof flow !== 'object') {
    return {
      available: false,
      mode: null,
      reason: 'no_trade_flow'
    };
  }

  const modeRaw = String(cfg.mode ?? 'hostile_only').toLowerCase();
  const mode = ['off', 'hostile_only', 'with_trend_only'].includes(modeRaw)
    ? modeRaw
    : 'hostile_only';

  const windowMs = Math.max(1000, Math.floor(
    toNumber(cfg.windowMs, toNumber(flow.windowMs, 30000))
  ));
  const minTrades = Math.max(1, Math.floor(
    toNumber(cfg.minTrades, toNumber(flow.minTradesForSignal, 8))
  ));
  const hostileThresholdLong = clamp(toNumber(cfg.hostileThresholdLong, 0.22), 0.01, 0.95);
  const hostileThresholdShort = clamp(toNumber(cfg.hostileThresholdShort, 0.22), 0.01, 0.95);
  const alignedThresholdLong = clamp(toNumber(cfg.alignedThresholdLong, 0.05), 0, 0.95);
  const alignedThresholdShort = clamp(toNumber(cfg.alignedThresholdShort, 0.05), 0, 0.95);
  const preferWindow = cfg.preferWindow !== false;

  const windows = flow?.windows ?? {};
  const bucket = preferWindow
    ? (windows[String(windowMs)] ?? windows[windowMs] ?? null)
    : null;

  const tradeCount = Math.max(
    0,
    Math.floor(toNumber(bucket?.tradeCount, toNumber(flow.tradeCount, 0)))
  );
  const flowPressure = toNumber(
    bucket?.ofi,
    toNumber(bucket?.flowPressure, toNumber(flow.ofi, toNumber(flow.flowPressure, 0)))
  );
  const normalizedFlowPressure = Number.isFinite(flowPressure)
    ? clamp(flowPressure, -1, 1)
    : null;

  const w5 = windows['5000'] ?? windows[5000] ?? null;
  const w60 = windows['60000'] ?? windows[60000] ?? null;
  const w5Count = Math.max(0, Math.floor(toNumber(w5?.tradeCount, 0)));
  const w60Count = Math.max(0, Math.floor(toNumber(w60?.tradeCount, 0)));
  const minTrades5 = Math.max(1, Math.floor(toNumber(cfg.divergenceMinTrades5s, 3)));
  const minTrades60 = Math.max(minTrades5, Math.floor(toNumber(cfg.divergenceMinTrades60s, 15)));
  const shortStrongTh = clamp(toNumber(cfg.divergenceShortStrength, 0.3), 0.05, 0.95);
  const fp5 = toNumber(w5?.ofi, toNumber(w5?.flowPressure, 0));
  const fp60 = toNumber(w60?.ofi, toNumber(w60?.flowPressure, 0));

  return {
    available: true,
    mode,
    windowMs,
    minTrades,
    tradeCount,
    flowPressure,
    normalizedFlowPressure,
    source: bucket ? 'window' : 'default',
    thresholds: {
      hostileThresholdLong,
      hostileThresholdShort,
      alignedThresholdLong,
      alignedThresholdShort,
      minTrades5,
      minTrades60,
      shortStrongTh
    },
    divergence: {
      flowPressure5s: fp5,
      flowPressure60s: fp60,
      trades5s: w5Count,
      trades60s: w60Count
    }
  };
}
