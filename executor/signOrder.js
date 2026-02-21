// EIP712 署名実装（SignerAdapter 連携）
// Live モード: SignerAdapter HTTP /sign エンドポイント
// Test モード: ダミー署名

import axios from 'axios';
import {
  SIGNER_ADAPTER_URL,
  SIGNER_TIMEOUT_MS,
  SIGNER_MAX_RETRIES,
  SIGNER_RETRY_DELAY_MS,
  LIVE_ENABLED_COINS,
  HL_MAINNET,
} from './config.js';
import {
  logSignRequestCreated,
  logSignRequestSent,
  logSignRequestRetry,
  logSignResponseReceived,
  logLiveDisabled,
} from './logger.js';
import {
  isLiveEnabled,
  triggerSafetyHalt,
  recordSignerError,
  recordSignerSuccess,
} from './safetyHalt.js';
import { allocateNonce, resetNonce as resetNonceState, claimProcessedKey } from './stateStore.js';
import { buildHlOrderAction } from './hlAction.js';

async function getNextNonce() {
  return allocateNonce();
}

async function resetNonce() {
  return resetNonceState();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 署名レスポンスの形式検証
 * @param {string} signature - 署名文字列
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSignature(signature) {
  // 長さチェック: 0x + 130 hex = 132 文字
  if (typeof signature !== 'string' || signature.length !== 132) {
    return { valid: false, error: `Invalid signature length: ${signature?.length || 0}, expected 132` };
  }

  // 0x プレフィックスチェック
  if (!signature.startsWith('0x')) {
    return { valid: false, error: 'Signature must start with 0x' };
  }

  // 16進数チェック
  const hexPart = signature.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
    return { valid: false, error: 'Signature contains non-hex characters' };
  }

  // v チェック（最後の2文字、27 or 28 = 0x1b or 0x1c）
  const vHex = hexPart.slice(-2);
  const vValue = parseInt(vHex, 16);
  if (vValue !== 27 && vValue !== 28) {
    return { valid: false, error: `Invalid v value: ${vValue}, expected 27 or 28` };
  }

  return { valid: true };
}

/**
 * SignerAdapter に署名リクエストを送信
 * @param {object} signRequest - { action, nonce, vaultAddress, expiresAfter }
 * @returns {Promise<string>} signature
 */
async function requestSignature(signRequest) {
  // DRY_RUN モード: モック署名を返す（SignerAdapter 呼び出しなし）
  if (process.env.DRY_RUN === '1') {
    // 形式的に正しい署名構造（0x + 130 hex = 132 文字、v=27）
    const mockSig = '0x' + '1'.repeat(128) + '1b';
    return mockSig;
  }

  const url = `${SIGNER_ADAPTER_URL}/sign`;
  
  let lastError = null;

  for (let attempt = 1; attempt <= SIGNER_MAX_RETRIES; attempt++) {
    try {
      logSignRequestSent({
        nonce: signRequest.nonce,
        attempt,
        url,
      });

      const response = await axios.post(url, signRequest, {
        timeout: SIGNER_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      });

      const data = response.data;

      // レスポンス形式チェック
      if (!data || data.ok !== true || !data.signature) {
        throw new Error(`Invalid response from SignerAdapter: ${JSON.stringify(data)}`);
      }

      logSignResponseReceived({
        nonce: signRequest.nonce,
        signatureLength: data.signature.length,
      });

      // 署名検証
      const validation = validateSignature(data.signature);
      if (!validation.valid) {
        triggerSafetyHalt('invalid_signature', validation.error);
        throw new Error(`Signature validation failed: ${validation.error}`);
      }

      recordSignerSuccess();
      return data.signature;

    } catch (error) {
      lastError = error;
      
      logSignRequestRetry({
        nonce: signRequest.nonce,
        attempt,
        reason: error.message,
      });

      if (attempt < SIGNER_MAX_RETRIES) {
        await delay(SIGNER_RETRY_DELAY_MS * attempt);
      }
    }
  }

  // 3回失敗 → エラー記録
  recordSignerError(lastError);
  throw lastError;
}

/**
 * EIP712 Typed Data 署名
 * @param {any} order buildOrder の出力
 * @param {any} ctx { mode, api: { agentAddress }, market: { coin } }
 * @returns {Promise<{ signature: string, nonce: number, agentAddress: string }>}
 */
async function signOrder(order, ctx) {
  const mode = (ctx && ctx.mode) || 'test';
  const agentAddress = ctx?.api?.agentAddress || '0x0000000000000000000000000000000000000000';

  // Test モード：ダミー署名
  if (mode === 'test') {
    const nonce = await getNextNonce();
    return {
      signature: 'TEST',
      nonce,
      agentAddress,
    };
  }

  // Live モード
  const coin = ctx?.market?.coin || 'BTC';
  const nonce = await getNextNonce();

  // [B-1] Nonce重複防止：addr+nonce を永続ストアで原子的に確保
  const processedKey = `nonce:${agentAddress}_${nonce}`;
  const claimed = await claimProcessedKey(processedKey);
  if (!claimed) {
    console.error(`[NONCE] DUPLICATE_NONCE addr=${agentAddress} nonce=${nonce}`);
    throw new Error(`Duplicate nonce detected: addr=${agentAddress}, nonce=${nonce}`);
  }

  // Live モード有効チェック
  if (!isLiveEnabled()) {
    logLiveDisabled({ coin, reason: 'safety_halt_active' });
    throw new Error('Live mode is disabled due to Safety Halt');
  }

  // コイン制限チェック
  if (!LIVE_ENABLED_COINS.includes(coin)) {
    logLiveDisabled({ coin, reason: 'coin_not_enabled' });
    throw new Error(`Live mode not enabled for ${coin}. Enabled coins: ${LIVE_ENABLED_COINS.join(', ')}`);
  }

  // 署名リクエスト生成
  logSignRequestCreated({
    coin,
    side: order.side,
    px: order.price,
    sz: order.size,
    nonce,
    env: HL_MAINNET ? 'mainnet' : 'testnet',
    mode: 'live',
  });

  const { action } = buildHlOrderAction(order, coin);
  const signRequest = {
    action,
    nonce,
    vaultAddress: null,
    expiresAfter: null,
  };

  // SignerAdapter に署名リクエスト
  const signature = await requestSignature(signRequest);

  // 署名成功時：claimProcessedKey 済みのため追加処理不要（永続化済み）

  return {
    signature,
    nonce,
    agentAddress,
  };
}

export { signOrder, resetNonce };
