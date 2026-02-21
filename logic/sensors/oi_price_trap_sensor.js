import { collectLiquidationPressureSensor } from './liquidation_pressure_sensor.js';

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function collectOiPriceTrapSensor(payload = {}, tradeConfig = {}) {
  const cfg = tradeConfig?.oiPriceTrapGate ?? {};
  const ioMetrics = payload?.ioMetrics ?? {};
  const flow = ioMetrics?.tradeFlow;

  if (!flow || typeof flow !== 'object') {
    return {
      available: false,
      reason: 'no_trade_flow'
    };
  }

  const pressure = collectLiquidationPressureSensor(payload, tradeConfig);
  const midPx = toNumber(pressure?.inputs?.midPx, 0);
  const priceDeltaUsd = toNumber(pressure?.inputs?.priceDeltaUsd, NaN);
  const priceDeltaBps = toNumber(pressure?.outputs?.priceDeltaBps, NaN);
  const oi = toNumber(pressure?.inputs?.oi, NaN);
  const oiDelta = toNumber(pressure?.inputs?.oiDelta, NaN);
  const flowPressure = toNumber(pressure?.inputs?.flowPressure, 0);
  const tradeCount = Math.max(0, Math.floor(toNumber(flow?.tradeCount, 0)));
  const minTrades = Math.max(1, Math.floor(toNumber(cfg.minTrades, toNumber(flow?.minTradesForSignal, 8))));
  const minPriceDeltaBps = Math.max(0.05, toNumber(cfg.minPriceDeltaBps, 0.25));
  const minOiDeltaRatio = Math.max(0, toNumber(cfg.minOiDeltaRatio, 0.00005));
  const minAdverseFlowPressure = toNumber(pressure?.outputs?.minAdverseFlowPressure, null);
  const absPriceDeltaBps = toNumber(pressure?.outputs?.absPriceDeltaBps, 0);
  const oiDeltaRatio = toNumber(pressure?.outputs?.oiDeltaRatio, 0);
  const normalizedFlowPressure = toNumber(pressure?.normalized?.normalizedFlowPressure, null);
  const moveType = pressure?.outputs?.moveType ?? 'long_liquidation';

  return {
    available: true,
    midPx,
    priceDeltaUsd,
    priceDeltaBps,
    absPriceDeltaBps,
    oi,
    oiDelta,
    oiDeltaRatio,
    flowPressure,
    normalizedFlowPressure,
    tradeCount,
    minTrades,
    minPriceDeltaBps,
    minOiDeltaRatio,
    minAdverseFlowPressure,
    moveType
  };
}
