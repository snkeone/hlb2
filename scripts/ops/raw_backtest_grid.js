#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
  const out = {
    input: [],
    profiles: path.resolve(process.cwd(), 'scripts/ops/raw_backtest_profiles.example.json'),
    outDir: null
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (a === '--input') {
      const v = String(argv[i + 1] || '');
      i += 1;
      out.input = v.split(',').map((x) => x.trim()).filter(Boolean);
    } else if (a === '--profiles') {
      out.profiles = path.resolve(process.cwd(), String(argv[i + 1] || ''));
      i += 1;
    } else if (a === '--out-dir') {
      out.outDir = path.resolve(process.cwd(), String(argv[i + 1] || ''));
      i += 1;
    }
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}${m}${dd}-${hh}${mm}${ss}`;
}

function requireInputFiles(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('missing --input raw-*.jsonl(.gz) path(s)');
  }
  for (const p of inputs) {
    if (!fs.existsSync(p)) throw new Error(`input not found: ${p}`);
  }
}

function readProfiles(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`profiles file not found: ${filePath}`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(raw?.profiles) || raw.profiles.length === 0) {
    throw new Error('profiles file must include non-empty "profiles" array');
  }
  return raw.profiles;
}

function runRawBacktest(cwd, params) {
  const script = path.resolve(cwd, 'scripts/ops/raw_log_backtest.js');
  const args = [script, '--input', params.input.join(','), '--out-dir', params.outDir];
  if (Number.isFinite(params.sampleMs)) args.push('--sample-ms', String(Math.floor(params.sampleMs)));
  if (Number.isFinite(params.maxDistanceUsd)) args.push('--max-distance-usd', String(params.maxDistanceUsd));
  if (Number.isFinite(params.minCount)) args.push('--min-count', String(Math.floor(params.minCount)));
  if (Number.isFinite(params.minCountFinal)) args.push('--min-count-final', String(Math.floor(params.minCountFinal)));

  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
  return r.status === 0;
}

function loadJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function scoreRow(row) {
  // Reject/hold を優先して低く、watch/adopt を高くする簡易スコア
  const adopt = toNumber(row.adoptCandidates, 0);
  const watch = toNumber(row.watchlist, 0);
  const reject = toNumber(row.rejected, 0);
  const hold = toNumber(row.holdSample, 0);
  const groups = Math.max(1, toNumber(row.groupsEvaluated, 1));
  return (adopt * 3 + watch * 1 - reject * 0.25 - hold * 0.1) / groups;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return `${[keys.join(',')].concat(rows.map((r) => keys.map((k) => esc(r[k])).join(','))).join('\n')}\n`;
}

function main() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv);
  requireInputFiles(args.input);
  const profiles = readProfiles(args.profiles);

  const rootOutDir = args.outDir || path.resolve(cwd, 'data', 'validation', `raw-grid-${nowStamp()}`);
  fs.mkdirSync(rootOutDir, { recursive: true });

  const rows = [];
  for (const [idx, p] of profiles.entries()) {
    const name = String(p?.name || `profile_${idx + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const runDir = path.join(rootOutDir, name);
    fs.mkdirSync(runDir, { recursive: true });
    process.stdout.write(`\n[raw-grid] (${idx + 1}/${profiles.length}) ${name}\n`);

    const ok = runRawBacktest(cwd, {
      input: args.input,
      outDir: runDir,
      sampleMs: toNumber(p.sampleMs, null),
      maxDistanceUsd: toNumber(p.maxDistanceUsd, null),
      minCount: toNumber(p.minCount, 300),
      minCountFinal: toNumber(p.minCountFinal, 1000)
    });

    const judgement = loadJsonIfExists(path.join(runDir, 'validation_judgement.json'), {});
    const summary = judgement?.summary?.totals || {};
    const row = {
      name,
      ok,
      runDir,
      sampleMs: toNumber(p.sampleMs, null),
      maxDistanceUsd: toNumber(p.maxDistanceUsd, null),
      minCount: toNumber(p.minCount, 300),
      minCountFinal: toNumber(p.minCountFinal, 1000),
      groupsEvaluated: toNumber(summary.groupsEvaluated, 0),
      adoptCandidates: toNumber(summary.adoptCandidates, 0),
      watchlist: toNumber(summary.watchlist, 0),
      rejected: toNumber(summary.rejected, 0),
      holdSample: toNumber(summary.holdSample, 0)
    };
    row.score = Number(scoreRow(row).toFixed(6));
    rows.push(row);
  }

  rows.sort((a, b) => b.score - a.score);
  const report = {
    generatedAt: new Date().toISOString(),
    input: args.input,
    profilesFile: args.profiles,
    outDir: rootOutDir,
    totalProfiles: rows.length,
    best: rows[0] || null,
    leaderboard: rows
  };

  const reportJson = path.join(rootOutDir, 'grid_report.json');
  const reportCsv = path.join(rootOutDir, 'grid_report.csv');
  fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportCsv, toCsv(rows), 'utf8');
  process.stdout.write(`\n[raw-grid] report: ${reportJson}\n`);
}

try {
  main();
} catch (err) {
  console.error(`[raw-grid] ${err.message}`);
  process.exit(1);
}

