

/**
 * ws/normalize/mid.js
 * Normalize mid (ticker) events
 * - Extract best bid/ask and midPx
 * - Calculate spread and spreadBps
 */


import { toNumberSafe, buildCommonHeader } from './common.js';

/**
 * normalizeMid(raw)
 * Normalize mid/ticker event to standard format
 * @param {object} raw - Raw event from WS (channel: "mid" or "ticker")
 * @returns {object|null} - Normalized mid event or null if invalid
 */
export function normalizeMid(raw) {
  // Build common header
  const header = buildCommonHeader(raw);
  if (!header) return null;

  // Extract ticker data
  const data = raw.data && raw.data.data;
  if (!data || typeof data !== 'object') return null;

  // Extract and convert required fields
  const bestBidPx = toNumberSafe(data.bestBid);
  const bestAskPx = toNumberSafe(data.bestAsk);
  const midPx = toNumberSafe(data.mid);

  // Validate required fields
  if (bestBidPx === null || bestAskPx === null || midPx === null) return null;

  // Calculate derived fields
  const spread = bestAskPx - bestBidPx;
  const spreadBps = midPx > 0 ? (spread / midPx * 10000) : null;

  return {
    channel: 'mid',
    coin: header.coin,
    ts: header.ts,
    source: header.source,
    bestBidPx,
    bestAskPx,
    midPx,
    spread,
    spreadBps
  };
}


