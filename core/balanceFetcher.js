/**
 * balanceFetcher.js
 * Hyperliquid Info API (clearinghouseState) を叩いて Live Equity を取得する。
 * - 署名/APIキー不要（Info系は公開情報）
 * - Perps メインアドレスのみを対象（Spotは合算しない）
 * - TTLキャッシュ: デフォルト60s
 * - 失敗時はキャッシュ→fallback(equity.json)を返し、BOTは止めない
 */

import { getBaseEquityLiveUsd } from '../config/equity.js';

const BALANCE_FETCH_ENABLED = process.env.BALANCE_FETCH_ENABLED === '1';
const INFO_URL = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const USER_ADDR = process.env.HL_USER_ADDR || process.env.HL_ADDRESS || '';
const TTL_MS = Number.parseInt(process.env.BALANCE_FETCH_TTL_MS ?? '60000', 10);

const cache = {
  ts: 0,
  value: null
};

function isCacheValid() {
  return cache.value && (Date.now() - cache.ts) < TTL_MS;
}

function fallbackValue(reason = 'fallback') {
  const fallback = getBaseEquityLiveUsd();
  const equity = Number.isFinite(fallback) ? Number(fallback) : null;
  return {
    equityUsd: equity,
    ts: Date.now(),
    source: 'fallback',
    reason
  };
}

let fetchClient = typeof fetch === 'function' ? fetch : null;

async function getFetch() {
  if (fetchClient) return fetchClient;
  try {
    const mod = await import('node-fetch');
    fetchClient = mod.default || mod;
    return fetchClient;
  } catch (err) {
    throw new Error('fetch is not available and node-fetch could not be loaded');
  }
}

/**
 * Live Equity を取得する（Hyperliquid Perps メインアドレス）
 * @param {Object} opts
 * @param {boolean} [opts.force=false] - trueの場合、TTL無視でAPIを叩く
 * @returns {Promise<{ equityUsd: number|null, ts: number, source: 'live'|'cache'|'fallback', reason?: string }>}
 */
export async function fetchLiveEquity({ force = false } = {}) {
  if (!BALANCE_FETCH_ENABLED) {
    return fallbackValue('disabled');
  }

  if (!force && isCacheValid()) {
    return { ...cache.value, source: 'cache' };
  }

  if (!USER_ADDR) {
    return fallbackValue('missing_user_address');
  }

  try {
    const fetcher = await getFetch();
    const res = await fetcher(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: USER_ADDR })
    });

    if (!res.ok) {
      throw new Error(`info api status ${res.status}`);
    }

    const data = await res.json();
    const equityUsd = Number(
      data?.marginSummary?.accountValue ??
      data?.accountValue ??
      null
    );

    if (!Number.isFinite(equityUsd)) {
      throw new Error('invalid accountValue');
    }

    const value = {
      equityUsd,
      ts: Date.now(),
      source: 'live'
    };
    cache.value = value;
    cache.ts = value.ts;
    return value;
  } catch (err) {
    try {
      console.warn('[balanceFetcher] fetchLiveEquity failed', err?.message || err);
    } catch (_) {}

    if (cache.value) {
      return { ...cache.value, source: 'cache' };
    }

    return fallbackValue('fetch_failed');
  }
}

export function clearBalanceCache() {
  cache.ts = 0;
  cache.value = null;
}
