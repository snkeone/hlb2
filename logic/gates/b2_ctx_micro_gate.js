import { collectPremiumSensor } from '../sensors/premium_sensor.js';

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function evaluateCtxMicroGate(market, tradeConfig, decidedSide) {
  const cfg = tradeConfig?.ctxMicroGate ?? {};
  if (cfg.enabled !== true) {
    return { blocked: false, reason: null, diagnostics: null };
  }
  const premiumSignals = collectPremiumSensor(market);
  const funding = premiumSignals.fundingRate;
  const premium = Number.isFinite(premiumSignals.premiumBps) ? premiumSignals.premiumBps / 10000 : null;
  const impactSpreadBps = premiumSignals.impactSpreadBps;
  const oraclePx = toNumber(market?.oraclePx);
  const markPx = toNumber(market?.markPx);
  const impactBidPx = toNumber(market?.impactBidPx);
  const impactAskPx = toNumber(market?.impactAskPx);
  const diagnostics = {
    enabled: true,
    funding,
    premium,
    premiumBps: premiumSignals.premiumBps,
    normalizedPremium: premiumSignals.normalizedPremium,
    impactSpreadBps,
    oraclePx,
    markPx,
    impactBidPx,
    impactAskPx
  };
  const hostileFundingLong = Math.max(0, toNumber(cfg.hostileFundingLong, 0.0003));
  const hostileFundingShort = Math.max(0, toNumber(cfg.hostileFundingShort, 0.0003));
  const hostilePremiumLong = Math.max(0, toNumber(cfg.hostilePremiumLong, 0.0005));
  const hostilePremiumShort = Math.max(0, toNumber(cfg.hostilePremiumShort, 0.0005));
  const maxImpactSpreadBps = Math.max(0.1, toNumber(cfg.maxImpactSpreadBps, 3.0));

  if (Number.isFinite(impactSpreadBps) && impactSpreadBps > maxImpactSpreadBps) {
    return {
      blocked: true,
      reason: 'B: impact spread too wide',
      diagnostics: { ...diagnostics, guard: 'impact_spread', threshold: maxImpactSpreadBps }
    };
  }
  if (decidedSide === 'buy') {
    if (Number.isFinite(funding) && funding >= hostileFundingLong) {
      return {
        blocked: true,
        reason: 'B: funding hostile for long',
        diagnostics: { ...diagnostics, guard: 'funding', threshold: hostileFundingLong }
      };
    }
    if (Number.isFinite(premium) && premium >= hostilePremiumLong) {
      return {
        blocked: true,
        reason: 'B: premium hostile for long',
        diagnostics: { ...diagnostics, guard: 'premium', threshold: hostilePremiumLong }
      };
    }
  }
  if (decidedSide === 'sell') {
    if (Number.isFinite(funding) && funding <= (-hostileFundingShort)) {
      return {
        blocked: true,
        reason: 'B: funding hostile for short',
        diagnostics: { ...diagnostics, guard: 'funding', threshold: -hostileFundingShort }
      };
    }
    if (Number.isFinite(premium) && premium <= (-hostilePremiumShort)) {
      return {
        blocked: true,
        reason: 'B: premium hostile for short',
        diagnostics: { ...diagnostics, guard: 'premium', threshold: -hostilePremiumShort }
      };
    }
  }
  return {
    blocked: false,
    reason: null,
    diagnostics: {
      ...diagnostics,
      thresholds: {
        hostileFundingLong,
        hostileFundingShort,
        hostilePremiumLong,
        hostilePremiumShort,
        maxImpactSpreadBps
      }
    }
  };
}