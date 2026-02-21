function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function collectPremiumSensor(market = {}) {
  const midPx = toNumber(market?.midPx);
  const fundingRate = toNumber(market?.funding);
  const premiumRaw = toNumber(market?.premium);
  const oraclePx = toNumber(market?.oraclePx);
  const markPx = toNumber(market?.markPx);
  const impactBidPx = toNumber(market?.impactBidPx);
  const impactAskPx = toNumber(market?.impactAskPx);

  const premiumFromPxRate = Number.isFinite(oraclePx) && oraclePx > 0 && Number.isFinite(markPx)
    ? ((markPx - oraclePx) / oraclePx)
    : null;
  const premiumRate = Number.isFinite(premiumRaw) ? premiumRaw : premiumFromPxRate;
  const premiumBps = Number.isFinite(premiumRate) ? premiumRate * 10000 : null;
  const impactSpreadBps = Number.isFinite(midPx) && midPx > 0 && Number.isFinite(impactBidPx) && Number.isFinite(impactAskPx)
    ? ((impactAskPx - impactBidPx) / midPx) * 10000
    : null;
  const normalizedPremium = Number.isFinite(premiumBps)
    ? clamp(premiumBps / 100, -1, 1)
    : null;

  return {
    premiumBps,
    fundingRate,
    impactSpreadBps,
    normalizedPremium
  };
}
