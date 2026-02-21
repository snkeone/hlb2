import { markLayer } from '../status/tracker.js';
import { evaluateStatus } from '../status/evaluator.js';
/**
 * ws/handlers/activeCtx.js
 * Purpose:
 *   Hold asset context updated from `activeAssetCtx` WS channel.
 *   OI/funding/premium/mark/oracle/impact fields are kept for WS-aware gates.
 */


import * as logger from '../utils/logger.js';
import { normalizeEvent } from '../normalize/index.js';
import * as io from '../../io/index.js';
let bridgeEmitter;
import('../../core/bridgeEmitter.js').then(mod => { bridgeEmitter = mod.default || mod; });

async function logHandlerError(message, err) {
  try {
    await logger.write({ ts: Date.now(), channel: 'handler_error', handler: 'activeAssetCtx', message, detail: err?.message || err });
  } catch (logErr) {
    console.error('[WS_ACTIVE_CTX] logHandlerError failed', logErr);
  }
}

let ctx = {
  oi: null,
  funding: null,
  premium: null,
  oraclePx: null,
  markPx: null,
  midPx: null,
  impactBidPx: null,
  impactAskPx: null,
  prevDayPx: null,
  dayNtlVlm: null,
  dayBaseVlm: null
};

async function handleActiveCtx(event) {
  try {
    const payload = event?.data;
    if (!payload || !payload.data) return;

    // Normalizeレイヤー到達
    markLayer('NORMALIZE');
    // Normalize → I/O pipeline
    const pkt = normalizeEvent(event);
    if (pkt) {
      // IOレイヤー到達
      markLayer('IO');
      try {
        io.handleEvent(pkt);
      } catch (err) {
        await logHandlerError('io.handleEvent failed', err);
        throw err;
      }
      const recvTs = event?.ts ?? Date.now();
      try {
        bridgeEmitter.emit('debug-packet', {
          layer: 'ws',
          data: {
            channels: {
              activeAssetCtx: { ts: recvTs }
            }
          },
          ts: Date.now()
        });
      } catch (emitErr) {
        console.error('[WS_ACTIVE_CTX] emit debug-packet failed', emitErr);
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
    // Write to log file
    try {
      await logger.write(event);
    } catch (err) {
      await logHandlerError('logger.write message failed', err);
    }

    // Hyperliquid activeAssetCtx structure: {coin: "BTC", ctx: {openInterest: "...", ...}}
    const ctxData = payload.data.ctx;
    if (ctxData && typeof ctxData === 'object') {
      if (ctxData.openInterest !== undefined) ctx.oi = Number(ctxData.openInterest);
      if (ctxData.funding !== undefined) ctx.funding = Number(ctxData.funding);
      if (ctxData.premium !== undefined) ctx.premium = Number(ctxData.premium);
      if (ctxData.oraclePx !== undefined) ctx.oraclePx = Number(ctxData.oraclePx);
      if (ctxData.markPx !== undefined) ctx.markPx = Number(ctxData.markPx);
      if (ctxData.midPx !== undefined) ctx.midPx = Number(ctxData.midPx);
      if (Array.isArray(ctxData.impactPxs)) {
        if (ctxData.impactPxs.length > 0) ctx.impactBidPx = Number(ctxData.impactPxs[0]);
        if (ctxData.impactPxs.length > 1) ctx.impactAskPx = Number(ctxData.impactPxs[1]);
      }
      if (ctxData.prevDayPx !== undefined) ctx.prevDayPx = Number(ctxData.prevDayPx);
      if (ctxData.dayNtlVlm !== undefined) ctx.dayNtlVlm = Number(ctxData.dayNtlVlm);
      if (ctxData.dayBaseVlm !== undefined) ctx.dayBaseVlm = Number(ctxData.dayBaseVlm);
    }
  } catch (e) {
    // fail-safe: do not throw into WS layer
    console.warn('activeCtx handler failed', e?.message);
    await logHandlerError('activeCtx handler error', e);
  }
}function getCtx() {
	return ctx;
}

export { handleActiveCtx, getCtx };
