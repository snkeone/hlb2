

/**
 * ws/normalize/trades.js
 * Normalize trades events
 * - Extract px, sz, side
 * - Calculate notional value
 * - Normalize side to "buy"/"sell"/"unknown"
 */


import { toNumberSafe, normalizeSide, buildCommonHeader } from './common.js';

/**
 * normalizeTrades(raw)
 * Normalize trades event to standard format
 * @param {object} raw - Raw event from WS (channel: "trades")
 * @returns {object|null} - Normalized trade event or null if invalid
 */
export function normalizeTrades(raw) {
  // Build common header
  const header = buildCommonHeader(raw);
  if (!header) return null;

  // Extract trade data
  let data = raw.data && raw.data.data;
  
  // ← #6修正: 配列の場合は全件を処理（最初の1件のみではなく）
  if (Array.isArray(data)) {
    // 配列の全件を正規化
    return data
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        
        const px = toNumberSafe(item.px);
        const sz = toNumberSafe(item.sz);
        
        if (px === null || sz === null) return null;
        
        const side = normalizeSide(item.side);
        const notional = px * sz;
        
        return {
          channel: 'trades',
          coin: header.coin,
          ts: header.ts,
          source: header.source,
          px,
          sz,
          side,
          notional
        };
      })
      .filter(t => t !== null);
  }
  
  // 単一オブジェクト（配列ではない）の場合
  if (!data || typeof data !== 'object') return null;

  const px = toNumberSafe(data.px);
  const sz = toNumberSafe(data.sz);

  if (px === null || sz === null) return null;

  const side = normalizeSide(data.side);
  const notional = px * sz;

  return {
    channel: 'trades',
    coin: header.coin,
    ts: header.ts,
    source: header.source,
    px,
    sz,
    side,
    notional
  };
}

