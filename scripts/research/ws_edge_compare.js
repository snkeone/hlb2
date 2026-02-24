#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 6) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function parseArgs(argv) {
  const out = {
    raw: null,
    logsDir: 'logs',
    outDir: 'logs/ops/ws_edge_compare',
    leadWindowSec: 20,
    horizonSec: 10,
    sampleSec: 5,
    moveBps: 5,
    trainDays: 20,
    testDays: 5,
    feeBps: 0,
    slippageBps: 0,
    minCoverage: 0.02,
    minOosFoldRate: 0.5,
    maxSamplesPerDay: 0,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? out.raw);
    else if (a === '--logs-dir') out.logsDir = String(argv[++i] ?? out.logsDir);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--lead-window-sec') out.leadWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.leadWindowSec)));
    else if (a === '--horizon-sec') out.horizonSec = Math.max(1, Math.floor(toNum(argv[++i], out.horizonSec)));
    else if (a === '--sample-sec') out.sampleSec = Math.max(1, Math.floor(toNum(argv[++i], out.sampleSec)));
    else if (a === '--move-bps') out.moveBps = Math.max(0.1, toNum(argv[++i], out.moveBps));
    else if (a === '--train-days') out.trainDays = Math.max(1, Math.floor(toNum(argv[++i], out.trainDays)));
    else if (a === '--test-days') out.testDays = Math.max(1, Math.floor(toNum(argv[++i], out.testDays)));
    else if (a === '--fee-bps') out.feeBps = Math.max(0, toNum(argv[++i], out.feeBps));
    else if (a === '--slippage-bps') out.slippageBps = Math.max(0, toNum(argv[++i], out.slippageBps));
    else if (a === '--min-coverage') out.minCoverage = Math.max(0, toNum(argv[++i], out.minCoverage));
    else if (a === '--min-oos-fold-rate') out.minOosFoldRate = Math.max(0, Math.min(1, toNum(argv[++i], out.minOosFoldRate)));
    else if (a === '--max-samples-per-day') out.maxSamplesPerDay = Math.max(0, Math.floor(toNum(argv[++i], out.maxSamplesPerDay)));
  }

  return out;
}

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [keys.join(',')];
  for (const r of rows) lines.push(keys.map((k) => esc(r[k])).join(','));
  return `${lines.join('\n')}\n`;
}

const CANDIDATES = [
  {
    name: 'spread_trade',
    xSpec: 'avgSpreadBps:0.90:ge,tradeRate:0.85:ge',
    note: 'spread×tradeRate',
  },
  {
    name: 'wall_imbalance',
    xSpec: 'wallStrengthP90:0.85:ge,avgDepthImbalance:0.85:ge',
    note: 'wallStrength×depthImbalance',
  },
  {
    name: 'flip_flow',
    xSpec: 'flipRate:0.85:ge,flowAccel:0.85:ge',
    note: 'flipRate×flowAccel',
  },
];

function runStateEval(cfg, xSpec, outDir, direction = 'abs') {
  const scriptPath = path.resolve(process.cwd(), 'scripts/research/ws_state_edge_eval.js');
  const args = [
    scriptPath,
    '--logs-dir', cfg.logsDir,
    '--out-dir', outDir,
    '--x-spec', xSpec,
    '--lead-window-sec', String(cfg.leadWindowSec),
    '--horizon-sec', String(cfg.horizonSec),
    '--sample-sec', String(cfg.sampleSec),
    '--move-bps', String(cfg.moveBps),
    '--direction', direction,
    '--train-days', String(cfg.trainDays),
    '--test-days', String(cfg.testDays),
    '--fee-bps', String(cfg.feeBps),
    '--slippage-bps', String(cfg.slippageBps),
    '--max-samples-per-day', String(cfg.maxSamplesPerDay),
  ];
  if (cfg.raw) {
    args.push('--raw', cfg.raw);
  }

  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (res.status !== 0) {
    throw new Error(`ws_state_edge_eval failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }

  const summaryPath = path.join(outDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary not found: ${summaryPath}`);
  }

  return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
}

function evaluateCandidate(summary, cfg) {
  const inS = summary?.inSample ?? {};
  const distX = inS?.distribution?.conditionedX ?? {};
  const oos = summary?.oosWalkForward ?? null;

  const uplift = toNum(inS.uplift, NaN);
  const coverage = toNum(inS.coverage, NaN);
  const py = toNum(inS.py, NaN);
  const pyx = toNum(inS.pyx, NaN);
  const ratio = toNum(inS.ratio, NaN);
  const p90 = toNum(distX.p90NetRetBps, NaN);
  const med = toNum(distX.medianNetRetBps, NaN);
  const tailScore = Number.isFinite(p90) && Number.isFinite(med) ? (p90 - med) : NaN;

  const totalCostBps = cfg.feeBps + cfg.slippageBps;
  const upliftCostThreshold = cfg.moveBps > 0 ? ((totalCostBps / cfg.moveBps) * 1.5) : Infinity;
  const oosFoldRate = toNum(oos?.positiveUpliftFoldRatio, NaN);

  const pass = {
    upliftOverCost: Number.isFinite(uplift) && uplift >= upliftCostThreshold,
    coverage: Number.isFinite(coverage) && coverage >= cfg.minCoverage,
    skew: Number.isFinite(tailScore) && tailScore > 0,
    oos: Number.isFinite(oosFoldRate) && oosFoldRate >= cfg.minOosFoldRate,
  };

  const score = Object.values(pass).filter(Boolean).length;

  return {
    py: round(py, 6),
    pyx: round(pyx, 6),
    uplift: round(uplift, 6),
    ratio: round(ratio, 6),
    coverage: round(coverage, 6),
    tailScore: round(tailScore, 6),
    upliftCostThreshold: round(upliftCostThreshold, 6),
    oosFolds: toNum(oos?.folds, 0),
    oosPositiveUpliftFoldRate: round(oosFoldRate, 6),
    pass,
    score,
  };
}

function recommendation(score) {
  if (score >= 4) return 'PASS';
  if (score === 3) return 'WATCH';
  return 'REJECT';
}

function pickWinner(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const sorted = [...results].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bu = toNum(b.uplift, -Infinity);
    const au = toNum(a.uplift, -Infinity);
    return bu - au;
  });
  return sorted[0];
}

function main() {
  const args = parseArgs(process.argv);
  const outDirAbs = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const rows = [];
  const details = [];

  for (const candidate of CANDIDATES) {
    const runOutDir = path.join(outDirAbs, candidate.name);
    fs.mkdirSync(runOutDir, { recursive: true });

    const summaryAbs = runStateEval(args, candidate.xSpec, runOutDir, 'abs');
    const scored = evaluateCandidate(summaryAbs, args);

    const row = {
      name: candidate.name,
      note: candidate.note,
      xSpec: candidate.xSpec,
      ...scored,
      recommendation: recommendation(scored.score),
    };

    rows.push(row);
    details.push({
      name: candidate.name,
      note: candidate.note,
      xSpec: candidate.xSpec,
      summaryAbs,
      scored,
    });
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return toNum(b.uplift, -Infinity) - toNum(a.uplift, -Infinity);
  });

  const winner = pickWinner(rows);
  let directionCheck = null;

  if (winner) {
    const winnerSpec = winner.xSpec;
    const upOut = path.join(outDirAbs, `${winner.name}_up`);
    const downOut = path.join(outDirAbs, `${winner.name}_down`);
    fs.mkdirSync(upOut, { recursive: true });
    fs.mkdirSync(downOut, { recursive: true });

    const summaryUp = runStateEval(args, winnerSpec, upOut, 'up');
    const summaryDown = runStateEval(args, winnerSpec, downOut, 'down');

    const upPyx = toNum(summaryUp?.inSample?.pyx, NaN);
    const downPyx = toNum(summaryDown?.inSample?.pyx, NaN);

    directionCheck = {
      winner: winner.name,
      up: {
        pyx: round(upPyx, 6),
        uplift: round(toNum(summaryUp?.inSample?.uplift, NaN), 6),
      },
      down: {
        pyx: round(downPyx, 6),
        uplift: round(toNum(summaryDown?.inSample?.uplift, NaN), 6),
      },
      bias: Number.isFinite(upPyx) && Number.isFinite(downPyx)
        ? (upPyx >= downPyx ? 'up' : 'down')
        : null,
      notes: 'Direction is checked only after winner selection (step 3).',
    };
  }

  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      raw: args.raw,
      logsDir: args.logsDir,
      outDir: args.outDir,
      leadWindowSec: args.leadWindowSec,
      horizonSec: args.horizonSec,
      sampleSec: args.sampleSec,
      moveBps: args.moveBps,
      trainDays: args.trainDays,
      testDays: args.testDays,
      feeBps: args.feeBps,
      slippageBps: args.slippageBps,
      minCoverage: args.minCoverage,
      minOosFoldRate: args.minOosFoldRate,
      maxSamplesPerDay: args.maxSamplesPerDay,
    },
    criteria: {
      scoreAxes: ['upliftOverCost', 'coverage', 'skew', 'oos'],
      upliftThresholdFormula: '(feeBps+slippageBps)/moveBps * 1.5',
      coverageThreshold: args.minCoverage,
      oosThreshold: args.minOosFoldRate,
    },
    comparison: rows,
    winner,
    directionCheck,
    details,
    notes: [
      'Step 1: compare only 3 fixed candidate states X.',
      'Step 2: score by uplift, coverage, skew, and OOS stability.',
      'Step 3: run up/down asymmetry check only for the winner.',
      'Research-only output; no live trading logic is changed.',
    ],
  };

  fs.writeFileSync(path.join(outDirAbs, 'compare_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'compare_table.csv'), toCsv(rows), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    winner: winner ? {
      name: winner.name,
      score: winner.score,
      recommendation: winner.recommendation,
      uplift: winner.uplift,
      coverage: winner.coverage,
      oosPositiveUpliftFoldRate: winner.oosPositiveUpliftFoldRate,
    } : null,
    directionCheck,
  }, null, 2));
}

main();
