import { markLayer } from '../status/tracker.js';
import { evaluateStatus } from '../status/evaluator.js';
/**
 * trades handler (skeleton)
 * 約定データの受信処理
 * 
 * 実装予定:
 * - side / px / sz の抽出
 * - 時系列の連続性チェック
 * - JSONL ログへの書き込み
 */


import * as logger from '../utils/logger.js';
import { updateHealth, STAGES } from '../../core/healthState.js';  // ← #2修正: updateHealth追加
import { normalizeEvent } from '../normalize/index.js';
import * as io from '../../io/index.js';
let bridgeEmitter;
import('../../core/bridgeEmitter.js').then(mod => { bridgeEmitter = mod.default || mod; });

async function logHandlerError(message, err) {
	try {
		await logger.write({ ts: Date.now(), channel: 'handler_error', handler: 'trades', message, detail: err?.message || err });
	} catch (logErr) {
		console.error('[WS_TRADES] logHandlerError failed', logErr);
	}
}

async function handleTrades(msg) {
	try {
		// ← #2修正: tradesハンドラがhealthを更新
		updateHealth(STAGES.NETWORK, 'trades');
		
		// Normalizeレイヤー到達
		markLayer('NORMALIZE');
		// Normalize → I/O pipeline
			const pkt = normalizeEvent(msg);
			if (pkt) {
				markLayer('TRADES');
				// IOレイヤー到達
				markLayer('IO');
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
			        trades: { ts: recvTs }
			      }
			    },
			    ts: Date.now()
			  });
			} catch (emitErr) {
			  console.error('[WS_TRADES] emit debug-packet failed', emitErr);
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
		console.warn('trades handler error', e && e.message);
		await logHandlerError('trades handler error', e);
	}
}

export { handleTrades };
