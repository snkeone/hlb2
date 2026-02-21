// engine/market/createMarketState.js
// 入力値からマーケット状態オブジェクトを生成

/**
 * @param {Object} input - 任意の入力オブジェクト
 * @returns {{ midPx: number|null, oi: number|null, ts: number }}
 */
export function createMarketState(input) {
  let midPx = null;
  let oi = null;

  if (input && typeof input.midPx === 'number' && input.midPx > 0) {
    midPx = input.midPx;
  }
  if (input && typeof input.oi === 'number' && input.oi >= 0) {
    oi = input.oi;
  }

  return {
    midPx,
    oi,
    ts: Date.now()
  };
}
