/**
 * getMarket()
 * @returns { midPx: number|null, oi: number|null, ts: number }
 */
export const ACTIVE_PROVIDER = 'mock';
import { getMarket as _getMarket } from './mockProvider.js';

/**
 * getMarket() 健全性チェックラッパー
 * - midPx: number|null
 * - oi: number|null
 * - ts: Date.now()±10秒以内
 * 異常時はconsole.warnのみ（throw/Safety変更禁止）
 */
export function getMarket() {
	const m = _getMarket();
	const now = Date.now();
	if (!(typeof m.midPx === 'number' || m.midPx === null)) {
		console.warn('[PROVIDER WARN] midPx invalid:', m.midPx);
	}
	if (!(typeof m.oi === 'number' || m.oi === null)) {
		console.warn('[PROVIDER WARN] oi invalid:', m.oi);
	}
	if (typeof m.ts !== 'number' || Math.abs(now - m.ts) > 10000) {
		console.warn('[PROVIDER WARN] ts out of range:', m.ts, 'now:', now);
	}
	return m;
}
