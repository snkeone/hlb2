#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parseArgs(argv) {
  const out = {
    latestDir: 'logs/ops/ws_waveform_pipeline/latest',
    maxAgeHours: 16,
    out: 'logs/ops/ws_waveform_pipeline/health_latest.json',
    history: 'logs/ops/ws_waveform_pipeline/health_history.jsonl',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--latest-dir') out.latestDir = String(argv[++i] ?? out.latestDir);
    else if (a === '--max-age-hours') out.maxAgeHours = Math.max(1, Math.floor(toNum(argv[++i], out.maxAgeHours)));
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--history') out.history = String(argv[++i] ?? out.history);
  }
  return out;
}

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const latestAbs = path.resolve(process.cwd(), args.latestDir);
  const statusPath = path.join(latestAbs, 'status.json');
  const digestPath = path.join(latestAbs, 'ws_waveform_digest_scheduled.json');

  const now = Date.now();
  const status = loadJson(statusPath);
  const digest = loadJson(digestPath);

  const runTs = status?.generatedAt ? Date.parse(status.generatedAt) : NaN;
  const ageHours = Number.isFinite(runTs) ? ((now - runTs) / 3600000) : Infinity;

  const checks = {
    latestDirExists: fs.existsSync(latestAbs),
    statusExists: fs.existsSync(statusPath),
    statusOk: status?.ok === true,
    digestExists: fs.existsSync(digestPath),
    digestOk: digest?.ok === true,
    ageOk: Number.isFinite(ageHours) && ageHours <= args.maxAgeHours,
  };
  const ok = Object.values(checks).every(Boolean);

  const report = {
    ok,
    checkedAt: new Date(now).toISOString(),
    latestDir: latestAbs,
    maxAgeHours: args.maxAgeHours,
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(3)) : null,
    checks,
  };

  const outAbs = path.resolve(process.cwd(), args.out);
  const histAbs = path.resolve(process.cwd(), args.history);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.mkdirSync(path.dirname(histAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.appendFileSync(histAbs, `${JSON.stringify(report)}\n`, 'utf8');

  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main();
