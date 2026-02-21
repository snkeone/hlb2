import fs from 'fs';
import path from 'path';
import { cloneState } from './state.js';
import { resolveStatePath as resolveStatePathConfig } from '../config/statePath.js';

// Persistent store for EngineState (TEST Engine / restart safety)
const DEFAULT_STATE_PATH = () => resolveStatePathConfig(process.env.MODE, process.env.ENGINE_STATE_PATH);

function resolveStatePath(customPath) {
  if (typeof customPath === 'string' && customPath.length > 0) {
    return customPath;
  }
  return DEFAULT_STATE_PATH();
}

function ensureDir(targetPath) {
  // targetPath は既に resolveStatePath() で解決済みの絶対パスを受け取る
  // 二重解決を防ぐため、ここでは resolveStatePath() を呼ばない
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Load state from disk; fall back to createInitialState()
function loadEngineState(createInitialState, customPath) {
  const statePath = resolveStatePath(customPath);
  try {
    if (typeof createInitialState !== 'function') {
      throw new Error('createInitialState must be a function');
    }
    ensureDir(statePath);  // 既解決済みパスを渡す
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return sanitizeEngineState(parsed);
    }
  } catch (err) {
    console.warn('[engine/stateStore] load failed, fallback to initial:', err?.message || err);
  }
  return createInitialState();
}

// Save state to disk (overwrite)
function saveEngineState(state, customPath) {
  const statePath = resolveStatePath(customPath);
  try {
    ensureDir(statePath);  // 既解決済みパスを渡す
    const safe = sanitizeEngineState(state);
    fs.writeFileSync(statePath, JSON.stringify(safe), 'utf8');
  } catch (err) {
    console.warn('[engine/stateStore] save failed:', err?.message || err);
  }
}

// Reset persisted state
function resetEngineState(createInitialState, customPath) {
  const statePath = resolveStatePath(customPath);
  try {
    ensureDir(statePath);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch (err) {
    console.warn('[engine/stateStore] reset failed:', err?.message || err);
  }
  return createInitialState();
}

// Enforce minimal structure to avoid shallow-copy mutations
function sanitizeEngineState(state) {
  try {
    // cloneState already deep-copies known fields; fallback to empty object if malformed
    const base = cloneState(state || {});
    // Guard: openPosition structure
    if (base.openPosition) {
      const { side, size, entryPx, entryTs } = base.openPosition;
      if (!side || typeof size !== 'number' || typeof entryPx !== 'number' || typeof entryTs !== 'number') {
        base.openPosition = null;
      }
    }
    // Guard: trades array integrity
    if (!Array.isArray(base.trades)) base.trades = [];
    // Guard: stats object
    if (!base.stats || typeof base.stats !== 'object') {
      base.stats = {
        realizedPnl: 0,
        realizedPnlPct: 0,
        winTrades: 0,
        loseTrades: 0,
        totalTrades: 0,
        longTrades: 0,
        longWins: 0,
        shortTrades: 0,
        shortWins: 0,
        apr7d: 0,
        history7d: [],
        midPx: null,
        prevMidPx: null,
        oi: null
      };
    } else {
      if (!Array.isArray(base.stats.history7d)) base.stats.history7d = [];
    }
    return base;
  } catch (_) {
    return cloneState({
      openPosition: null,
      trades: [],
      stats: {
        realizedPnl: 0,
        realizedPnlPct: 0,
        winTrades: 0,
        loseTrades: 0,
        totalTrades: 0,
        longTrades: 0,
        longWins: 0,
        shortTrades: 0,
        shortWins: 0,
        apr7d: 0,
        history7d: [],
        midPx: null,
        prevMidPx: null,
        oi: null
      },
      lastDecision: null,
      lastUpdate: null,
      lastTickTs: null,
      lastLoopAtMs: null,
      lastMarketAtMs: null,
      safety: { status: 'NORMAL', reason: null, since: null }
    });
  }
}

export { loadEngineState, saveEngineState, resetEngineState };
