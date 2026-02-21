import fs from 'fs';
import path from 'path';

// Persistent executor state for nonce allocation, processed key deduplication, and partial fill locks
const STATE_PATH = path.join(process.cwd(), 'ws', 'executor_state.json');
const DEFAULT_STATE = { currentNonce: 0, processedKeys: [], partialLock: null };

function ensureDir() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readStateFile() {
  try {
    ensureDir();
    if (!fs.existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const currentNonce = Number.isFinite(parsed?.currentNonce) && parsed.currentNonce >= 0
      ? parsed.currentNonce
      : 0;
    const processedKeys = Array.isArray(parsed?.processedKeys)
      ? parsed.processedKeys.filter(k => typeof k === 'string')
      : [];
    const partialLock = sanitizePartialLock(parsed?.partialLock);
    return { currentNonce, processedKeys, partialLock };
  } catch (err) {
    console.warn('[executor/stateStore] read failed, fallback to defaults:', err?.message || err);
    return { ...DEFAULT_STATE };
  }
}

const memoryState = (() => {
  const loaded = readStateFile();
  return {
    currentNonce: loaded.currentNonce,
    processedKeys: new Set(loaded.processedKeys),
    partialLock: loaded.partialLock,
  };
})();

let opQueue = Promise.resolve();

function enqueue(task) {
  const next = opQueue.then(() => task()).catch(err => {
    console.warn('[executor/stateStore] op failed:', err?.message || err);
    throw err;
  });
  opQueue = next.catch(() => {});
  return next;
}

function persist() {
  ensureDir();
  const payload = {
    currentNonce: Number.isFinite(memoryState.currentNonce) && memoryState.currentNonce >= 0
      ? memoryState.currentNonce
      : 0,
    processedKeys: Array.from(memoryState.processedKeys),
    partialLock: memoryState.partialLock,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload), 'utf8');
}

function getStateSnapshot() {
  return {
    currentNonce: memoryState.currentNonce,
    processedKeysCount: memoryState.processedKeys.size,
    partialLockActive: Boolean(memoryState.partialLock),
  };
}

async function allocateNonce() {
  return enqueue(async () => {
    const nonce = memoryState.currentNonce;
    memoryState.currentNonce += 1;
    persist();
    return nonce;
  });
}

async function resetNonce() {
  return enqueue(async () => {
    memoryState.currentNonce = 0;
    persist();
    return memoryState.currentNonce;
  });
}

function hasProcessedKey(key) {
  return memoryState.processedKeys.has(key);
}

async function addProcessedKey(key) {
  if (typeof key !== 'string') return;
  return enqueue(async () => {
    memoryState.processedKeys.add(key);
    persist();
  });
}

async function claimProcessedKey(key) {
  if (typeof key !== 'string') return false;
  return enqueue(async () => {
    if (memoryState.processedKeys.has(key)) return false;
    memoryState.processedKeys.add(key);
    persist();
    return true;
  });
}

async function clearProcessedKeys() {
  return enqueue(async () => {
    memoryState.processedKeys.clear();
    persist();
  });
}

function sanitizePartialLock(lock) {
  if (!lock || typeof lock !== 'object') return null;
  const { orderId, remainingSize, side, price, ts } = lock;
  if (typeof orderId !== 'string' || orderId.length === 0) return null;
  if (!Number.isFinite(remainingSize) || remainingSize < 0) return null;
  if (side !== 'buy' && side !== 'sell') return null;
  const lockedAt = Number.isFinite(ts) ? ts : Date.now();
  return {
    orderId,
    remainingSize,
    side,
    price: Number.isFinite(price) ? price : null,
    ts: lockedAt,
  };
}

async function setPartialLock(lock) {
  const sanitized = sanitizePartialLock(lock);
  if (!sanitized) return;
  return enqueue(async () => {
    memoryState.partialLock = sanitized;
    persist();
    return sanitized;
  });
}

async function clearPartialLock() {
  return enqueue(async () => {
    memoryState.partialLock = null;
    persist();
  });
}

function getPartialLock() {
  return memoryState.partialLock;
}

export {
  allocateNonce,
  resetNonce,
  hasProcessedKey,
  addProcessedKey,
  claimProcessedKey,
  clearProcessedKeys,
  setPartialLock,
  clearPartialLock,
  getPartialLock,
  getStateSnapshot,
};
