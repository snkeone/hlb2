#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function parseArgs(argv) {
  const out = {
    raw: null,
    logsDir: 'logs',
    outDir: 'logs/ops',
    quantileShort: 0.9,
    quantileMid: 0.85,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? '');
    else if (a === '--logs-dir') out.logsDir = String(argv[++i] ?? out.logsDir);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--q-short') out.quantileShort = Math.max(0.7, Math.min(0.99, toNum(argv[++i], out.quantileShort)));
    else if (a === '--q-mid') out.quantileMid = Math.max(0.7, Math.min(0.99, toNum(argv[++i], out.quantileMid)));
  }

  return out;
}

function listRawFiles(logsDir) {
  const abs = path.resolve(process.cwd(), logsDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((n) => /^raw-\d{8}\.jsonl$/.test(n))
    .sort()
    .map((n) => ({
      date: n.replace(/^raw-(\d{8})\.jsonl$/, '$1'),
      rawPath: path.join(abs, n),
    }));
}

function pickRawTargets(args) {
  if (args.raw) {
    const rawPath = path.resolve(process.cwd(), args.raw);
    const m = path.basename(rawPath).match(/^raw-(\d{8})\.jsonl$/);
    return [{ date: m ? m[1] : 'manual', rawPath }];
  }
  return listRawFiles(args.logsDir);
}

function runScan(scanScriptPath, rawPath, outPath, cfg) {
  const cmdArgs = [
    scanScriptPath,
    '--raw', rawPath,
    '--lead-window-sec', String(cfg.leadWindowSec),
    '--move-window-sec', String(cfg.moveWindowSec),
    '--event-quantile', String(cfg.eventQuantile),
    '--min-gap-sec', String(cfg.minGapSec),
    '--out', outPath,
  ];

  const res = spawnSync('node', cmdArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (res.status !== 0) {
    throw new Error(`scan failed (${cfg.name}): ${res.stderr || res.stdout || 'unknown error'}`);
  }

  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  return out;
}

function summarizeReport(report, horizonName) {
  const top = Array.isArray(report?.leadSignalsTop) ? report.leadSignalsTop.slice(0, 5) : [];
  const topCompact = top.map((x) => ({
    feature: x.feature,
    lift: x.repeatabilityLift,
    direction: x.direction,
  }));

  return {
    horizon: horizonName,
    sample: report?.sample ?? null,
    moveBpsThreshold: report?.config?.moveBpsThreshold ?? null,
    topSignals: topCompact,
    composite2of3: report?.compositeSignals?.match2of3 ?? null,
    composite3of3: report?.compositeSignals?.match3of3 ?? null,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const scanScriptPath = path.resolve(process.cwd(), 'scripts/research/ws_lead_indicator_scan.js');
  if (!fs.existsSync(scanScriptPath)) {
    console.error('[ws_lead_multi_horizon_run] scanner not found');
    process.exit(1);
  }

  const targets = pickRawTargets(args);
  if (targets.length === 0) {
    console.error('[ws_lead_multi_horizon_run] no raw files found');
    process.exit(1);
  }

  const outDir = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const horizons = [
    {
      name: 'short',
      leadWindowSec: 20,
      moveWindowSec: 30,
      eventQuantile: args.quantileShort,
      minGapSec: 30,
    },
    {
      name: 'mid',
      leadWindowSec: 90,
      moveWindowSec: 120,
      eventQuantile: args.quantileMid,
      minGapSec: 120,
    },
  ];

  const runs = [];

  for (const target of targets) {
    const dayResult = {
      date: target.date,
      rawPath: target.rawPath,
      horizons: [],
    };

    for (const hz of horizons) {
      const outPath = path.join(outDir, `ws_lead_indicator_scan_${hz.name}_${target.date}.json`);
      const report = runScan(scanScriptPath, target.rawPath, outPath, hz);
      dayResult.horizons.push({
        ...summarizeReport(report, hz.name),
        outputPath: outPath,
      });
    }

    runs.push(dayResult);
  }

  const latest = runs[runs.length - 1] ?? null;
  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    horizons,
    runCount: runs.length,
    dates: runs.map((x) => x.date),
    latestDate: latest?.date ?? null,
    latest: latest?.horizons ?? [],
    runs,
    notes: [
      'This is research-only and does not change trading logic.',
      'Use with ws_lead_stability_score.js by prefix:',
      '  short: --prefix ws_lead_indicator_scan_short',
      '  mid:   --prefix ws_lead_indicator_scan_mid',
    ],
  };

  const summaryPath = path.join(outDir, 'ws_lead_multi_horizon_summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const latestCompact = {
    latestDate: summary.latestDate,
    latest: (summary.latest || []).map((h) => ({
      horizon: h.horizon,
      events: h.sample?.events ?? null,
      controls: h.sample?.controls ?? null,
      moveBpsThreshold: h.moveBpsThreshold,
      topSignals: h.topSignals,
      composite2of3Lift: round(toNum(h.composite2of3?.lift, NaN), 4),
      composite3of3Lift: round(toNum(h.composite3of3?.lift, NaN), 4),
    })),
    summaryPath,
  };

  console.log(JSON.stringify(latestCompact, null, 2));
}

main();
