import { markLayer } from '../status/tracker.js';
import { evaluateStatus } from '../status/evaluator.js';
import * as logger from '../utils/logger.js';
import { updateHealth, STAGES } from '../../core/healthState.js';
import { normalizeEvent } from '../normalize/index.js';
import * as io from '../../io/index.js';

let bridgeEmitter;
import('../../core/bridgeEmitter.js').then((mod) => { bridgeEmitter = mod.default || mod; });

async function logHandlerError(message, err) {
  try {
    await logger.write({ ts: Date.now(), channel: 'handler_error', handler: 'liquidations', message, detail: err?.message || err });
  } catch (logErr) {
    console.error('[WS_LIQUIDATIONS] logHandlerError failed', logErr);
  }
}

async function handleLiquidations(msg) {
  try {
    updateHealth(STAGES.NETWORK, 'liquidations');

    markLayer('NORMALIZE');
    const pkt = normalizeEvent(msg);
    if (pkt) {
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
              liquidations: { ts: recvTs }
            }
          },
          ts: Date.now()
        });
      } catch (emitErr) {
        console.error('[WS_LIQUIDATIONS] emit debug-packet failed', emitErr);
      }
    }

    markLayer('LOGIC');
    const status = evaluateStatus();
    try {
      await logger.write({ status, ts: Date.now(), channel: 'status' });
    } catch (err) {
      await logHandlerError('logger.write status failed', err);
    }

    try {
      await logger.write(msg);
    } catch (err) {
      await logHandlerError('logger.write message failed', err);
    }
  } catch (e) {
    console.warn('liquidations handler error', e && e.message);
    await logHandlerError('liquidations handler error', e);
  }
}

export { handleLiquidations };
