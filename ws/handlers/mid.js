import { markLayer } from '../status/tracker.js';
import { evaluateStatus } from '../status/evaluator.js';

import * as logger from '../utils/logger.js';
import { normalizeEvent } from '../normalize/index.js';
import * as io from '../../io/index.js';
let bridgeEmitter;
import('../../core/bridgeEmitter.js').then(mod => { bridgeEmitter = mod.default || mod; });

async function logHandlerError(message, err) {
  try {
    await logger.write({ ts: Date.now(), channel: 'handler_error', handler: 'mid', message, detail: err?.message || err });
  } catch (logErr) {
    console.error('[WS_MID] logHandlerError failed', logErr);
  }
}

async function handle(msg) {
  try {
    // Normalizeレイヤー到達
    markLayer('NORMALIZE');
    // Normalize → I/O pipeline
    const pkt = normalizeEvent(msg);
    if (pkt) {
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
              mid: { ts: recvTs }
            }
          },
          ts: Date.now()
        });
      } catch (emitErr) {
        console.error('[WS_MID] emit debug-packet failed', emitErr);
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
    console.warn('mid handler error', e && e.message);
    await logHandlerError('mid handler error', e);
  }
}

export { handle };
