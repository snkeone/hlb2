/**
 * ws/normalize/common.js
 * Common helper functions for Normalize layer
 * - Pure functions, no global state
 * - Field validation and type conversion
 */

'use strict';

/**
 * toNumberSafe(value)
 * Convert value to number safely
 * @param {any} value - Input value
 * @returns {number|null} - Converted number or null if invalid
 */
export function toNumberSafe(value) {
  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }
  if (typeof value === 'string') {
    // Reject empty string (would convert to 0)
    if (value === '') return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }
  // Reject boolean (explicit non-support)
  if (typeof value === 'boolean') return null;
  return null;
}

/**
 * normalizeSide(rawSide)
 * Normalize trade side to standard format
 * @param {string} rawSide - Raw side value ("B", "S", "buy", "sell", etc)
 * @returns {string} - "buy", "sell", or "unknown"
 */
export function normalizeSide(rawSide) {
  if (!rawSide) return 'unknown';
  const side = String(rawSide).trim().toUpperCase();
  if (side === 'B' || side === 'BUY') return 'buy';
  // Hyperliquid trades channel は売り側を A で返す
  if (side === 'S' || side === 'SELL' || side === 'A' || side === 'ASK') return 'sell';
  return 'unknown';
}

/**
 * requireFields(obj, keys)
 * Check if all required keys exist in object
 * @param {object} obj - Object to check
 * @param {string[]} keys - Required keys
 * @returns {boolean} - True if all keys exist
 */
export function requireFields(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;
  for (const key of keys) {
    if (!(key in obj)) return false;
  }
  return true;
}

/**
 * buildCommonHeader(raw)
 * Extract common fields from raw event
 * @param {object} raw - Raw event from WS
 * @returns {object|null} - Common header or null if critical fields missing
 */
export function buildCommonHeader(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Extract coin (3-level fallback: data.data.coin -> data.coin -> coin)
  let coin = raw?.data?.data?.coin ?? raw?.data?.coin ?? raw?.coin ?? null;
  if (!coin && Array.isArray(raw?.data?.data) && raw.data.data.length > 0) {
    coin = raw.data.data[0]?.coin ?? null;
  }
  if (!coin && Array.isArray(raw?.data) && raw.data.length > 0) {
    coin = raw.data[0]?.coin ?? null;
  }

  // Extract timestamp (raw.ts or data.time)
  let ts = raw.ts;
  if (!ts && raw.data && raw.data.time) {
    ts = raw.data.time;
  }
  if (!ts && Array.isArray(raw?.data?.data) && raw.data.data.length > 0) {
    ts = raw.data.data[0]?.time;
  }
  if (!ts && Array.isArray(raw?.data) && raw.data.length > 0) {
    ts = raw.data[0]?.time;
  }

  // Critical validation
  if (!coin || !ts) return null;
  if (typeof ts !== 'number' || isNaN(ts)) return null;

  return {
    coin: String(coin),
    ts,
    source: raw.channel || 'unknown'
  };
}

