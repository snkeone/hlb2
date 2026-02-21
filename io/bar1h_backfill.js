const INFO_URL = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveFetch() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

function normalizeCandle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tsRaw =
    raw.t ?? raw.ts ?? raw.time ?? raw.openTime ?? raw.startTime ?? raw.timestamp ?? null;
  const ts = toNumber(tsRaw, null);
  const open = toNumber(raw.o ?? raw.open, null);
  const high = toNumber(raw.h ?? raw.high, null);
  const low = toNumber(raw.l ?? raw.low, null);
  const close = toNumber(raw.c ?? raw.close, null);
  if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }
  if (high < low) return null;
  return {
    tsStart: Math.floor(ts),
    open,
    high,
    low,
    close,
    source: 'backfill_api'
  };
}

function extractCandles(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candles)) return payload.candles;
  if (Array.isArray(payload.snapshot)) return payload.snapshot;
  if (Array.isArray(payload.result)) return payload.result;
  if (payload.response && Array.isArray(payload.response.data)) return payload.response.data;
  return [];
}

function buildBackoffMs(attempt) {
  const clamped = Math.max(1, Math.min(8, attempt));
  const base = 5000;
  return Math.min(5 * 60 * 1000, base * (2 ** (clamped - 1)));
}

export async function fetchBar1hBackfill({
  coin = 'BTC',
  neededBars = 26,
  timeoutMs = 6000
} = {}) {
  const fetcher = resolveFetch();
  if (!fetcher) {
    return {
      ok: false,
      error: 'fetch_unavailable',
      candles: [],
      retryAfterMs: buildBackoffMs(1)
    };
  }

  const barsToRequest = Math.max(neededBars + 6, Number(process.env.BAR1H_BACKFILL_BARS || 64));
  const now = Date.now();
  const startTime = now - (barsToRequest * 60 * 60 * 1000);

  const body = {
    type: 'candleSnapshot',
    req: {
      coin,
      interval: '1h',
      startTime,
      endTime: now
    }
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetcher(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    const retryAfterHeader = response.headers?.get?.('retry-after');
    const retryAfterSec = toNumber(retryAfterHeader, null);

    if (!response.ok) {
      return {
        ok: false,
        error: `http_${response.status}`,
        candles: [],
        retryAfterMs: Number.isFinite(retryAfterSec) ? Math.max(1000, retryAfterSec * 1000) : null
      };
    }

    const json = await response.json();
    const rawCandles = extractCandles(json);
    const normalized = rawCandles
      .map(normalizeCandle)
      .filter(Boolean)
      .sort((a, b) => a.tsStart - b.tsStart);

    const dedup = [];
    let prevTs = null;
    for (const c of normalized) {
      if (c.tsStart === prevTs) continue;
      dedup.push(c);
      prevTs = c.tsStart;
    }

    return {
      ok: dedup.length > 0,
      error: dedup.length > 0 ? null : 'empty_candles',
      candles: dedup,
      retryAfterMs: Number.isFinite(retryAfterSec) ? Math.max(1000, retryAfterSec * 1000) : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'fetch_failed'),
      candles: [],
      retryAfterMs: null
    };
  } finally {
    clearTimeout(timer);
  }
}

export function nextBackfillDelayMs({ attempt = 1, retryAfterMs = null, success = false, stillInsufficient = false } = {}) {
  if (success && !stillInsufficient) {
    return 10 * 60 * 1000;
  }
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }
  return buildBackoffMs(attempt);
}
