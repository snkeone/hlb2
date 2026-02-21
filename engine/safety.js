// engine/safety.js
// SAFETY管理専用モジュール（Engine/Executor共通の中央ステータス）

const globalSafety = { status: 'NORMAL', reason: null, detail: null, source: 'engine', since: null };

/**
 * SAFETY状態を一元管理（EngineStateとグローバルを同期）
 * @param {Object} engineState - エンジン状態
 * @param {'NORMAL'|'HALTED'|'ERROR'} status
 * @param {string|null} reason
 * @param {string|null} detail
 */
function setSafety(engineState, status, reason, detail = null) {
  if (!engineState.safety) engineState.safety = { status: 'NORMAL', reason: null, since: null };
  if (engineState.safety.status !== status || engineState.safety.reason !== reason) {
    engineState.safety.status = status;
    engineState.safety.reason = reason ?? null;
    engineState.safety.since = Date.now();
    console.log('[SAFETY]', status, reason);
  }
  setGlobalSafety(status, reason, detail, 'engine');
}

function setGlobalSafety(status, reason, detail = null, source = 'engine') {
  if (globalSafety.status === status && globalSafety.reason === reason && globalSafety.detail === detail) return;
  globalSafety.status = status;
  globalSafety.reason = reason ?? null;
  globalSafety.detail = detail ?? null;
  globalSafety.source = source;
  globalSafety.since = Date.now();
  console.log('[GLOBAL SAFETY]', status, reason, detail, `source=${source}`);
}

function getGlobalSafety() {
  return { ...globalSafety };
}

export { setSafety, setGlobalSafety, getGlobalSafety };
