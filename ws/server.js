// ws/server.js
// ランチャー: モード決定 → Registry解決 → 実体起動 → 起動結果送信

// Load environment variables from .env (must be first)
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logShutdown, calculateSessionStats, processStartTime } from '../core/shutdownLogger.js';
import { getDecisionTraceSnapshot } from '../core/decisionTraceCache.js';
import { resolveTradesPath } from '../config/tradesPath.js';

// .env ファイルをロード（signer_adapter から HL_USER_ADDR を取得するため）
const loadEnvFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').trim();
          if (key && value && !process.env[key]) {
            process.env[key] = value;
          }
        }
      });
    }
  } catch (err) {
    console.error('[ENV] .env load failed:', err.message);
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// .env をロード（signer_adapter → ROOTの順）
loadEnvFile(path.join(ROOT, 'signer_adapter', '.env'));
loadEnvFile(path.join(ROOT, '.env'));

const CRASH_LOG_PATH = path.join(ROOT, 'logs', 'crash.log');
const CRASH_SPAM_INTERVAL_MS = 60000;
let lastCrashKey = null;
let lastCrashAt = 0;

function buildCrashKey(reason, message, stack) {
  const head = typeof stack === 'string' ? stack.split('\n')[0] : '';
  return `${reason}|${message}|${head}`;
}

// Fatal event logging (process exit reason tracking)
function logFatal(msg, err) {
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      type: 'process_exit',
      reason: msg,
      error: err ? String(err.stack || err) : null
    });
    fs.appendFileSync('logs/fatal.jsonl', line + '\n');
  } catch (_) {
    // ログすら書けない場合は何もしない
  }
}

function writeCrashLog(reason, err, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG_PATH), { recursive: true });
    const decisionTrace = getDecisionTraceSnapshot();
    const ts = Date.now();
    const uptimeMs = ts - processStartTime;
    const uptimeHours = Number((uptimeMs / (1000 * 60 * 60)).toFixed(2));
    const message = err?.message || String(err);
    const stack = err?.stack || null;
    const key = buildCrashKey(reason, message, stack);
    if (lastCrashKey === key && (ts - lastCrashAt) < CRASH_SPAM_INTERVAL_MS) {
      return;
    }
    lastCrashKey = key;
    lastCrashAt = ts;
    const payload = {
      ts,
      type: 'crash',
      reason,
      message,
      stack,
      decision_trace: decisionTrace,
      uptime_ms: uptimeMs,
      uptime_hours: uptimeHours,
      env: {
        NODE_VERSION: process.version,
        TEST_MODE: process.env.TEST_MODE,
        MODE: process.env.MODE,
        LOGIC_ONLY: process.env.LOGIC_ONLY,
        HL_ENABLE: process.env.HL_ENABLE,
      },
      ...extra,
    };
    fs.appendFileSync(CRASH_LOG_PATH, JSON.stringify(payload) + '\n');

    const markersPath = path.join(ROOT, 'logs', 'markers.jsonl');
    const markerPayload = {
      ts: payload.ts,
      type: 'crash',
      reason: payload.reason,
      message: payload.message,
      stack: payload.stack,
      decision_trace: decisionTrace,
      uptime_ms: payload.uptime_ms,
      uptime_hours: payload.uptime_hours,
      env: payload.env
    };
    fs.appendFileSync(markersPath, JSON.stringify(markerPayload) + '\n');
  } catch (writeErr) {
    console.error('[CRASH] Failed to write crash.log:', writeErr);
    console.error('[CRASH] Original error:', err);
  }
}

/**
 * graceful shutdown ハンドラー
 */
function handleShutdown(reason) {
  try {
    const uptimeMs = Date.now() - processStartTime;
    
    // trades.jsonl からセッション統計を計算
    const tradesPath = resolveTradesPath(process.env.MODE, process.env.LOG_TRADES_PATH);
    
    const stats = calculateSessionStats(tradesPath);
    
    // markers.jsonl に shutdown を記録
    logShutdown(reason, uptimeMs, stats);
    
    // 古い fatal.jsonl にも記録（互換性）
    logFatal(reason);
  } catch (err) {
    console.error('[SHUTDOWN] handleShutdown error:', err);
    logFatal(reason);
  }
}

process.on('SIGTERM', () => {
  handleShutdown('SIGTERM');
  process.exit(0);
});

process.on('SIGHUP', () => {
  handleShutdown('SIGHUP');
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  writeCrashLog('uncaughtException', err);
  
  // LINE alert (異常検知専用)
  try {
    const { sendLineAlert } = await import('../engine/lineNotify.js');
    await sendLineAlert({
      type: 'UNHANDLED_EXCEPTION',
      message: `Uncaught exception: ${err.message}`,
      action: 'プロセス停止'
    });
  } catch (alertErr) {
    console.error('[ALERT] Failed to send LINE alert:', alertErr.message);
  }
  
  handleShutdown('uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', async (err, promise) => {
  writeCrashLog('unhandledRejection', err, { promise: String(promise) });
  
  // LINE alert (異常検知専用)
  try {
    const { sendLineAlert } = await import('../engine/lineNotify.js');
    await sendLineAlert({
      type: 'UNHANDLED_EXCEPTION',
      message: `Unhandled rejection: ${err?.message ?? String(err)}`,
      action: 'プロセス停止'
    });
  } catch (alertErr) {
    console.error('[ALERT] Failed to send LINE alert:', alertErr.message);
  }
  
  handleShutdown('unhandledRejection');
  process.exit(1);
});

import { buildRegistryReport, resolveMode } from './core/registry.js';

const hlEnabled =
  (process.env.HL_ENABLE ?? '1').toLowerCase() !== '0' &&
  (process.env.HL_ENABLE ?? '1').toLowerCase() !== 'false';
const mode = resolveMode(process.env.MODE ?? process.env.APP_MODE ?? '', hlEnabled);
const registryReport = buildRegistryReport(mode, hlEnabled);

// 起動時環境情報ログ（観測用）
console.log(JSON.stringify({
  ts: Date.now(),
  type: 'startup',
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  env: {
    TEST_MODE: process.env.TEST_MODE,
    MODE: process.env.MODE,
    LOGIC_ONLY: process.env.LOGIC_ONLY,
    DRY_RUN: process.env.DRY_RUN,
    HL_ENABLE: process.env.HL_ENABLE,
    LOG_TRADES_PATH: process.env.LOG_TRADES_PATH,
    DASHBOARD_LOG_TRADES_PATH: process.env.DASHBOARD_LOG_TRADES_PATH,
  }
}));

try {
  const { startRuntime } = await import('./runtime.js');
  await startRuntime({ mode, hlEnabled, registryReport });
} catch (err) {
  console.error('[LAUNCHER] runtime failed to start', err);
  process.exitCode = 1;
}
