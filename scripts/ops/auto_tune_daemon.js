#!/usr/bin/env node
import 'dotenv/config';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const TUNE_SCRIPT = path.join(ROOT, 'scripts', 'ops', 'auto_tune_from_logs.js');

function toNumber(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function buildArgs() {
  const adaptive = boolEnv('HLB_TUNE_ADAPTIVE', true);
  const args = [TUNE_SCRIPT, '--apply'];
  if (adaptive) args.push('--adaptive');
  const input = String(process.env.HLB_TUNE_INPUT ?? '').trim();
  if (input) args.push('--input', input);

  const minSamples = toNumber(process.env.HLB_TUNE_MIN_SAMPLES);
  if (minSamples != null) args.push('--min-samples', String(Math.max(10, Math.floor(minSamples))));

  const maxChangeRatio = toNumber(process.env.HLB_TUNE_MAX_CHANGE_RATIO);
  if (maxChangeRatio != null) args.push('--max-change-ratio', String(Math.max(0.01, maxChangeRatio)));

  const windowMin = toNumber(process.env.HLB_TUNE_WINDOW_MIN);
  if (windowMin != null) args.push('--window-min', String(Math.max(30, Math.floor(windowMin))));

  const regime = String(process.env.HLB_TUNE_REGIME ?? '').trim();
  if (regime) args.push('--regime', regime);
  return args;
}

function runTune(logPrefix) {
  const args = buildArgs();
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit'
  });
  if ((res.status ?? 1) !== 0) {
    console.error(`${logPrefix} tune failed (exit=${res.status ?? 'unknown'})`);
    return false;
  }
  console.log(`${logPrefix} tune applied`);
  return true;
}

function main() {
  if (!fs.existsSync(TUNE_SCRIPT)) {
    console.error(`[auto-tune-daemon] missing script: ${TUNE_SCRIPT}`);
    process.exit(1);
  }

  const intervalMinRaw = toNumber(process.env.HLB_TUNE_INTERVAL_MIN, 30);
  const intervalMin = Math.max(10, Math.floor(intervalMinRaw));
  const intervalMs = intervalMin * 60 * 1000;
  const runAtBoot = boolEnv('HLB_TUNE_DAEMON_RUN_AT_BOOT', true);
  const logPrefix = '[auto-tune-daemon]';

  console.log(`${logPrefix} started interval=${intervalMin}m`);
  if (runAtBoot) runTune(logPrefix);

  const timer = setInterval(() => {
    runTune(logPrefix);
  }, intervalMs);

  const shutdown = sig => {
    clearInterval(timer);
    console.log(`${logPrefix} stopping (${sig})`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
