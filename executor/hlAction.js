function toNumberSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTif(order) {
  const tif = order?.orderType?.limit?.tif;
  if (tif === 'Alo' || tif === 'Ioc' || tif === 'Gtc') return tif;
  return 'Gtc';
}

function resolveSplitCount(order) {
  if (order?.intent === 'exit') return 1;
  const aggressiveness = typeof order?.entryProfile?.aggressiveness === 'string'
    ? order.entryProfile.aggressiveness.toLowerCase()
    : null;
  if (aggressiveness === 'low') return 3;
  if (aggressiveness === 'normal') return 2;
  return 1;
}

function splitSizes(totalSize, count) {
  const total = toNumberSafe(totalSize);
  if (!Number.isFinite(total) || total <= 0) return [];
  const safeCount = Math.max(1, Math.min(5, Math.floor(toNumberSafe(count) || 1)));
  if (safeCount === 1) return [total];
  const unitRaw = total / safeCount;
  const unit = Math.max(0, Number(unitRaw.toFixed(8)));
  const sizes = [];
  let used = 0;
  for (let i = 0; i < safeCount - 1; i++) {
    sizes.push(unit);
    used += unit;
  }
  const remainder = Math.max(0, Number((total - used).toFixed(8)));
  if (remainder > 0) sizes.push(remainder);
  return sizes.length > 0 ? sizes : [total];
}

export function buildHlOrderAction(order, coin) {
  const tif = normalizeTif(order);
  const splitCount = resolveSplitCount(order);
  const sizes = splitSizes(order?.size, splitCount);
  const isExit = order?.intent === 'exit';
  const orders = sizes.map((size) => ({
    asset: coin,
    isBuy: order?.side === 'buy',
    limitPx: String(order?.price),
    sz: String(size),
    reduceOnly: isExit,
    orderType: { limit: { tif } },
  }));
  return {
    action: {
      type: 'order',
      orders,
      grouping: 'na',
    },
    meta: {
      splitCount: orders.length,
      tif,
      reduceOnly: isExit
    }
  };
}
