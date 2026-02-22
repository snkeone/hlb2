#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import minimist from 'minimist';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = minimist(argv, {
    boolean: ['strict', 'json'],
    default: {
      strict: false,
      json: false,
    },
  });
  return {
    strict: args.strict === true,
    json: args.json === true,
  };
}

function envBool(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parseDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function pushCheck(checks, level, id, detail) {
  checks.push({ level, id, detail });
}

function isTestPath(p) {
  return String(p).includes('test-logs');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];
  const strict = args.strict;

  const mode = String(process.env.MODE ?? '').trim().toLowerCase() || 'test';
  const testMode = String(process.env.TEST_MODE ?? '').trim() || (mode === 'live' ? '0' : '1');
  const dryRun = envBool('DRY_RUN', false);
  const hlEnable = !['0', 'false'].includes(String(process.env.HL_ENABLE ?? '1').trim().toLowerCase());
  const signerUrl = String(process.env.SIGNER_ADAPTER_URL ?? 'http://localhost:8000').trim();
  const hlMainnet = envBool('HL_MAINNET', true);
  const liveSendEnabled = mode === 'live' && testMode !== '1' && !dryRun;
  const logTradesPathRaw = String(process.env.LOG_TRADES_PATH ?? '').trim();
  const logTradesPath = logTradesPathRaw
    ? path.resolve(ROOT, logTradesPathRaw)
    : path.resolve(ROOT, mode === 'live' && testMode !== '1' ? 'logs/trades.jsonl' : 'test-logs/trades.jsonl');

  if (mode !== 'live') pushCheck(checks, strict ? 'fail' : 'warn', 'mode_not_live', `MODE=${mode} (expected live)`);
  else pushCheck(checks, 'pass', 'mode_live', `MODE=${mode}`);

  if (testMode === '1') pushCheck(checks, strict ? 'fail' : 'warn', 'test_mode_enabled', 'TEST_MODE=1 (live routing disabled)');
  else pushCheck(checks, 'pass', 'test_mode_off', `TEST_MODE=${testMode || '0'}`);

  if (!hlEnable) pushCheck(checks, strict ? 'fail' : 'warn', 'hl_disabled', 'HL_ENABLE=0');
  else pushCheck(checks, 'pass', 'hl_enabled', 'HL_ENABLE=1');

  if (isTestPath(logTradesPath)) {
    pushCheck(checks, strict ? 'fail' : 'warn', 'trades_path_test', `LOG_TRADES_PATH points test route: ${logTradesPath}`);
  } else {
    pushCheck(checks, 'pass', 'trades_path_live', `trades path: ${logTradesPath}`);
  }

  const signerEnv = parseDotenvFile(path.join(ROOT, 'signer_adapter', '.env'));
  const signerHasKey = Boolean(String(process.env.PRIVATE_KEY ?? signerEnv.PRIVATE_KEY ?? '').trim());
  if (!signerHasKey) {
    pushCheck(checks, strict || liveSendEnabled ? 'fail' : 'warn', 'signer_key_missing', 'PRIVATE_KEY is not set (signer_adapter/.env or env)');
  } else {
    pushCheck(checks, 'pass', 'signer_key_exists', 'PRIVATE_KEY detected');
  }

  const signerMainnetRaw = String(signerEnv.HL_MAINNET ?? process.env.HL_MAINNET ?? 'true').trim().toLowerCase();
  const signerMainnet = signerMainnetRaw === 'true' || signerMainnetRaw === '1';
  if (hlMainnet !== signerMainnet) {
    pushCheck(checks, strict ? 'fail' : 'warn', 'hl_mainnet_mismatch', `executor(HL_MAINNET=${hlMainnet}) != signer(HL_MAINNET=${signerMainnet})`);
  } else {
    pushCheck(checks, 'pass', 'hl_mainnet_match', `HL_MAINNET=${hlMainnet}`);
  }

  try {
    const health = await axios.get(`${signerUrl.replace(/\/$/, '')}/health`, { timeout: 1200 });
    if (health?.data?.status === 'ok') {
      pushCheck(checks, 'pass', 'signer_health_ok', `SignerAdapter healthy at ${signerUrl}`);
    } else {
      pushCheck(checks, strict || liveSendEnabled ? 'fail' : 'warn', 'signer_health_bad', `SignerAdapter unhealthy response at ${signerUrl}`);
    }
  } catch (err) {
    pushCheck(checks, strict || liveSendEnabled ? 'fail' : 'warn', 'signer_unreachable', `SignerAdapter unreachable at ${signerUrl}: ${err?.message ?? err}`);
  }

  const requiredFiles = [
    path.join(ROOT, 'config', 'trade.json'),
    path.join(ROOT, 'config', 'capital.json'),
    path.join(ROOT, 'config', 'equity.json'),
    path.join(ROOT, 'scripts', 'ops', 'ws_progress_report.js'),
  ];
  for (const f of requiredFiles) {
    if (!fs.existsSync(f)) pushCheck(checks, strict ? 'fail' : 'warn', 'missing_file', `missing: ${path.relative(ROOT, f)}`);
  }
  if (checks.find(c => c.id === 'missing_file') == null) {
    pushCheck(checks, 'pass', 'required_files_ok', 'required config/scripts exist');
  }

  const passCount = checks.filter(c => c.level === 'pass').length;
  const warnCount = checks.filter(c => c.level === 'warn').length;
  const failCount = checks.filter(c => c.level === 'fail').length;
  const ok = failCount === 0;

  const summary = {
    ok,
    strict,
    mode,
    testMode,
    dryRun,
    signerUrl,
    hlMainnet,
    counts: { pass: passCount, warn: warnCount, fail: failCount },
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[live-preflight] ok=${ok} strict=${strict} pass=${passCount} warn=${warnCount} fail=${failCount}`);
    for (const c of checks) {
      console.log(`- [${c.level.toUpperCase()}] ${c.id}: ${c.detail}`);
    }
  }

  process.exit(ok ? 0 : 2);
}

run().catch(err => {
  console.error('[live-preflight] fatal:', err?.message ?? err);
  process.exit(1);
});
