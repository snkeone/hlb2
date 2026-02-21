import { markLayer } from './status/tracker.js';
import { evaluateStatus } from './status/evaluator.js';
import { createOrderbookSync } from './orderbook/OrderbookSync.js';
/**
 * HLWS-BOT / WebSocket Core (skeleton only)
 * 目的: Hyperliquid WS 接続・再接続・ルーティング枠組み
 * 実装コードは未記述（承認後に追加）
 */

// ここに WebSocket 接続の初期化を実装予定（承認後）
// - connectWS()
// - handleMessage()
// - handleClose()
// - stale検知
// - subscribe（orderbook / trades）
// ※ まだ空のままでOK
// Purpose: index.js will contain
//  - connection lifecycle (connect/disconnect)
//  - reconnection/backoff strategy
//  - incoming message routing to handler modules
//  - stale detection monitoring and emitting diagnostic logs
//
// Pre-implementation checklist (to follow during coding):
//  - Keep connection logic isolated from payload processing
//  - No direct file I/O here (use ws/utils/logger.js)
//  - Config constants (timeouts, stale thresholds, maxRetries) declared at top-level
//  - All async file ops must be non-blocking
//
// NOTE: Do NOT implement code here until shun approves.

/*
 * ws/index.js - HLWS-BOT WebSocket v0.1
 * Implements the connection/reconnect/subscribe/stale-detect/dispatch responsibilities
 * as specified in the project design (v0.1).
 *
 * Notes:
 *  - This is intentionally lightweight: no data shaping, no file I/O.
 *  - Handlers are invoked but left to their own implementation.
 */

const DEFAULT_CONFIG = {
	WS_URL: 'wss://api.hyperliquid.xyz/ws',
	STALE_THRESHOLD_MS: 15 * 1000, // 15 seconds
	STALE_MONITOR_INTERVAL_MS: 5 * 1000, // 5 seconds
	RECONNECT_DELAY_MS: 3 * 1000, // 3 seconds
	SUBSCRIPTIONS: [
		{ type: 'l2Book', coin: 'BTC' },
		{ type: 'trades', coin: 'BTC' },
		{ type: 'activeAssetCtx', coin: 'BTC' }
	],
	ORDERBOOK_SYNC: {
		enabled: process.env.WS_OOB_SYNC_ENABLED === '1',
		restIntervalMs: Number(process.env.WS_OOB_SYNC_INTERVAL_MS || 60000),
		driftThresholdRatio: Number(process.env.WS_OOB_SYNC_DRIFT_RATIO || 0.01),
		compareTopLevels: Number(process.env.WS_OOB_SYNC_TOP_LEVELS || 5)
	}
};


// handlers are optional; import them if present else use no-op
async function loadHandlers() {
	let orderbook = { handleOrderbook: () => {} };
	let trades = { handleTrades: () => {} };
	let mid = { handle: () => {} };
	let activeCtx = { handleActiveCtx: () => {} };
	try { orderbook = await import('./handlers/orderbook.js'); } catch (e) { console.error('[WS] loadHandlers orderbook failed', e); }
	try { trades = await import('./handlers/trades.js'); } catch (e) { console.error('[WS] loadHandlers trades failed', e); }
	try { mid = await import('./handlers/mid.js'); } catch (e) { console.error('[WS] loadHandlers mid failed', e); }
	try { activeCtx = await import('./handlers/activeCtx.js'); } catch (e) { console.error('[WS] loadHandlers activeCtx failed', e); }
	return { orderbook, trades, mid, activeCtx };
}

// Load I/O module for reset() on reconnect
let io = null;
try { io = await import('../io/index.js'); } catch (e) { console.error('[WS] import io failed', e); }

function makeConnectionState() {
	return {
		ws: null,
		lastMessageAt: 0,
		retryCount: 0,
		isStale: false,
		isConnected: false,
		activeSubscriptions: []
	};
}

async function HLWSClient(opts = {}) {
	const CONFIG = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
	
	// ← #17修正: SUBSCRIPTIONS を設定から生成（BTC固定を解除）
	if (opts.config?.symbols && Array.isArray(opts.config.symbols) && opts.config.symbols.length > 0) {
		CONFIG.SUBSCRIPTIONS = [];
		for (const symbol of opts.config.symbols) {
			CONFIG.SUBSCRIPTIONS.push({ type: 'l2Book', coin: symbol });
			CONFIG.SUBSCRIPTIONS.push({ type: 'trades', coin: symbol });
			CONFIG.SUBSCRIPTIONS.push({ type: 'activeAssetCtx', coin: symbol });
		}
	}
	
	const WebSocketCtor = opts.WebSocket || (typeof WebSocket !== 'undefined' && WebSocket) || null;
	const handlers = await loadHandlers();
	let logger = null;
	try { logger = (await import('./utils/logger.js')).write ? await import('./utils/logger.js') : null; } catch(e){ logger = null; }

	const state = makeConnectionState();
	let orderbookSync = null;
	let staleMonitorTimer = null;
	let reconnectTimer = null;
	let isStopped = false; // ← #1修正: 停止フラグ

	const syncCfg = Object.assign({}, DEFAULT_CONFIG.ORDERBOOK_SYNC, opts?.config?.orderbookSync || {});
	if (syncCfg.enabled) {
		orderbookSync = createOrderbookSync({
			coin: (opts.config?.symbols && opts.config.symbols[0]) || 'BTC',
			restIntervalMs: syncCfg.restIntervalMs,
			driftThresholdRatio: syncCfg.driftThresholdRatio,
			compareTopLevels: syncCfg.compareTopLevels,
			onResynced: ({ coin, reason, snapshot }) => {
				const ts = now();
				const synthetic = {
					channel: 'l2Book',
					data: {
						coin,
						time: ts,
						levels: [snapshot.bids, snapshot.asks]
					}
				};
				const event = { ts, channel: 'orderbook', data: synthetic };
				log({ type: 'oob_snapshot_applied', reason, coin, ts });
				try { handlers.orderbook.handleOrderbook(event); } catch (e) { log({ type: 'handler_error', handler: 'orderbook_oob_snapshot', detail: e && e.message }); }
			},
			logger: (event) => {
				if (logger && typeof logger.write === 'function') {
					logger.write(event).catch(() => {});
				}
				log(event);
			}
		});
	}

	// MergeSpec v1.0 logging helper: single point, no extra ts
	function log(obj) { try { console.log(JSON.stringify(obj)); } catch (err) { console.error('[WS] log emit failed', err); } }

	function now() { return Date.now(); }

	function _safeSend(payload) {
		if (!state.ws || state.ws.readyState !== 1) return false;
		try {
			state.ws.send(JSON.stringify(payload));
			return true;
		} catch (e) {
			log({ type: 'ws_send_error', detail: e && e.message });
			return false;
		}
	}

	function subscribeAll() {
		for (const sub of CONFIG.SUBSCRIPTIONS) {
			// 余計なラップ・変換禁止、payloadはそのまま
			const payload = { method: 'subscribe', subscription: sub };
			if (_safeSend(payload)) {
				state.activeSubscriptions.push(sub);
			}
		}
	}

	function handleMessage(raw) {
		// update last message immediately (stale monitoring relies on this)
		state.lastMessageAt = now();
		state.isStale = false;
		// WSレイヤー到達
		markLayer('WS');
		// 状態評価をlogger出力前に呼び出し
		const wsStatus = evaluateStatus();
		if (logger && typeof logger.write === 'function') logger.write({ wsStatus, ts: now(), channel: 'status' }).catch(() => {});

		// Convert Buffer to string if needed
		const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;

		let data = null;
		try {
			data = typeof rawStr === 'string' ? JSON.parse(rawStr) : rawStr;
		} catch (err) {
			// malformed message: log parse error and return
			const event = { ts: now(), channel: 'parse_error', data: { raw: String(rawStr).substring(0, 100), err: err && err.message } };
			if (logger && typeof logger.write === 'function') logger.write(event).catch(() => {});
			log({ type: 'handler_error', handler: 'parse', detail: err && err.message });
			return;
		}

		const channel = data && data.channel;
		if (!channel) {
			return;
		}

		switch (channel) {
			case 'l2Book': {
				const event = { ts: now(), channel: 'orderbook', data };
				if (orderbookSync) {
					try { orderbookSync.onWsOrderbook(data, event.ts); } catch (_) {}
				}
				try { handlers.orderbook.handleOrderbook(event); } catch (e) { log({ type: 'handler_error', handler: 'orderbook', detail: e && e.message }); }
				break;
			}
			case 'trades': {
				const event = { ts: now(), channel: 'trades', data };
				try { handlers.trades.handleTrades(event); } catch (e) { log({ type: 'handler_error', handler: 'trades', detail: e && e.message }); }
				break;
			}
			case 'ticker':
				// map to mid handler
				state.lastTicker = data;
				{
					const event = { ts: now(), channel: 'mid', data };
					if (handlers.mid && typeof handlers.mid.handle === 'function') {
						try { handlers.mid.handle(event); } catch (e) { log({ type: 'handler_error', handler: 'mid', detail: e && e.message }); }
					}
				}
				break;
			case 'activeAssetCtx': {
			const event = { ts: now(), channel: 'activeAssetCtx', data };
			if (handlers.activeCtx && typeof handlers.activeCtx.handleActiveCtx === 'function') {
				try { handlers.activeCtx.handleActiveCtx(event); } catch (e) { log({ type: 'handler_error', handler: 'activeAssetCtx', detail: e && e.message }); }
			}
				break;
			}
			default:
				// ignore unknown channels
				break;
		}
	}

	function handleClose(reason) {
		// ← #1修正: 停止中は再接続しない
		if (isStopped) {
			log({ type: 'ws_close', detail: 'stopped, no reconnect' });
			return;
		}

		// normalize state
		if (state.ws) {
			try { state.ws.close && state.ws.close(); } catch (e) { console.error('[WS] handleClose close failed', e); }
		}
		state.ws = null;
		state.isConnected = false;

		// MergeSpec: increment retry count & emit close + upcoming reconnect intent
		state.retryCount += 1;
		log({ type: 'ws_close' });
		log({ type: 'ws_reconnect', retry: state.retryCount });

		// LINE alert if reconnect fails repeatedly (異常検知専用)
		if (state.retryCount >= 5) {
			import('../engine/lineNotify.js')
				.then(({ sendLineAlert }) => {
					return sendLineAlert({
						type: 'WS_DISCONNECTED',
						message: `WebSocket切断（${state.retryCount}回目）`,
						action: '再接続試行中'
					});
				})
				.catch(err => {
					console.error('[ALERT] Failed to send LINE alert:', err.message);
				});
		}

		scheduleReconnect();
	}

	function scheduleReconnect() {
		if (isStopped) return; // ← #1修正: 停止中なら再接続予約しない
		if (reconnectTimer) return; // already scheduled
		// MergeSpec: announce fixed delay before reconnect attempt
		log({ type: 'ws_retry_wait', delay: CONFIG.RECONNECT_DELAY_MS });
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connectWS();
		}, CONFIG.RECONNECT_DELAY_MS);
	}

	function clearReconnect() {
		if (!reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	function connectWS(url) {
		// allow override url for testing
		const target = url || CONFIG.WS_URL;

		if (!WebSocketCtor) throw new Error('No WebSocket constructor provided');

		// close existing if any
		if (state.ws) {
			try { state.ws.close && state.ws.close(); } catch (e) { console.error('[WS] connectWS close existing failed', e); }
			state.ws = null;
		}

		clearReconnect();

		const ws = new WebSocketCtor(target);
		state.ws = ws;

		ws.on('open', () => {
			state.isConnected = true;
			state.retryCount = 0;
			state.lastMessageAt = now();
			// ← #3修正: 再接続時に購読リストをクリア
			state.activeSubscriptions = [];
			// subscribe immediately
			subscribeAll();
			log({ type: 'ws_open' });
		});

		ws.on('message', (raw) => {
			handleMessage(raw);
		});

		ws.on('error', (err) => {
			log({ type: 'ws_error', detail: (err && err.message) || 'unknown' });
			try { ws.close && ws.close(); } catch (e) { console.error('[WS] ws error close failed', e); }
		});

		ws.on('close', (code, reason) => {
			handleClose(reason);
		});

		return ws;
	}

	function start(url) {
		if (orderbookSync) orderbookSync.start();
		// start stale monitor
		if (!staleMonitorTimer) {
			staleMonitorTimer = setInterval(() => {
				const last = state.lastMessageAt || 0;
				if (last === 0) return; // no messages yet
				const age = now() - last;
				if (age > CONFIG.STALE_THRESHOLD_MS && !state.isStale) {
					state.isStale = true;
					// MergeSpec: stale notification prior to close
					log({ type: 'ws_stale' });
					// close ws and schedule reconnect
					try { state.ws && state.ws.close && state.ws.close(); } catch (e) { console.error('[WS] stale monitor close failed', e); }
				}
			}, CONFIG.STALE_MONITOR_INTERVAL_MS);
		}

		connectWS(url);
	}

	function stop() {
		isStopped = true; // ← #1修正: 停止フラグをセット
		if (orderbookSync) orderbookSync.stop();
		if (staleMonitorTimer) { clearInterval(staleMonitorTimer); staleMonitorTimer = null; }
		clearReconnect();
		if (state.ws) { try { state.ws.close && state.ws.close(); } catch (e) { console.error('[WS] stop close failed', e); } }
		state.ws = null;
		state.isConnected = false;
	}


	return {
		start,
		stop,
		connectWS,
		scheduleReconnect,
		clearReconnect,
		getState: () => ({...state, orderbookSync: orderbookSync ? orderbookSync.getState() : null}),
		_internal: { CONFIG, state }
	};
}

export { HLWSClient };
