// Executor 制御塔：handle(payload, ctx) を公開
// SafetyState の参照・更新、build→send→confirm の直線フロー

import { buildOrder } from './buildOrder.js';
import { applyRiskAllocation } from './riskAllocation.js';
import { signOrder } from './signOrder.js';
import { sendOrder } from './sendOrder.js';
import { confirmOrder } from './confirmOrder.js';
import { isLiveEnabled } from './safetyHalt.js';
import { claimProcessedKey, getPartialLock, setPartialLock, clearPartialLock } from './stateStore.js';

// SafetyState（単純なモジュールスコープ変数）
/** @type {import('./types').SafetyState} */
let safetyState = { mode: 'normal', lastError: undefined, lastUpdated: Date.now() };

// Live モードの順序保証用キュー（直列化）
let liveQueue = Promise.resolve();

function normalizeSide(side) {
  if (!side) return null;
  const s = String(side).toLowerCase();
  if (s === 'long') return 'buy';
  if (s === 'short') return 'sell';
  if (s === 'buy' || s === 'sell') return s;
  return null;
}

function resolveIntent(payload, ctx) {
  const explicit = payload?.intent ?? payload?.meta?.intent ?? ctx?.intent ?? null;
  if (explicit === 'exit' || explicit === 'entry') return explicit;
  const pos = payload?.openPosition
    ?? payload?.position
    ?? payload?.engineState?.openPosition
    ?? payload?.marketState?.current?.openPosition
    ?? ctx?.openPosition
    ?? ctx?.position
    ?? null;
  const posSide = normalizeSide(pos?.side ?? null);
  const decisionSide = normalizeSide(payload?.side ?? null);
  if (posSide && decisionSide) {
    return decisionSide !== posSide ? 'exit' : 'entry';
  }
  return null;
}

function enqueueLive(task) {
  const next = liveQueue.then(() => task());
  // Keep serialization chain alive regardless of previous task result.
  liveQueue = next.finally(() => undefined);
  return next;
}

function makeKey(payload) {
  const ts = payload && payload.timestamp ? String(payload.timestamp) : String(Date.now());
  const side = payload && payload.side ? payload.side : 'na';
  const size = payload && payload.size !== undefined ? String(payload.size) : 'na';
  const price = payload && payload.price !== undefined ? String(payload.price) : 'na';
  return `${ts}:${side}:${size}:${price}`;
}

function setSafetyHalt(errorObj) {
  safetyState = { mode: 'halted', lastError: errorObj, lastUpdated: Date.now() };
}

function isPayloadValid(payload) {
  const m = payload && payload.market;
  const mid = m && (m.mid ?? m.midPx);
  return (
    payload && (payload.side === 'buy' || payload.side === 'sell') &&
    typeof payload.size === 'number' && Number.isFinite(payload.size) && payload.size > 0 &&
    m && typeof mid === 'number' && Number.isFinite(mid) &&
    typeof m.coin === 'string' && m.coin.length > 0  // Live mode: coin 必須
  );
}

function normalizePayloadForExecutor(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const market = payload.market && typeof payload.market === 'object' ? payload.market : null;
  if (!market) return payload;
  const normalizedMarket = {
    ...market,
    mid: market.mid ?? market.midPx ?? null,
    bid: market.bid ?? market.bestBid ?? market.bestBidPx ?? null,
    ask: market.ask ?? market.bestAsk ?? market.bestAskPx ?? null,
  };
  return {
    ...payload,
    market: normalizedMarket
  };
}

function safeResultSide(payload) {
  return normalizeSide(payload?.side ?? null) ?? 'none';
}

function safeResultPrice(payload) {
  const market = payload?.market ?? null;
  const candidates = [
    payload?.price,
    market?.mid,
    market?.midPx,
    market?.bid,
    market?.bestBid,
    market?.bestBidPx,
    market?.ask,
    market?.bestAsk,
    market?.bestAskPx
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0;
}

function isBuiltOrderValid(order) {
  if (!order || typeof order !== 'object') return false;
  if (normalizeSide(order.side) == null) return false;
  if (typeof order.symbol !== 'string' || order.symbol.length === 0) return false;
  if (typeof order.size !== 'number' || !Number.isFinite(order.size) || order.size <= 0) return false;
  if (typeof order.price !== 'number' || !Number.isFinite(order.price) || order.price <= 0) return false;
  return true;
}

/**
 * @param {any} payload ExecutorPayload（I/O決定済み）
 * @param {any} ctx { mode: 'test'|'live', api?: {...}, wsState?: 'ok'|'stale'|'lost', riskAllocation?: {...} }
 * @returns {Promise<import('./types').OrderResult>}
 */
async function handle(payload, ctx = {}) {
  const normalizedPayload = normalizePayloadForExecutor(payload);
  // payload.riskAllocation を ctx に伝搬（enabled=false でも構造を維持）
  if (normalizedPayload && normalizedPayload.riskAllocation) {
    ctx.riskAllocation = normalizedPayload.riskAllocation;
  }
  
  if (ctx.mode === 'live') {
    return enqueueLive(() => handleCore(normalizedPayload, ctx));
  }
  return handleCore(normalizedPayload, ctx);
}

async function handleCore(payload, ctx = {}) {
  // Safety Halt: WS 異常
  if (ctx.wsState === 'stale' || ctx.wsState === 'lost') {
    setSafetyHalt({ code: 'WS_ERROR', message: `ws ${ctx.wsState}` });
  }

  // Halt 中は新規拒否（既存 safetyState OR Live Safety Halt）
  if (safetyState.mode === 'halted' || !isLiveEnabled()) {
    return {
      orderId: '',
      status: 'error',
      side: safeResultSide(payload),
      price: safeResultPrice(payload),
      size: payload && typeof payload.size === 'number' ? payload.size : 0,
      timestamp: Date.now(),
      error: 'safety halted',
    };
  }

  // I/O 異常（必須欠損）
  if (!isPayloadValid(payload)) {
    setSafetyHalt({ code: 'IO_ERROR', message: 'invalid payload' });
    return {
      orderId: '',
      status: 'error',
      side: safeResultSide(payload),
      price: safeResultPrice(payload),
      size: payload && typeof payload.size === 'number' ? payload.size : 0,
      timestamp: Date.now(),
      error: 'invalid payload',
    };
  }

  // Partial fill ロック（一定時間は新規エントリーを抑止）
  const partialLock = getPartialLock();
  if (partialLock) {
    const ttlMs = 30_000;
    const age = Date.now() - (partialLock.ts || 0);
    if (age < ttlMs) {
      return {
        orderId: partialLock.orderId,
        status: 'error',
        side: payload.side,
        price: typeof payload.price === 'number' ? payload.price : payload.market.mid,
        size: payload.size,
        timestamp: Date.now(),
        error: 'partial_fill_pending',
      };
    }
    await clearPartialLock();
  }

  // 1) build
  const resolvedIntent = resolveIntent(payload, ctx);
  const payloadWithIntent = resolvedIntent ? { ...payload, intent: resolvedIntent } : payload;
  let order = buildOrder(payloadWithIntent, ctx);

  // 1.5) risk allocation （任意・非活性フラグ付き）
  try {
    const ra = applyRiskAllocation(order, ctx);
    if (ra && ra.changed === true && ra.order) {
      order = ra.order;
      try {
        console.warn(`[RISK_ALLOCATION] adjusted size due to ${ra.reason || 'unknown'} clientOrderId=${order.clientOrderId}`);
      } catch (_) {}
    }
  } catch (_) {
    // 安全のため：失敗しても注文はそのまま流す（非活性の準備段階）
  }

  if (!isBuiltOrderValid(order)) {
    setSafetyHalt({ code: 'ORDER_BUILD_ERROR', message: 'invalid order after build/risk-allocation' });
    return {
      orderId: '',
      status: 'error',
      side: safeResultSide(payload),
      price: safeResultPrice(payload),
      size: payload && typeof payload.size === 'number' ? payload.size : 0,
      timestamp: Date.now(),
      error: 'invalid order',
    };
  }

  // Idempotent: clientOrderId をキーにして二重送信禁止
  const key = order && order.clientOrderId ? String(order.clientOrderId) : makeKey(payload);
  let claimed = false;
  try {
    claimed = await claimProcessedKey(key);
  } catch (persistErr) {
    setSafetyHalt({ code: 'DEDUP_PERSIST_ERROR', message: persistErr?.message || 'dedup persist failed' });
    return {
      orderId: '',
      status: 'error',
      side: safeResultSide(payload),
      price: safeResultPrice(payload),
      size: payload.size,
      timestamp: Date.now(),
      error: 'dedup persist failed',
    };
  }
  if (!claimed) {
    // B-1: decisionId/ClientOrder重複の明示ログ（なぜ発注しないかをログだけで説明）
    try {
      // 可能ならdecisionIdとkeyを出力
      const decisionId = payload && typeof payload.decisionId === 'string' ? payload.decisionId : 'unknown';
      console.warn(`[EXECUTOR_GUARD] duplicate_decision reject decisionId=${decisionId} key=${key}`);
    } catch (_) {}
    return {
      orderId: '',
      status: 'expired',
      side: safeResultSide(payload),
      price: safeResultPrice(payload),
      size: payload.size,
      timestamp: Date.now(),
    };
  }

  // 2) sign
  let signResult;
  try {
    signResult = await signOrder(order, ctx);
  } catch (signErr) {
    setSafetyHalt({ code: 'SIGN_ERROR', message: signErr.message || 'sign failed' });
    return {
      orderId: '',
      status: 'error',
      side: payload.side,
      price: typeof payload.price === 'number' ? payload.price : payload.market.mid,
      size: payload.size,
      timestamp: Date.now(),
      error: 'sign failed',
    };
  }

  // ctx に lastOrder と signResult を残して confirm/result 用に引き渡す
  const strength = payload?.strength ?? {};
  const appliedFirepowerRank = strength?.firepower?.rank ?? null;
  const appliedFirepowerFactor = strength?.firepower?.factor ?? null;
  
  const localCtx = { 
    ...ctx, 
    decisionId: payload.decisionId ?? 'unknown',
    entryTs: payload.entryTs ?? Date.now(),
    appliedFirepowerRank,
    appliedFirepowerFactor,
    lastOrder: { side: order.side, price: order.price, size: order.size },
    signResult,
    market: payload.market, // coin 情報を追加（Live モードのガードチェック用）
  };

  // 3) send（最大3回リトライは send 側に実装済み）
  const apiResponse = await sendOrder(order, localCtx);

  // API 異常：3回失敗時
  if (!apiResponse || apiResponse.ok !== true) {
    setSafetyHalt({ code: apiResponse && apiResponse.error && apiResponse.error.code ? apiResponse.error.code : 'API_ERROR', message: apiResponse && apiResponse.error && apiResponse.error.message ? apiResponse.error.message : 'send failed' });
  }

  // 4) confirm
  const result = confirmOrder(apiResponse, localCtx);

  // 署名情報を OrderResult に追加（UI/Poster 用）
  result.signature = signResult.signature;
  result.nonce = signResult.nonce;
  result.agentAddress = signResult.agentAddress;

   // Partial fill 状態を永続ロックに保存（一定時間新規送信を抑止）
  try {
    if (result.status === 'partial') {
      await setPartialLock({
        orderId: result.orderId || 'unknown',
        remainingSize: typeof result.remainingSize === 'number' ? result.remainingSize : Math.max(0, (payload.size ?? 0) - (result.filledSize ?? 0)),
        side: result.side,
        price: result.price,
        ts: Date.now(),
      });
    } else {
      await clearPartialLock();
    }
  } catch (lockErr) {
    setSafetyHalt({ code: 'PARTIAL_LOCK_ERROR', message: lockErr?.message || 'partial lock failed' });
    return {
      orderId: result.orderId || '',
      status: 'error',
      side: result.side,
      price: result.price,
      size: result.size,
      timestamp: Date.now(),
      error: 'partial lock failed',
    };
  }

  // SafetyState 更新（情報保持）
  if (result.status === 'error') {
    safetyState.lastError = { code: 'ORDER_ERROR', message: result.error || 'order error' };
    safetyState.lastUpdated = Date.now();
  } else {
    safetyState.lastError = undefined;
    safetyState.lastUpdated = Date.now();
  }

  // LIVE残高同期フック（任意提供）
  if (ctx.mode === 'live' && typeof ctx.syncBalance === 'function') {
    try {
      await ctx.syncBalance({ result, payload });
    } catch (balanceErr) {
      setSafetyHalt({ code: 'BALANCE_SYNC_ERROR', message: balanceErr?.message || 'balance sync failed' });
      return {
        orderId: result.orderId || '',
        status: 'error',
        side: result.side,
        price: result.price,
        size: result.size,
        timestamp: Date.now(),
        error: 'balance sync failed',
      };
    }
  }

  // Safety Halt 中に保有があるなら Close 注文（最小構成のため実装ダミー）
  // 仕様に基づく「可能であれば」の範囲で、ここでは TODO に留める。

  return result;
}

function getSafetyState() { return safetyState; }
function resetSafetyState() { safetyState = { mode: 'normal', lastError: undefined, lastUpdated: Date.now() }; }

export { handle, getSafetyState, resetSafetyState };
