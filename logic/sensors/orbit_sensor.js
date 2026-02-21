import { computeLrcWsOrbit } from '../lrc_ws_orbit.js';

export function collectOrbitSensor(payload = {}, regime = 'NONE', side = 'none', executionSignals = {}, tradeConfig = {}) {
  const orbit = computeLrcWsOrbit(payload, regime, side, executionSignals, tradeConfig);
  return {
    ok: orbit?.enabled !== undefined,
    code: orbit?.enabled === false ? 'disabled_or_unavailable' : 'ok',
    inputs: {
      regime: String(regime ?? 'NONE'),
      side: String(side ?? 'none')
    },
    outputs: {
      score: Number.isFinite(Number(orbit?.score)) ? Number(orbit.score) : 0,
      edgeRatioMul: Number.isFinite(Number(orbit?.edgeRatioMul)) ? Number(orbit.edgeRatioMul) : 1,
      sizeScalarMul: Number.isFinite(Number(orbit?.sizeScalarMul)) ? Number(orbit.sizeScalarMul) : 1,
      tpStretchMul: Number.isFinite(Number(orbit?.tpStretchMul)) ? Number(orbit.tpStretchMul) : 1,
      forceMaker: orbit?.forceMaker === true
    },
    normalized: {
      scoreNorm: Number.isFinite(Number(orbit?.score)) ? Number(orbit.score) : 0
    },
    meta: {
      sensorId: 'orbit',
      version: '2026-02-19',
      source: 'mixed'
    },
    diagnostics: orbit?.diagnostics ?? null
  };
}
