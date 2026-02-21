import fs from 'fs';
import path from 'path';
import { resolveTradesPath } from '../config/tradesPath.js';

const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUP_MAX_SIZE = 5000;
const dedupCache = new Map();
const VALID_REGIMES = new Set(['UP', 'DOWN', 'RANGE', 'UNKNOWN']);

function normalizeRegime(value) {
  const regime = String(value ?? 'UNKNOWN').toUpperCase();
  return VALID_REGIMES.has(regime) ? regime : 'UNKNOWN';
}

function deriveMarketState(record, normalizedRegime) {
  const current = String(record?.marketState ?? '').toUpperCase();
  if (current && current !== 'UNKNOWN' && current !== 'NA') return current;
  if (normalizedRegime === 'UP') return 'TREND_UP';
  if (normalizedRegime === 'DOWN') return 'TREND_DOWN';
  if (normalizedRegime === 'RANGE') return 'RANGE';
  return 'UNKNOWN';
}

function isFiniteField(record, key) {
  const n = Number(record?.[key]);
  return Number.isFinite(n);
}

function isNonEmptyField(record, key) {
  const v = record?.[key];
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function collectMissingFields(record) {
  const requiredNumeric = ['entryPrice', 'exitPrice', 'size', 'notional', 'realizedPnlNetUsd'];
  const requiredText = ['side', 'exitReason', 'marketRegime', 'marketState'];
  const missing = [];
  for (const key of requiredNumeric) {
    if (!isFiniteField(record, key)) missing.push(key);
  }
  for (const key of requiredText) {
    if (!isNonEmptyField(record, key)) missing.push(key);
  }
  return { missing, total: requiredNumeric.length + requiredText.length };
}

function enrichTradeRecord(record) {
  const out = { ...record };
  const normalizedRegime = normalizeRegime(out.marketRegime);
  out.marketRegime = normalizedRegime;
  out.marketState = deriveMarketState(out, normalizedRegime);
  const { missing, total } = collectMissingFields(out);
  out.logMissingFields = missing;
  out.logCompleteness = Math.max(0, Math.min(1, (total - missing.length) / total));
  out.logQuality = missing.length === 0 ? 'ok' : 'partial';
  out.logSchemaVersion = 2;
  return out;
}

function getRecordKey(record) {
  const normalizeNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(8) : 'na';
  };
  const ts = record?.timestampExit ?? record?.closedAt ?? record?.timestamp ?? record?.ts ?? 'na';
  const entryTs = record?.timestampEntry ?? record?.entryTs ?? 'na';
  const side = record?.side ?? record?.positionSide ?? record?.signal ?? 'na';
  const entryPx = normalizeNum(record?.entryPrice ?? record?.entryPx);
  const exitPx = normalizeNum(record?.exitPrice ?? record?.exitPx);
  const size = normalizeNum(record?.size);
  // semantic key 優先: tradeId が毎回異なる重複でも弾けるようにする
  if (ts !== 'na' || entryTs !== 'na') {
    return `semantic:${ts}:${entryTs}:${side}:${entryPx}:${exitPx}:${size}`;
  }
  if (record?.tradeId) return `tradeId:${record.tradeId}`;
  return `fallback:${side}:${entryPx}:${exitPx}:${size}`;
}

function isDuplicateRecord(record, now) {
  const key = getRecordKey(record);
  const lastSeen = dedupCache.get(key);
  if (lastSeen && now - lastSeen < DEDUP_TTL_MS) {
    return true;
  }
  dedupCache.set(key, now);
  if (dedupCache.size > DEDUP_MAX_SIZE) {
    for (const [k, v] of dedupCache) {
      if (now - v >= DEDUP_TTL_MS) dedupCache.delete(k);
    }
    if (dedupCache.size > DEDUP_MAX_SIZE) {
      const over = dedupCache.size - DEDUP_MAX_SIZE;
      let removed = 0;
      for (const k of dedupCache.keys()) {
        dedupCache.delete(k);
        removed += 1;
        if (removed >= over) break;
      }
    }
  }
  return false;
}

function appendTradeLog(record, onDone) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      if (typeof onDone === 'function') onDone(null);
      return;
    }
    const enrichedRecord = enrichTradeRecord(record);
    const now = Date.now();
    if (isDuplicateRecord(enrichedRecord, now)) {
      if (typeof onDone === 'function') onDone(null);
      return;
    }
    const logPath = resolveTradesPath(process.env.MODE, process.env.LOG_TRADES_PATH);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify(enrichedRecord);
    if (!line || line.trim().startsWith('[')) {
      if (typeof onDone === 'function') onDone(null);
      return;
    }
    fs.appendFile(logPath, `${line}\n`, (err) => {
      if (typeof onDone === 'function') onDone(err || null);
    });
  } catch (err) {
    // ログ失敗は致命でないため握りつぶす
    if (typeof onDone === 'function') onDone(err);
  }
}

export { appendTradeLog, enrichTradeRecord };
