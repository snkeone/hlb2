/**
 * ws/normalize/index.js
 * Entry point for Normalize layer
 * - Dispatch raw WS events to appropriate normalizer by channel
 * - Return null for skip, or normalized event for I/O layer
 */


import { normalizeOrderbook } from './orderbook.js';
import { normalizeTrades } from './trades.js';
import { normalizeCtx } from './ctx.js';
import { normalizeMid } from './mid.js';
import bridgeEmitter from '../../core/bridgeEmitter.js';

/**
 * normalizeEvent(raw)
 * Main entry point - dispatch to appropriate normalizer based on channel
 * @param {object} raw - Raw event from WS with structure: { ts, channel, data }
 * @returns {object|null} - Normalized event or null to skip
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.channel) return null;

  const channel = raw.channel;

  try {
    switch (channel) {
      case 'l2Book':
      case 'orderbook':
        return emitAndReturn('normalize', normalizeOrderbook(raw));
      
      case 'trades':
        return emitAndReturn('normalize', normalizeTrades(raw));
      
      case 'activeAssetCtx':
        return emitAndReturn('normalize', normalizeCtx(raw));
      
      case 'ticker':
      case 'mid':
        return emitAndReturn('normalize', normalizeMid(raw));
      
      default:
        return null;
    }
  } catch (e) {
    emitNormalizeError(e?.message || 'normalize_error');
    return null;
  }
}



function emitAndReturn(layer, pkt) {
  if (pkt && bridgeEmitter) {
    try {
      const digest = {};
      if (pkt.midPx !== undefined) digest.midPx = pkt.midPx;
      if (pkt.bid !== undefined) digest.bid = pkt.bid;
      if (pkt.ask !== undefined) digest.ask = pkt.ask;
      if (pkt.oi !== undefined) digest.oi = pkt.oi;
      digest.channel = pkt.channel || layer;
      bridgeEmitter.emit('debug-packet', { layer: 'normalize', data: digest, ts: Date.now() });
    } catch (err) {
      console.error('[WS_NORMALIZE] emitAndReturn failed', err);
    }
  }
  return pkt;
}

function emitNormalizeError(message) {
  try {
    bridgeEmitter.emit('debug-error', { layer: 'normalize', message, ts: Date.now() });
  } catch (err) {
    console.error('[WS_NORMALIZE] emitNormalizeError failed', err);
  }
}
