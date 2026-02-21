function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function collectCtxSizeSensor(market = {}, decidedSide = 'none', tradeConfig = {}) {
  const cfg = tradeConfig?.wsAdaptive?.sizeScalars?.ctx ?? {};
  const funding = toNumber(market?.funding);
  const premiumRaw = toNumber(market?.premium);
  const oraclePx = toNumber(market?.oraclePx);
  const markPx = toNumber(market?.markPx);
  const premium = Number.isFinite(premiumRaw)
    ? premiumRaw
    : (Number.isFinite(oraclePx) && oraclePx > 0 && Number.isFinite(markPx))
      ? ((markPx - oraclePx) / oraclePx)
      : null;

  const hostileFundingLong = Math.max(0, toNumber(cfg.hostileFundingLong, 0.0003));
  const hostileFundingShort = Math.max(0, toNumber(cfg.hostileFundingShort, 0.0003));
  const hostilePremiumLong = Math.max(0, toNumber(cfg.hostilePremiumLong, 0.0005));
  const hostilePremiumShort = Math.max(0, toNumber(cfg.hostilePremiumShort, 0.0005));
  const favorableFunding = Math.max(0, toNumber(cfg.favorableFunding, 0.00015));
  const favorablePremium = Math.max(0, toNumber(cfg.favorablePremium, 0.00025));

  let hostileScore = 0;
  let favorableScore = 0;
  if (decidedSide === 'buy') {
    if (Number.isFinite(funding) && hostileFundingLong > 0) hostileScore += Math.max(0, funding / hostileFundingLong);
    if (Number.isFinite(premium) && hostilePremiumLong > 0) hostileScore += Math.max(0, premium / hostilePremiumLong);
    if (Number.isFinite(funding) && favorableFunding > 0) favorableScore += Math.max(0, (-funding) / favorableFunding);
    if (Number.isFinite(premium) && favorablePremium > 0) favorableScore += Math.max(0, (-premium) / favorablePremium);
  } else if (decidedSide === 'sell') {
    if (Number.isFinite(funding) && hostileFundingShort > 0) hostileScore += Math.max(0, (-funding) / hostileFundingShort);
    if (Number.isFinite(premium) && hostilePremiumShort > 0) hostileScore += Math.max(0, (-premium) / hostilePremiumShort);
    if (Number.isFinite(funding) && favorableFunding > 0) favorableScore += Math.max(0, funding / favorableFunding);
    if (Number.isFinite(premium) && favorablePremium > 0) favorableScore += Math.max(0, premium / favorablePremium);
  }

  return {
    ok: true,
    code: 'ok',
    inputs: {
      funding: Number.isFinite(funding) ? funding : null,
      premium: Number.isFinite(premium) ? premium : null,
      decidedSide: decidedSide === 'buy' || decidedSide === 'sell' ? decidedSide : 'none'
    },
    outputs: {
      hostileScore,
      favorableScore,
      hostileFundingLong,
      hostileFundingShort,
      hostilePremiumLong,
      hostilePremiumShort,
      favorableFunding,
      favorablePremium
    },
    normalized: {
      hostileScoreNorm: clamp(hostileScore / 4, 0, 1),
      favorableScoreNorm: clamp(favorableScore / 4, 0, 1)
    },
    meta: {
      sensorId: 'ctx_size',
      version: '2026-02-19',
      source: 'market'
    }
  };
}
