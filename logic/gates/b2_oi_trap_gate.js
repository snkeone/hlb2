import { collectOiPriceTrapSensor } from '../sensors/oi_price_trap_sensor.js';

export function evaluateOiTrapGate(payload, tradeConfig, decidedSide) {
  const cfg = tradeConfig?.oiPriceTrapGate ?? {};
  if (cfg.enabled !== true) {
    return { blocked: false, reason: null, diagnostics: null };
  }
  const oiTrapSignals = collectOiPriceTrapSensor(payload, tradeConfig);
  if (oiTrapSignals?.available !== true) {
    return {
      blocked: false,
      reason: null,
      diagnostics: { enabled: true, active: false, reason: 'no_trade_flow' }
    };
  }
  const midPx = oiTrapSignals.midPx;
  const priceDeltaUsd = oiTrapSignals.priceDeltaUsd;
  const priceDeltaBps = oiTrapSignals.priceDeltaBps;
  const oi = oiTrapSignals.oi;
  const oiDelta = oiTrapSignals.oiDelta;
  const flowPressure = oiTrapSignals.flowPressure;
  const tradeCount = oiTrapSignals.tradeCount;
  const minTrades = oiTrapSignals.minTrades;
  const minPriceDeltaBps = oiTrapSignals.minPriceDeltaBps;
  const minOiDeltaRatio = oiTrapSignals.minOiDeltaRatio;
  const minAdverseFlowPressure = oiTrapSignals.minAdverseFlowPressure;
  const absPriceDeltaBps = oiTrapSignals.absPriceDeltaBps;
  const oiDeltaRatio = oiTrapSignals.oiDeltaRatio;
  const diagnostics = {
    enabled: true,
    active: true,
    midPx,
    priceDeltaUsd,
    priceDeltaBps,
    oi,
    oiDelta,
    oiDeltaRatio,
    flowPressure,
    normalizedFlowPressure: oiTrapSignals.normalizedFlowPressure,
    tradeCount,
    minTrades,
    minPriceDeltaBps,
    minOiDeltaRatio,
    minAdverseFlowPressure
  };
  if (tradeCount < minTrades) {
    return {
      blocked: false,
      reason: null,
      diagnostics: { ...diagnostics, active: false, reason: 'insufficient_sample' }
    };
  }
  if (!Number.isFinite(priceDeltaBps) || !Number.isFinite(oiDelta)) {
    return {
      blocked: false,
      reason: null,
      diagnostics: { ...diagnostics, active: false, reason: 'missing_price_or_oi_delta' }
    };
  }
  if (absPriceDeltaBps < minPriceDeltaBps || oiDeltaRatio < minOiDeltaRatio) {
    return {
      blocked: false,
      reason: null,
      diagnostics: { ...diagnostics, active: false, reason: 'below_signal_threshold' }
    };
  }
  const moveType = oiTrapSignals.moveType;
  const hostileFlowForLong = flowPressure <= (-minAdverseFlowPressure);
  const hostileFlowForShort = flowPressure >= minAdverseFlowPressure;
  if (decidedSide === 'buy' && moveType === 'new_short' && hostileFlowForLong) {
    return {
      blocked: true,
      reason: 'B: oi-price trap for long',
      diagnostics: {
        ...diagnostics,
        moveType,
        trapFor: 'buy'
      }
    };
  }
  if (decidedSide === 'sell' && moveType === 'new_long' && hostileFlowForShort) {
    return {
      blocked: true,
      reason: 'B: oi-price trap for short',
      diagnostics: {
        ...diagnostics,
        moveType,
        trapFor: 'sell'
      }
    };
  }
  return {
    blocked: false,
    reason: null,
    diagnostics: {
      ...diagnostics,
      moveType
    }
  };
}