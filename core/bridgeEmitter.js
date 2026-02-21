// core/bridgeEmitter.cjs
// CJS bridge to the shared BridgeEmitter singleton

import { EventEmitter } from 'events';

// Reuse global instance if already created by ESM side
if (!globalThis.__bridgeEmitter) {
  globalThis.__bridgeEmitter = new EventEmitter();
}

export default globalThis.__bridgeEmitter;
