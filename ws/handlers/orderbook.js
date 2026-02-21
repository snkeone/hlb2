import { markLayer } from '../status/tracker.js';
import { evaluateStatus } from '../status/evaluator.js';
/**
 * orderbook handler (skeleton)
 * L2 depth 更新処理の枠組み
 * 
 * 実装予定:
 * - levels データの受信
 * - midPx との整合チェック
 * - JSONL ログへの書き込み
 * 
 * ※ 今は空の枠だけ。コードは承認後に記述。
 */


import * as logger from '../utils/logger.js';
import { normalizeEvent } from '../normalize/index.js';
import * as io from '../../io/index.js';
import { updateHealth, STAGES } from '../../core/healthState.js';
// bridgeEmitter remains CJS, use dynamic import if needed
let bridgeEmitter;
import('../../core/bridgeEmitter.js').then(mod => { bridgeEmitter = mod.default || mod; });

async function logHandlerError(message, err) {
	try {
		await logger.write({ ts: Date.now(), channel: 'handler_error', handler: 'orderbook', message, detail: err?.message || err });
	} catch (logErr) {
		console.error('[WS_ORDERBOOK] logHandlerError failed', logErr);
	}
}

async function handleOrderbook(msg) {
	try {
		updateHealth(STAGES.NETWORK, 'orderbook');
		// Normalizeレイヤー到達
		markLayer('NORMALIZE');
		// Normalize → I/O pipeline
			const pkt = normalizeEvent(msg);
		if (pkt) {
			markLayer('ORDERBOOK');
			// IOレイヤー到達
				markLayer('IO');
				updateHealth(STAGES.WS);
				try {
					io.handleEvent(pkt);
				} catch (err) {
					await logHandlerError('io.handleEvent failed', err);
					throw err;
				}
			const recvTs = msg?.ts ?? Date.now();
			try {
			  bridgeEmitter.emit('debug-packet', {
			    layer: 'ws',
			    data: {
			      channels: {
			        orderbook: { ts: recvTs }
			      }
			    },
			    ts: Date.now()
			  });
			} catch (emitErr) {
			  console.error('[WS_ORDERBOOK] emit debug-packet failed', emitErr);
			}
		}
		// Logicレイヤー到達（logger出力直前）
		markLayer('LOGIC');
		// 状態評価をlogger出力前に呼び出し
		const status = evaluateStatus();
		try {
			await logger.write({ status, ts: Date.now(), channel: 'status' });
		} catch (err) {
			await logHandlerError('logger.write status failed', err);
		}
		// Logger
		try {
			await logger.write(msg);
		} catch (err) {
			await logHandlerError('logger.write message failed', err);
		}
	} catch (e) {
		console.warn('orderbook handler error', e && e.message);
		await logHandlerError('orderbook handler error', e);
	}
}

export { handleOrderbook };
