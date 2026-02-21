// 結果の正規化：filled / expired / rejected / error に分類
// Live mode: ack/reject 判定 + Safety Halt 連動

import { HL_MAINNET } from './config.js';
import { triggerSafetyHalt } from './safetyHalt.js';
import { logOrderConfirmed, logOrderRejected } from './logger.js';
import { write as writeLog } from '../ws/utils/logger.js';

/**
 * @param {any} apiResponse sendOrder の結果
 * @param {any} ctx 実行コンテキスト
 * @returns {import('./types').OrderResult}
 */
function confirmOrder(apiResponse, ctx) {
  const now = Date.now();
  const mode = (ctx && ctx.mode) || 'test';
  const coin = ctx?.market?.coin || 'BTC';

  if (!apiResponse || apiResponse.ok !== true) {
    const errMsg = apiResponse && apiResponse.error && apiResponse.error.message ? apiResponse.error.message : 'executor send error';
    const errCode = apiResponse && apiResponse.error && apiResponse.error.code;

    // Live mode: reject ログ
    if (mode === 'live') {
      const env = HL_MAINNET ? 'mainnet' : 'testnet';
      logOrderRejected({
        coin,
        side: ctx && ctx.lastOrder && ctx.lastOrder.side ? ctx.lastOrder.side : 'buy',
        px: ctx && ctx.lastOrder && typeof ctx.lastOrder.price === 'number' ? ctx.lastOrder.price : 0,
        sz: ctx && ctx.lastOrder && typeof ctx.lastOrder.size === 'number' ? ctx.lastOrder.size : 0,
        reason: errCode || 'send_error',
        detail: errMsg,
        env,
      });

      // Fatal reject の場合は Safety Halt
      // TODO: Step 7 E2E で実際の HL エラーコードを確認して判定条件を調整
      if (errCode === 'UNAUTHORIZED' || errCode === 'INVALID_SIGNATURE') {
        triggerSafetyHalt('hl_reject', `Fatal error: ${errMsg}`);
      }
    }

    return {
      orderId: '',
      status: 'error',
      side: ctx && ctx.lastOrder && ctx.lastOrder.side ? ctx.lastOrder.side : 'buy',
      price: ctx && ctx.lastOrder && typeof ctx.lastOrder.price === 'number' ? ctx.lastOrder.price : 0,
      size: ctx && ctx.lastOrder && typeof ctx.lastOrder.size === 'number' ? ctx.lastOrder.size : 0,
      timestamp: now,
      error: errMsg,
    };
  }

  const d = apiResponse.data || {};
  const status = mapStatus(d);

  // Live mode: ack (filled) or reject ログ
  if (mode === 'live') {
    const side = ctx && ctx.lastOrder && ctx.lastOrder.side ? ctx.lastOrder.side : 'buy';
    const px = typeof d.price === 'number' ? d.price : (ctx && ctx.lastOrder ? ctx.lastOrder.price : 0);
    const sz = typeof d.size === 'number' ? d.size : (ctx && ctx.lastOrder ? ctx.lastOrder.size : 0);
    const orderId = d.orderId || '';
    const env = HL_MAINNET ? 'mainnet' : 'testnet';

    if (status === 'filled') {
      logOrderConfirmed({ coin, side, px, sz, orderId, env });
      
      // decision_trace に exit情報を出力
      const entryTs = ctx?.entryTs ?? null;
      const exitTs = now;
      const holdingMs = entryTs && Number.isFinite(entryTs) ? Math.max(0, exitTs - entryTs) : null;
      const decisionId = ctx?.decisionId ?? 'unknown';
      const entryPrice = ctx && ctx.lastOrder ? ctx.lastOrder.price : null;
      const exitPrice = typeof d.price === 'number' ? d.price : null;
      const pnlUsd = entryPrice && exitPrice && Number.isFinite(entryPrice) && Number.isFinite(exitPrice)
        ? ((side === 'buy' ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) * (sz || 0))
        : null;
      const result = pnlUsd === null ? 'unknown' : (pnlUsd > 0 ? 'win' : pnlUsd < 0 ? 'loss' : 'breakeven');
      
      writeLog({
        type: 'decision_trace',
        payload: {
          decisionId,
          entryTs,
          exitTs,
          holdingMs,
          pnlUsd,
          result,
          side,
          entryPrice,
          exitPrice,
          appliedFirepowerRank: ctx?.appliedFirepowerRank ?? null,
          appliedFirepowerFactor: ctx?.appliedFirepowerFactor ?? null,
        }
      });
    } else if (status === 'rejected') {
      logOrderRejected({
        coin,
        side,
        px,
        sz,
        reason: 'hl_rejected',
        detail: d.rejectReason || 'unknown',
        env,
      });
      
      // HL reject 時の Safety Halt
      // TODO: Step 7 E2E で d.rejectReason の実際の値を確認、fatal のみ Safety Halt にする
      triggerSafetyHalt('hl_reject', `Order rejected by HL: ${d.rejectReason || 'unknown'}`);
    }
  }

  return {
    orderId: d.orderId || '',
    status,
    side: ctx && ctx.lastOrder && ctx.lastOrder.side ? ctx.lastOrder.side : 'buy',
    price: typeof d.price === 'number' ? d.price : (ctx && ctx.lastOrder ? ctx.lastOrder.price : 0),
    size: typeof d.size === 'number' ? d.size : (ctx && ctx.lastOrder ? ctx.lastOrder.size : 0),
    timestamp: typeof d.ts === 'number' ? d.ts : now,
    filledSize: typeof d.filledSize === 'number' ? d.filledSize : undefined,
    remainingSize: deriveRemainingSize(d, ctx, status),
    error: status === 'error' ? 'unexpected response' : undefined,
  };
}

function mapStatus(d) {
  // API 構造の例に基づく単純化したマッピング
  // filled 判定: d.filled === true or d.status === 'filled'
  if (d && (d.filled === true || d.status === 'filled')) return 'filled';
  // partial 判定: status=partial もしくは filledSize が size 未満で正数
  if (d && (d.status === 'partial' || (Number.isFinite(d.filledSize) && Number.isFinite(d.size) && d.filledSize > 0 && d.filledSize < d.size))) return 'partial';
  // expired 判定: d.status === 'expired' | 'canceled'
  if (d && (d.status === 'expired' || d.status === 'canceled')) return 'expired';
  // rejected 判定: d.status === 'rejected' | 'denied'
  if (d && (d.status === 'rejected' || d.status === 'denied')) return 'rejected';
  // その他は error とみなす
  return 'error';
}

function deriveRemainingSize(d, ctx, status) {
  if (status !== 'partial') return undefined;
  const total = typeof d.size === 'number'
    ? d.size
    : (ctx && ctx.lastOrder && typeof ctx.lastOrder.size === 'number' ? ctx.lastOrder.size : 0);
  const filled = typeof d.filledSize === 'number' ? d.filledSize : 0;
  const remaining = Math.max(0, total - filled);
  return remaining;
}

export { confirmOrder };
