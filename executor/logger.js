// Executor Live Integration - Structured Logging
// Provides JSON-based structured logging for Live mode events

/**
 * 構造化ログ出力（1行1JSON）
 * @param {string} event - イベント名（例: executor.live.sign_request.created）
 * @param {object} fields - ログフィールド
 */
function logEvent(event, fields = {}) {
  const logEntry = {
    event,
    ts: Date.now(),
    ...fields,
  };
  console.log(JSON.stringify(logEntry));
}

/**
 * 署名リクエスト作成ログ
 */
function logSignRequestCreated({ coin, side, px, sz, nonce, env, mode }) {
  logEvent('executor.live.sign_request.created', {
    coin,
    side,
    px,
    sz,
    nonce,
    env,
    mode,
  });
}

/**
 * 署名リクエスト送信ログ
 */
function logSignRequestSent({ nonce, attempt, url }) {
  logEvent('executor.live.sign_request.sent', {
    nonce,
    attempt,
    url,
  });
}

/**
 * 署名リクエストリトライログ
 */
function logSignRequestRetry({ nonce, attempt, reason }) {
  logEvent('executor.live.sign_request.retry', {
    nonce,
    attempt,
    reason,
  });
}

/**
 * 署名レスポンス受信ログ
 */
function logSignResponseReceived({ nonce, signatureLength }) {
  logEvent('executor.live.sign_response.received', {
    nonce,
    signatureLength,
  });
}

/**
 * Safety Halt 発火ログ
 */
function logSafetyHalt({ reason, detail, mode }) {
  logEvent('executor.live.safety_halt', {
    reason,
    detail,
    mode: mode || 'auto',
  });
}

/**
 * オーダー確認ログ
 */
function logOrderConfirmed({ coin, side, px, sz, orderId, env }) {
  logEvent('executor.live.order.confirmed', {
    coin,
    side,
    px,
    sz,
    orderId,
    env,
  });
}

/**
 * オーダー拒否ログ
 */
function logOrderRejected({ coin, side, px, sz, reason, detail, env }) {
  logEvent('executor.live.order.rejected', {
    coin,
    side,
    px,
    sz,
    reason,
    detail,
    env,
  });
}

/**
 * Live 無効化ログ
 */
function logLiveDisabled({ coin, reason }) {
  logEvent('executor.live.disabled', {
    coin,
    reason,
  });
}

export {
  logEvent,
  logSignRequestCreated,
  logSignRequestSent,
  logSignRequestRetry,
  logSignResponseReceived,
  logSafetyHalt,
  logOrderConfirmed,
  logOrderRejected,
  logLiveDisabled,
};
