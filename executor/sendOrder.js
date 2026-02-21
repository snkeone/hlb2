// API 呼び出し：test mode はダミー、live mode は REST POST
// Live mode: Safety Halt guard + LIVE_ENABLED_COINS check + HL API call

import axios from 'axios';
import { HL_API_URL, LIVE_ENABLED_COINS, HL_MAINNET } from './config.js';
import { isLiveEnabled, triggerSafetyHalt } from './safetyHalt.js';
import { logLiveDisabled } from './logger.js';
import { buildHlOrderAction } from './hlAction.js';

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

/**
 * Hyperliquid API 呼び出し（将来の差し替え容易化のため関数分離）
 * @param {object} action - HL action オブジェクト
 * @param {string} signature - EIP-712 署名
 * @param {number} nonce - nonce
 * @returns {Promise<any>} HL API レスポンス
 */
async function callHlOrderApi(action, signature, nonce) {
  const url = `${HL_API_URL}/exchange`;
  
  const payload = {
    action,
    nonce,
    signature,
    vaultAddress: null,
  };

  const timeoutMs = 4000;
  const maxRetries = 3;

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.post(url, payload, {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });
      return { ok: true, data: resp.data };
    } catch (err) {
      lastError = err;
      await delay(250 * attempt);
    }
  }

  return { ok: false, error: serializeError(lastError) };
}

/**
 * @param {any} order 注文構造体
 * @param {any} ctx { mode: 'test'|'live', signResult?, market: { coin } }
 * @returns {Promise<any>} apiResponse
 */
async function sendOrder(order, ctx) {
  const mode = (ctx && ctx.mode) || 'test';
  const dryRun = process.env.DRY_RUN === '1';

  if (mode === 'test') {
    // テスト強制失敗（Safety Halt 検証用）
    if (ctx && ctx.testForceFail) {
      return { ok: false, error: { code: 'TEST_FAIL', message: 'forced failure (test)' } };
    }
    // ダミー応答：常に成功体（filled相当の材料）
    return {
      ok: true,
      data: {
        orderId: `TEST-${order.clientOrderId}`,
        status: 'accepted',
        filled: true,
        price: order.price,
        size: order.size,
        ts: Date.now(),
      }
    };
  }

  // DRY_RUN モード: 署名済み状態で停止（API 送信なし）
  if (dryRun) {
    return {
      ok: true,
      data: {
        orderId: `DRY-${order.clientOrderId}`,
        status: 'dry_run',
        filled: false,
        price: order.price,
        size: order.size,
        ts: Date.now(),
        dryRun: true,
      }
    };
  }

  // Live mode: ガード条件チェック
  const coin = ctx?.market?.coin || 'BTC';

  // ① liveEnabled チェック
  if (!isLiveEnabled()) {
    logLiveDisabled({ coin, reason: 'safety_halt_active' });
    return {
      ok: false,
      error: {
        code: 'LIVE_DISABLED',
        message: 'Live mode is disabled due to Safety Halt',
      }
    };
  }

  // ② LIVE_ENABLED_COINS チェック
  if (!LIVE_ENABLED_COINS.includes(coin)) {
    logLiveDisabled({ coin, reason: 'coin_not_enabled' });
    return {
      ok: false,
      error: {
        code: 'COIN_NOT_ENABLED',
        message: `Live mode not enabled for ${coin}. Enabled: ${LIVE_ENABLED_COINS.join(', ')}`,
      }
    };
  }

  // Live mode: 署名情報取得
  const signResult = ctx && ctx.signResult;
  if (!signResult || !signResult.signature) {
    return {
      ok: false,
      error: {
        code: 'MISSING_SIGNATURE',
        message: 'signResult.signature is required for Live mode',
      }
    };
  }

  // HL Action 構築（署名時と完全一致）
  const { action } = buildHlOrderAction(order, coin);

  // HL API 呼び出し（関数分離：将来の差し替え容易化）
  const result = await callHlOrderApi(action, signResult.signature, signResult.nonce);

  // HL reject 時の Safety Halt
  if (!result.ok) {
    const errorCode = result.error?.code;
    const errorMessage = result.error?.message || 'unknown error';

    // Fatal reject 判定（unauthorized, invalid signature など）
    // TODO: Step 7 E2E で実際の HL API レスポンスを確認して判定条件を精緻化
    if (errorCode === 'UNAUTHORIZED' || errorMessage.includes('signature')) {
      triggerSafetyHalt('hl_reject', `HL API rejected: ${errorMessage}`);
    }
  }

  return result;
}

function buildAuthHeaders(ctx) {
  const headers = { 'Content-Type': 'application/json' };
  // Live では署名ベース認証のため X-API-KEY は不要（EIP712署名がpayloadに含まれる）
  return headers;
}

function serializeError(e) {
  if (!e) return { code: 'UNKNOWN', message: 'unknown error' };
  const message = e.message || String(e);
  return { code: e.code || 'HTTP_ERROR', message, cause: sanitize(e) };
}

function sanitize(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (_) {
    return String(obj);
  }
}

export { sendOrder };
