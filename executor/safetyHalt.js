// Executor Live Integration - Safety Halt Management
// Manages Live mode safety halt state and conditions

import { logSafetyHalt } from './logger.js';
import { setGlobalSafety } from '../engine/safety.js';

/**
 * Safety Halt 状態
 * liveEnabled: Live モードが有効かどうか
 * consecutiveErrors: 連続エラー回数（SignerAdapter接続）
 * lastError: 最後のエラー情報
 * lastHaltReason: 最後の Halt 理由
 */
let safetyState = {
  liveEnabled: true,
  consecutiveErrors: 0,
  lastError: null,
  lastHaltReason: null,
};

/**
 * Live モードが有効かチェック
 * @returns {boolean}
 */
function isLiveEnabled() {
  return safetyState.liveEnabled;
}

/**
 * Safety Halt を発動（Live 停止）
 * @param {string} reason - Halt 理由（signer_unavailable, invalid_signature, hl_reject など）
 * @param {string} detail - 詳細メッセージ
 */
async function triggerSafetyHalt(reason, detail) {
  safetyState.liveEnabled = false;
  safetyState.lastHaltReason = reason;
  safetyState.lastError = { reason, detail, ts: Date.now() };
  setGlobalSafety('HALTED', reason, detail, 'executor');
  
  logSafetyHalt({
    reason,
    detail,
    mode: 'auto',
  });
  
  // LINE alert for critical API errors (異常検知専用)
  if (reason === 'hl_reject' || reason === 'invalid_signature') {
    try {
      const { sendLineAlert } = await import('../engine/lineNotify.js');
      await sendLineAlert({
        type: 'API_ERROR',
        message: `${reason}: ${detail}`,
        action: 'Live取引停止'
      });
    } catch (alertErr) {
      console.error('[ALERT] Failed to send LINE alert:', alertErr.message);
    }
  }
}

/**
 * SignerAdapter エラーを記録（3連続で Safety Halt）
 * @param {Error} error
 */
function recordSignerError(error) {
  safetyState.consecutiveErrors++;
  
  if (safetyState.consecutiveErrors >= 3) {
    triggerSafetyHalt(
      'signer_unavailable',
      `SignerAdapter 3 consecutive errors: ${error.message}`
    );
  }
}

/**
 * SignerAdapter 成功を記録（エラーカウントリセット）
 */
function recordSignerSuccess() {
  safetyState.consecutiveErrors = 0;
}

/**
 * Live モードを手動で再有効化（運用者による復帰）
 * @param {string} operator - 操作者名（ログ用）
 */
function enableLiveMode(operator = 'manual') {
  safetyState.liveEnabled = true;
  safetyState.consecutiveErrors = 0;
  safetyState.lastHaltReason = null;
  setGlobalSafety('NORMAL', null, null, 'executor');
  // Event covered by logSafetyHalt and DebugUI
}

/**
 * 現在の Safety 状態を取得
 * @returns {object}
 */
function getSafetyState() {
  return { ...safetyState };
}

export {
  isLiveEnabled,
  triggerSafetyHalt,
  recordSignerError,
  recordSignerSuccess,
  enableLiveMode,
  getSafetyState,
};
