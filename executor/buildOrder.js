// 変換のみ：ExecutorPayload -> Hyperliquid注文構造体
// 新しい判定や計算は禁止。I/Oが決めた値をそのまま詰め替え。

/**
 * ExecutorPayload 例（io/types.ts 準拠想定）
 * {
 *   side: 'buy'|'sell',
 *   size: number,
 *   price: number | undefined, // 指値補正がある場合のみ
 *   market: { bid: number, ask: number, mid: number, coin: string },
 *   leverage: number | undefined,
 *   strength: 'A'|'B',
 *   timestamp: number,
 *   meta?: any
 * }
 */

/**
 * Hyperliquid注文構造体（sendOrderがそのままPOSTできる形）
 * {
 *   symbol: string,
 *   side: 'buy'|'sell',
 *   size: number,
 *   price: number, // 指値
 *   type: 'limit',
 *   leverage: number | undefined,
 *   clientOrderId: string,
 *   ts: number
 * }
 */

import { v4 as uuidv4 } from 'uuid';

function toNumberSafe(n) {
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  if (typeof n === 'string' && n.trim() !== '') {
    const v = Number(n);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

function resolveMarketPrice(market, keys) {
  if (!market || typeof market !== 'object') return undefined;
  for (const key of keys) {
    const v = toNumberSafe(market[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * @param {any} payload ExecutorPayload（I/O決定済み）
 * @param {any} ctx 実行コンテキスト（mode等）
 * @returns {any} hyperliquidOrder
 */
function buildOrder(payload, ctx) {
  // 必須フィールドの存在確認（Safety Halt トリガー用に index 側で再検証もする）
  const side = payload && payload.side;
  const size = toNumberSafe(payload && payload.size);
  const market = payload && payload.market;
  const symbol = market && market.coin;

  // 価格は payload.price があればそれを優先、なければ market.mid を利用
  const px = toNumberSafe(payload && payload.price);
  const mid = resolveMarketPrice(market, ['mid', 'midPx']);
  const bid = resolveMarketPrice(market, ['bid', 'bestBid', 'bestBidPx']);
  const ask = resolveMarketPrice(market, ['ask', 'bestAsk', 'bestAskPx']);

  const leverage = toNumberSafe(payload && payload.leverage);
  // decisionId → orderId (clientOrderId) を1:1に固定
  // 決定IDが与えられていればそれを優先して安定IDを生成。無ければ従来のランダム形式。
  const decisionId = payload && typeof payload.decisionId === 'string' && payload.decisionId.trim().length > 0
    ? payload.decisionId.trim()
    : null;
  const safeDecisionId = decisionId
    ? decisionId.replace(/[^a-zA-Z0-9:_\-]/g, '_').slice(0, 120)
    : null;
  const clientOrderId = safeDecisionId ? `DEC-${safeDecisionId}` : `${Date.now()}-${uuidv4()}`;

  const entryProfile = payload && payload.entryProfile ? payload.entryProfile : null;
  const modeRaw = entryProfile && typeof entryProfile.mode === 'string' ? entryProfile.mode.toLowerCase() : null;
  const tif = modeRaw === 'maker' ? 'Alo' : (modeRaw === 'taker' ? 'Ioc' : 'Gtc');
  const orderType = { limit: { tif } };
  let adaptivePrice = mid;
  if (modeRaw === 'maker') {
    adaptivePrice = side === 'buy' ? (bid !== undefined ? bid : mid) : (ask !== undefined ? ask : mid);
  } else if (modeRaw === 'taker') {
    adaptivePrice = side === 'buy' ? (ask !== undefined ? ask : mid) : (bid !== undefined ? bid : mid);
  }
  const priceCandidate = px !== undefined ? px : adaptivePrice;
  const price = Number.isFinite(priceCandidate) ? priceCandidate : (Number.isFinite(mid) ? mid : undefined);

  return {
    symbol,
    side,
    size,
    price,
    type: 'limit',
    orderType,
    leverage: leverage !== undefined ? leverage : undefined,
    clientOrderId,
    ts: payload && payload.timestamp ? Number(payload.timestamp) : Date.now(),
    strength: payload && payload.strength ? payload.strength : undefined,
    intent: payload && payload.intent ? payload.intent : undefined,
    meta: payload && payload.meta ? payload.meta : undefined,
    entryProfile: entryProfile || undefined,
    pricePolicy: modeRaw || 'default',
  };
}

export { buildOrder };
