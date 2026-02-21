function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function collectImpactSpreadSensor(market = {}, tradeConfig = {}) {
  const cfg = tradeConfig?.wsAdaptive?.sizeScalars?.impact ?? {};
  const midPx = toNumber(market?.midPx);
  const impactBidPx = toNumber(market?.impactBidPx);
  const impactAskPx = toNumber(market?.impactAskPx);

  if (!Number.isFinite(midPx) || midPx <= 0 || !Number.isFinite(impactBidPx) || !Number.isFinite(impactAskPx)) {
    return {
      ok: false,
      code: 'no_impact_prices',
      inputs: {
        midPx: Number.isFinite(midPx) ? midPx : null,
        impactBidPx: Number.isFinite(impactBidPx) ? impactBidPx : null,
        impactAskPx: Number.isFinite(impactAskPx) ? impactAskPx : null
      },
      outputs: {},
      normalized: {},
      meta: {
        sensorId: 'impact_spread',
        version: '2026-02-19',
        source: 'market'
      }
    };
  }

  const impactSpreadBps = ((impactAskPx - impactBidPx) / midPx) * 10000;
  const goodSpreadBps = Math.max(0.05, toNumber(cfg.goodSpreadBps, 1.2));
  const badSpreadBps = Math.max(goodSpreadBps, toNumber(cfg.badSpreadBps, 4.0));
  const minScalar = 1.0;
  const maxBoost = clamp(toNumber(cfg.maxBoost, 1.03), 1.0, 1.2);
  const spreadPosition01 = clamp(
    (impactSpreadBps - goodSpreadBps) / Math.max(1e-6, badSpreadBps - goodSpreadBps),
    0,
    1
  );

  return {
    ok: true,
    code: 'ok',
    inputs: {
      midPx,
      impactBidPx,
      impactAskPx
    },
    outputs: {
      impactSpreadBps,
      goodSpreadBps,
      badSpreadBps,
      minScalar,
      maxBoost
    },
    normalized: {
      spreadPosition01
    },
    meta: {
      sensorId: 'impact_spread',
      version: '2026-02-19',
      source: 'market'
    }
  };
}
