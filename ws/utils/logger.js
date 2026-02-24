/**
 * logger.js (v0.2)
 * Asynchronous JSONL writer with in-memory queue to avoid blocking.
 * Writes to logs/raw-YYYYMMDD.jsonl
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// write to project-root ./logs
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
const MAX_QUEUE = Math.max(1000, Number(process.env.WS_LOGGER_MAX_QUEUE || 5000));
const DROP_WARN_INTERVAL_MS = 60 * 1000;

let queue = [];
let writing = false;
let droppedTotal = 0;
let droppedSinceLastWarn = 0;
let lastDropWarnAt = 0;

function todayFilename() {
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `raw-${y}${m}${dd}.jsonl`);
}

async function ensureLogDir() {
  try {
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function enqueue(event) {
  if (queue.length >= MAX_QUEUE) {
    // drop oldest
    queue.shift();
    droppedTotal += 1;
    droppedSinceLastWarn += 1;
    const now = Date.now();
    if (now - lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
      lastDropWarnAt = now;
      console.warn(`[logger] queue overflow dropped=${droppedSinceLastWarn} totalDropped=${droppedTotal} maxQueue=${MAX_QUEUE}`);
      droppedSinceLastWarn = 0;
    }
  }
  queue.push(event);
}

async function flushQueueOnce() {
  if (writing) return;
  if (queue.length === 0) return;
  writing = true;

  let lines = [];
  while (queue.length) {
    const ev = queue.shift();
    try {
      lines.push(JSON.stringify(ev));
    } catch (e) {
      // skip non-serializable
    }
  }

  try {
    await ensureLogDir();
    await fs.promises.appendFile(todayFilename(), lines.join('\n') + '\n', { encoding: 'utf8' });
  } catch (e) {
    // If write fails, drop data and continue — we intentionally do not block
    console.warn('logger write failed', e && e.message);
  } finally {
    writing = false;
  }
}

// simple background task to flush queue periodically
// ← #5修正: unref() でプロセス終了を妨げない
const flushInterval = setInterval(() => {
  if (queue.length > 0) flushQueueOnce();
}, 250);
if (flushInterval.unref) flushInterval.unref();

async function write(event) {
  // event should be an object; we just enqueue and return
  if (!event || typeof event !== 'object') return Promise.resolve(false);
  enqueue(event);
  // attempt to flush immediately in background
  setImmediate(() => flushQueueOnce());
  return Promise.resolve(true);
}


// TEST結果専用: test-logs/test-results.jsonl へのappend only永続保存（deduplication付き）
const TEST_RESULTS_PATH = path.resolve(__dirname, '..', '..', 'test-logs', 'test-results.jsonl');
const testResultDedupSet = new Set();

/**
 * TEST結果をJSONLで永続保存（重複防止）
 * @param {object} payload - { ts, side, entryPrice, exitPrice, pnl, result }
 */
async function persistTestResult(payload) {
  if (!payload || typeof payload !== 'object') return false;
  // 重複判定キー: ts,side,entryPrice,exitPrice
  const key = [payload.ts, payload.side, payload.entryPrice, payload.exitPrice].join(':');
  if (testResultDedupSet.has(key)) return false;
  testResultDedupSet.add(key);
  try {
    await fs.promises.mkdir(path.dirname(TEST_RESULTS_PATH), { recursive: true });
    await fs.promises.appendFile(
      TEST_RESULTS_PATH,
      JSON.stringify(payload) + '\n',
      { encoding: 'utf8' }
    );
    return true;
  } catch (e) {
    // エラー時はwarnログのみ
    try { console.warn('[TEST-RESULT-LOG] persist failed:', e && e.message); } catch (err) {
      console.error('[TEST-RESULT-LOG] persist log failed', err);
    }
    return false;
  }
}

export { write, persistTestResult, rotateLogs };

// rotateLogs: remove raw-YYYYMMDD.jsonl files older than `keepDays` (default 7)
async function rotateLogs(options = {}) {
  const keepDays = typeof options.keepDays === 'number' ? options.keepDays : 7;
  try {
    // ensure logs directory exists
    await fs.promises.access(LOG_DIR, fs.constants.R_OK | fs.constants.W_OK).catch(() => null);
    const files = await fs.promises.readdir(LOG_DIR).catch(() => []);
    const re = /^raw-(\d{8})\.jsonl$/;
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
    let removed = 0;

    // process sequentially to avoid bursts
    for (const f of files) {
      const m = f.match(re);
      if (!m) continue;
      const ymd = m[1];
      const y = parseInt(ymd.slice(0, 4), 10);
      const mo = parseInt(ymd.slice(4, 6), 10) - 1;
      const d = parseInt(ymd.slice(6, 8), 10);
      const fileDate = new Date(y, mo, d);
      if (isNaN(fileDate)) continue;
      if (fileDate < cutoff) {
        try {
          await fs.promises.unlink(path.join(LOG_DIR, f)).catch(() => {});
          removed += 1;
        } catch (e) {
          // swallow errors
        }
      }
    }

    if (removed > 0) {
      try { console.warn(`log rotation: removed ${removed} old files`); } catch (err) {
        console.error('[LOG ROTATION] warn emit failed', err);
      }
    }
  } catch (e) {
    // never throw — rotation errors are non-fatal
  }
}
