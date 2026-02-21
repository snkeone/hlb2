

/**
 * ws/normalize/ctx.js
 * Normalize activeAssetCtx events
 * - Extract market context data (oi, funding, premium, etc)
 * - Hard required fields: oi, funding, premium, oraclePx, markPx, midPx
 * - Soft補完 fields: impactPxs, prevDayPx, dayNtlVlm, dayBaseVlm
 */


import { toNumberSafe, buildCommonHeader } from './common.js';

/**
 * normalizeCtx(raw)
 * Normalize activeAssetCtx event to standard format
 * @param {object} raw - Raw event from WS (channel: "activeAssetCtx")
 * @returns {object|null} - Normalized context event or null if invalid
 */
export function normalizeCtx(raw) {
  // Build common header
  const header = buildCommonHeader(raw);
  if (!header) return null;

  // Extract ctx data (nested: data.data.ctx)
  const ctx = raw.data && raw.data.data && raw.data.data.ctx;
  if (!ctx || typeof ctx !== 'object') return null;

  // Extract and convert hard required fields
  const oi = toNumberSafe(ctx.openInterest);
  const funding = toNumberSafe(ctx.funding);
  const premium = toNumberSafe(ctx.premium);
  const oraclePx = toNumberSafe(ctx.oraclePx);
  const markPx = toNumberSafe(ctx.markPx);
  const midPx = toNumberSafe(ctx.midPx);

  // Validate hard required fields
  if (oi === null || funding === null || premium === null) return null;
  if (oraclePx === null || markPx === null || midPx === null) return null;

  // Soft補完 fields: impactPxs (array with 2 elements expected)
  let impactBidPx = null;
  let impactAskPx = null;
  if (Array.isArray(ctx.impactPxs)) {
    if (ctx.impactPxs.length > 0) {
      impactBidPx = toNumberSafe(ctx.impactPxs[0]);
    }
    if (ctx.impactPxs.length > 1) {
      impactAskPx = toNumberSafe(ctx.impactPxs[1]);
    }
  }

  // Soft補完 fields: prevDayPx, dayNtlVlm, dayBaseVlm (default to null if missing)
  const prevDayPx = toNumberSafe(ctx.prevDayPx);
  const dayNtlVlm = toNumberSafe(ctx.dayNtlVlm);
  const dayBaseVlm = toNumberSafe(ctx.dayBaseVlm);

  return {
    channel: 'ctx',
    coin: header.coin,
    ts: header.ts,
    source: header.source,
    oi,
    funding,
    premium,
    oraclePx,
    markPx,
    midPx,
    impactBidPx,
    impactAskPx,
    prevDayPx,
    dayNtlVlm,
    dayBaseVlm
  };
}


