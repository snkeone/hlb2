function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function collectLiquidationPressureSensor(payload = {}, tradeConfig = {}) {
  const cfg = tradeConfig?.oiPriceTrapGate ?? {};
  const ioMetrics = payload?.ioMetrics ?? {};
  const flow = ioMetrics?.tradeFlow;
  if (!flow || typeof flow !== 'object') {
    return {
      ok: false,
      code: 'no_trade_flow',
      inputs: {},
      outputs: {},
      normalized: {},
      meta: {
        sensorId: 'liquidation_pressure',
        version: '2026-02-19',
        source: 'ioMetrics'
      }
    };
  }

  const midPx = toNumber(payload?.market?.midPx, 0);
  const priceDeltaUsd = toNumber(ioMetrics?.diffs?.midPx, NaN);
  const priceDeltaBps = Number.isFinite(priceDeltaUsd) && midPx > 0
    ? (priceDeltaUsd / midPx) * 10000
    : NaN;
  const oi = toNumber(flow?.oi, NaN);
  const oiDelta = toNumber(flow?.oiDelta, NaN);
  const flowPressure = toNumber(flow?.flowPressure, 0);
  const absPriceDeltaBps = Math.abs(toNumber(priceDeltaBps, 0));
  const oiDeltaRatio = Number.isFinite(oi) && Math.abs(oi) > 0
    ? Math.abs(toNumber(oiDelta, 0)) / Math.abs(oi)
    : 0;
  const minAdverseFlowPressure = clamp(toNumber(cfg.minAdverseFlowPressure, 0.12), 0.01, 0.95);
  const normalizedFlowPressure = Number.isFinite(flowPressure) ? clamp(flowPressure, -1, 1) : null;

  const priceUp = Number.isFinite(priceDeltaBps) ? priceDeltaBps > 0 : false;
  const oiUp = Number.isFinite(oiDelta) ? oiDelta > 0 : false;
  const moveType = priceUp && oiUp
    ? 'new_long'
    : (!priceUp && oiUp)
      ? 'new_short'
      : (priceUp && !oiUp)
        ? 'short_cover'
        : 'long_liquidation';

  return {
    ok: true,
    code: 'ok',
    inputs: {
      midPx: Number.isFinite(midPx) ? midPx : null,
      priceDeltaUsd: Number.isFinite(priceDeltaUsd) ? priceDeltaUsd : null,
      oi: Number.isFinite(oi) ? oi : null,
      oiDelta: Number.isFinite(oiDelta) ? oiDelta : null,
      flowPressure: Number.isFinite(flowPressure) ? flowPressure : null
    },
    outputs: {
      priceDeltaBps: Number.isFinite(priceDeltaBps) ? priceDeltaBps : null,
      absPriceDeltaBps,
      oiDeltaRatio,
      moveType,
      minAdverseFlowPressure
    },
    normalized: {
      normalizedFlowPressure
    },
    meta: {
      sensorId: 'liquidation_pressure',
      version: '2026-02-19',
      source: 'mixed'
    }
  };
}
