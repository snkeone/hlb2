// RISK_ALLOCATION: 注文サイズのUSDノーション上限を安全に適用するための補助モジュール
// デフォルトでは無効（ctx.riskAllocation?.enabled !== true の場合は何もしない）

function toNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * @typedef {Object} RiskAllocationConfig
 * @property {boolean} enabled
 * @property {number} [maxPerTradeUsd] // 1トレードあたりのUSDノーション上限
 */

/**
 * @param {any} order { side, size, price, symbol, ... }
 * @param {any} ctx { riskAllocation?: RiskAllocationConfig }
 * @returns {{ order: any, changed: boolean, reason?: string }} 変更があれば changed=true
 */
function applyRiskAllocation(order, ctx = {}) {
  const ra = ctx && ctx.riskAllocation ? ctx.riskAllocation : undefined;
  if (!ra || ra.enabled !== true) {
    return { order, changed: false };
  }

  const price = toNumber(order && order.price);
  const size = toNumber(order && order.size);
  const maxPerTradeUsd = toNumber(ra.maxPerTradeUsd);

  if (
    price === undefined ||
    size === undefined ||
    price <= 0 ||
    !maxPerTradeUsd ||
    maxPerTradeUsd <= 0
  ) {
    // 無効な設定・価格の場合は何もしない（安全のため）
    return { order, changed: false };
  }

  const notional = size * price;
  if (notional <= maxPerTradeUsd) {
    return { order, changed: false };
  }

  const clampedSize = maxPerTradeUsd / price;
  if (!Number.isFinite(clampedSize) || clampedSize <= 0) {
    return { order, changed: false };
  }
  const newOrder = { ...order, size: clampedSize };
  return { order: newOrder, changed: true, reason: 'per_trade_usd_cap' };
}

export { applyRiskAllocation };
