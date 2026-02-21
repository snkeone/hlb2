/**
 * ws/normalize/orderbook.js
 * Normalize l2Book (orderbook) events
 * - Extract best bid/ask from levels
 * - Calculate midPx, spread, spreadBps
 */


import { toNumberSafe, buildCommonHeader } from './common.js';

const DEPTH_LEVELS = 20;

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map(level => {
      const px = toNumberSafe(level?.px ?? level?.[0]);
      const sz = toNumberSafe(level?.sz ?? level?.[1]);
      if (px === null || sz === null) return null;
      return { px, sz };
    })
    .filter(Boolean)
    .slice(0, DEPTH_LEVELS);
}

/**
 * normalizeOrderbook(raw)
 * Normalize l2Book event to standard orderbook format
 * @param {object} raw - Raw event from WS (channel: "l2Book")
 * @returns {object|null} - Normalized orderbook event or null if invalid
 */
function normalizeOrderbook(raw) {
  // Build common header
  const header = buildCommonHeader(raw);
  if (!header) return null;

  // Extract levels - support both raw.data.data.levels and raw.data.levels
  let levels = undefined;
  if (raw.data && raw.data.data && raw.data.data.levels) {
    levels = raw.data.data.levels;
  } else if (raw.data && raw.data.levels) {
    levels = raw.data.levels;
  }
  if (!levels || typeof levels !== 'object') {
    return null;
  }
  
  // Handle Hyperliquid format: levels = [[{px, sz, n}, ...], [{px, sz, n}, ...]]
  if (Array.isArray(levels) && levels[0] && levels[1]) {
    const bids = levels[0];
    const asks = levels[1];
    
    const bestBid = bids[0];
    const bestAsk = asks[0];
    
    if (!bestBid || !bestAsk) return null;
    
    // Extract px and sz from Hyperliquid objects
    const bestBidPx = toNumberSafe(bestBid.px);
    const bestBidSz = toNumberSafe(bestBid.sz);
    const bestAskPx = toNumberSafe(bestAsk.px);
    const bestAskSz = toNumberSafe(bestAsk.sz);
    
    if (bestBidPx === null || bestBidSz === null || bestAskPx === null || bestAskSz === null) {
      return null;
    }
    
    const midPx = (bestBidPx + bestAskPx) / 2;
    const spread = bestAskPx - bestBidPx;
    const spreadBps = midPx > 0 ? (spread / midPx * 10000) : null;
    
    return {
      channel: 'orderbook',
      coin: header.coin,
      ts: header.ts,
      source: header.source,
      bestBidPx,
      bestBidSz,
      bestAskPx,
      bestAskSz,
      midPx,
      spread,
      spreadBps,
      bids: normalizeLevels(bids),
      asks: normalizeLevels(asks)
    };
  }

  // Fallback for {bids, asks} format
  const bids = levels.bids;
  const asks = levels.asks;

  if (!Array.isArray(bids) || bids.length === 0) return null;
  if (!Array.isArray(asks) || asks.length === 0) return null;

  const bestBid = bids[0];
  const bestAsk = asks[0];

  if (!Array.isArray(bestBid) || bestBid.length < 2) return null;
  if (!Array.isArray(bestAsk) || bestAsk.length < 2) return null;

  if (bestBid[0] == null || bestBid[1] == null) return null;
  if (bestAsk[0] == null || bestAsk[1] == null) return null;

  const bestBidPx = toNumberSafe(bestBid[0]);
  const bestBidSz = toNumberSafe(bestBid[1]);
  const bestAskPx = toNumberSafe(bestAsk[0]);
  const bestAskSz = toNumberSafe(bestAsk[1]);

  if (bestBidPx === null || bestBidSz === null) return null;
  if (bestAskPx === null || bestAskSz === null) return null;

  const midPx = (bestBidPx + bestAskPx) / 2;
  const spread = bestAskPx - bestBidPx;
  const spreadBps = midPx > 0 ? (spread / midPx * 10000) : null;

  return {
    channel: 'orderbook',
    coin: header.coin,
    ts: header.ts,
    source: header.source,
    bestBidPx,
    bestBidSz,
    bestAskPx,
    bestAskSz,
    midPx,
    spread,
    spreadBps,
    bids: normalizeLevels(bids),
    asks: normalizeLevels(asks)
  };
}

export { normalizeOrderbook };
