#!/usr/bin/env node
/**
 * ws_edge_sweep.js
 *
 * 固定X候補に対して move-bps を複数段階でスイープし、
 * raw uplift / P(Y|X) / coverage / tailScore を横並び出力する。
 *
 * Usage:
 *   node scripts/research/ws_edge_sweep.js \
 *     --logs-dir logs \
 *     --out-dir logs/ops/ws_edge_sweep \
 *     --x-spec "avgSpreadBps:0.90:ge,tradeRate:0.85:ge" \
 *     --move-bps-list "5,8,12" \
 *     --lead-window-sec 20 \
 *     --horizon-sec 10 \
 *     --sample-sec 5 \
 *     --train-days 1 \
 *     --test-days 1
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function toMetricNum(v, d = NaN) {
  if (v == null) return d;
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
    outDir: 'logs/ops/ws_edge_sweep',
    xSpec: 'avgSpreadBps:0.90:ge,tradeRate:0.85:ge',
    moveBpsList: [5, 8, 12],
    directionList: ['abs'],
    leadWindowSec: 20,
    horizonSec: 10,
    postWindowSec: 0,
    sampleSec: 5,
    trainDays: 20,
    testDays: 5,
    feeBps: 0,
    slippageBps: 0,
    maxSamplesPerDay: 0,
    minNxy: 30,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? out.raw);
    else if (a === '--logs-dir') out.logsDir = String(argv[++i] ?? out.logsDir);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--x-spec') out.xSpec = String(argv[++i] ?? out.xSpec);
    else if (a === '--move-bps-list') {
      out.moveBpsList = String(argv[++i] ?? '5,8,12').split(',').map((v) => toNum(v, NaN)).filter(Number.isFinite);
    }
    else if (a === '--direction-list') {
      const dirs = String(argv[++i] ?? 'abs')
        .split(',')
        .map((s) => String(s || '').trim().toLowerCase())
        .filter((d) => ['abs', 'up', 'down'].includes(d));
      out.directionList = dirs.length > 0 ? [...new Set(dirs)] : ['abs'];
    }
    else if (a === '--lead-window-sec') out.leadWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.leadWindowSec)));
    else if (a === '--horizon-sec') out.horizonSec = Math.max(1, Math.floor(toNum(argv[++i], out.horizonSec)));
    else if (a === '--post-window-sec') out.postWindowSec = Math.max(0, Math.floor(toNum(argv[++i], out.postWindowSec)));
    else if (a === '--sample-sec') out.sampleSec = Math.max(1, Math.floor(toNum(argv[++i], out.sampleSec)));
    else if (a === '--train-days') out.trainDays = Math.max(1, Math.floor(toNum(argv[++i], out.trainDays)));
    else if (a === '--test-days') out.testDays = Math.max(1, Math.floor(toNum(argv[++i], out.testDays)));
    else if (a === '--fee-bps') out.feeBps = Math.max(0, toNum(argv[++i], out.feeBps));
    else if (a === '--slippage-bps') out.slippageBps = Math.max(0, toNum(argv[++i], out.slippageBps));
    else if (a === '--max-samples-per-day') out.maxSamplesPerDay = Math.max(0, Math.floor(toNum(argv[++i], out.maxSamplesPerDay)));
    else if (a === '--min-nxy') out.minNxy = Math.max(1, Math.floor(toNum(argv[++i], out.minNxy)));
  }
  return out;
}

function runStateEval(args, moveBps, direction, outDir) {
  const scriptPath = path.resolve(process.cwd(), 'scripts/research/ws_state_edge_eval.js');
  const cmdArgs = [
    scriptPath,
    '--logs-dir', args.logsDir,
    '--out-dir', outDir,
    '--x-spec', args.xSpec,
    '--lead-window-sec', String(args.leadWindowSec),
    '--horizon-sec', String(args.horizonSec),
    '--sample-sec', String(args.sampleSec),
    '--move-bps', String(moveBps),
    '--post-window-sec', String(args.postWindowSec),
    '--direction', String(direction),
    '--train-days', String(args.trainDays),
    '--test-days', String(args.testDays),
    '--fee-bps', '0',
    '--slippage-bps', '0',
    '--max-samples-per-day', String(args.maxSamplesPerDay),
  ];
  if (args.raw) cmdArgs.push('--raw', args.raw);

  const res = spawnSync(process.execPath, cmdArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (res.status !== 0) {
    throw new Error(`ws_state_edge_eval failed (move-bps=${moveBps}, direction=${direction}): ${res.stderr || res.stdout}`);
  }

  const summaryPath = path.join(outDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) throw new Error(`summary not found: ${summaryPath}`);
  return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
}

function extractRow(moveBps, direction, summary, minNxy) {
  const inS = summary?.inSample ?? {};
  const distX = inS?.distribution?.conditionedX ?? {};
  const distXY = inS?.distribution?.conditionedXY ?? {};
  const distBase = inS?.distribution?.baseline ?? {};
  const oos = summary?.oosWalkForward ?? {};

  const py     = toMetricNum(inS.py, NaN);
  const pyx    = toMetricNum(inS.pyx, NaN);
  const uplift = toMetricNum(inS.uplift, NaN);
  const ratio  = toMetricNum(inS.ratio, NaN);
  const coverage = toMetricNum(inS.coverage, NaN);
  const nx     = toMetricNum(inS.nx, NaN);
  const ny     = toMetricNum(inS.ny, NaN);

  const medX   = toMetricNum(distX.medianNetRetBps, NaN);
  const p90X   = toMetricNum(distX.p90NetRetBps, NaN);
  const p10X   = toMetricNum(distX.p10NetRetBps, NaN);
  const skewX  = toMetricNum(distX.skewNetRet, NaN);
  const tailScore = Number.isFinite(p90X) && Number.isFinite(medX) ? (p90X - medX) : NaN;
  const conditionalMedian = toMetricNum(distXY.medianNetRetBps, NaN);
  const conditionalP90 = toMetricNum(distXY.p90NetRetBps, NaN);
  const conditionalSkew = toMetricNum(distXY.skewNetRet, NaN);
  const meanRetGivenY = toMetricNum(distXY.meanNetRetBps, NaN);
  const postRetMedian = toMetricNum(distXY.postMedianNetRetBps, NaN);
  const postRetP90 = toMetricNum(distXY.postP90NetRetBps, NaN);
  const postRetMean = toMetricNum(distXY.postMeanNetRetBps, NaN);

  const medBase  = toMetricNum(distBase.medianNetRetBps, NaN);
  const p90Base  = toMetricNum(distBase.p90NetRetBps, NaN);
  const skewBase = toMetricNum(distBase.skewNetRet, NaN);

  const ciLow  = toMetricNum(inS.upliftCi95Low, NaN);
  const ciHigh = toMetricNum(inS.upliftCi95High, NaN);
  const ciContainsZero = Number.isFinite(ciLow) && Number.isFinite(ciHigh)
    ? (ciLow <= 0 && ciHigh >= 0) : null;

  const oosFoldRate = toMetricNum(oos?.positiveUpliftFoldRatio, NaN);

  return {
    moveBps,
    direction,
    py:           round(py, 6),
    pyx:          round(pyx, 6),
    uplift:       round(uplift, 6),
    ratio:        round(ratio, 6),
    coverage:     round(coverage, 6),
    nx,
    ny,
    nxy: toMetricNum(inS.nxy, NaN),
    sampleGate: toMetricNum(inS.nxy, NaN) >= minNxy ? 'GREEN' : 'GRAY',
    tailScore:    round(tailScore, 6),
    skewX:        round(skewX, 6),
    p10X:         round(p10X, 6),
    medX:         round(medX, 6),
    p90X:         round(p90X, 6),
    medBase:      round(medBase, 6),
    p90Base:      round(p90Base, 6),
    skewBase:     round(skewBase, 6),
    conditionalMedian: round(conditionalMedian, 6),
    conditionalP90: round(conditionalP90, 6),
    conditionalSkew: round(conditionalSkew, 6),
    meanRetGivenY: round(meanRetGivenY, 6),
    postRetMedian: round(postRetMedian, 6),
    postRetP90: round(postRetP90, 6),
    postRetMean: round(postRetMean, 6),
    ciLow:        round(ciLow, 6),
    ciHigh:       round(ciHigh, 6),
    ciContainsZero,
    oosFolds:     toMetricNum(oos?.folds, 0),
    oosPosFoldRate: round(oosFoldRate, 6),
    efficiencyScore: round((toNum(coverage, 0) * toNum(tailScore, 0)), 6),
  };
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

function printTable(rows, xSpec) {
  const pad = (v, n = 10) => String(v ?? '').padStart(n);
  const hdr = [
    'moveBps'.padEnd(8),
    'dir'.padEnd(4),
    pad('nxy', 6),
    pad('gate', 6),
    pad('py'),
    pad('pyx'),
    pad('uplift'),
    pad('coverage'),
    pad('tailScore'),
    pad('skewX'),
    pad('condSkew'),
    pad('condP90'),
    pad('mean|X&Y'),
    pad('postMed'),
    pad('postP90'),
    pad('postMean'),
    pad('p90X'),
    pad('medX'),
    pad('efficiency'),
    pad('ciContains0', 11),
    pad('oosRate'),
  ].join('  ');
  const sep = '-'.repeat(hdr.length);

  console.log(`\n=== move-bps sweep: ${xSpec} ===`);
  console.log(sep);
  console.log(hdr);
  console.log(sep);
  for (const r of rows) {
    console.log([
      String(r.moveBps).padEnd(8),
      String(r.direction).padEnd(4),
      pad(r.nxy, 6),
      pad(r.sampleGate, 6),
      pad(r.py),
      pad(r.pyx),
      pad(r.uplift),
      pad(r.coverage),
      pad(r.tailScore),
      pad(r.skewX),
      pad(r.conditionalSkew),
      pad(r.conditionalP90),
      pad(r.meanRetGivenY),
      pad(r.postRetMedian),
      pad(r.postRetP90),
      pad(r.postRetMean),
      pad(r.p90X),
      pad(r.medX),
      pad(r.efficiencyScore),
      pad(String(r.ciContainsZero), 11),
      pad(r.oosPosFoldRate),
    ].join('  '));
  }
  console.log(sep);

  // 判定（direction=abs があれば abs のみ対象）
  const judgeRows = rows.some((r) => r.direction === 'abs')
    ? rows.filter((r) => r.direction === 'abs')
    : rows;
  const bestUplift  = [...judgeRows].sort((a, b) => toNum(b.uplift, -Infinity) - toNum(a.uplift, -Infinity))[0];
  const bestEffic   = [...judgeRows].sort((a, b) => toNum(b.efficiencyScore, -Infinity) - toNum(a.efficiencyScore, -Infinity))[0];
  const bestSkew    = [...judgeRows].sort((a, b) => toNum(b.skewX, -Infinity) - toNum(a.skewX, -Infinity))[0];

  const monotoneUp = judgeRows.length >= 2 && judgeRows.every((r, i) =>
    i === 0 || toNum(r.uplift, -Infinity) >= toNum(judgeRows[i - 1].uplift, -Infinity)
  );
  const coverageDropSkewRise = judgeRows.length >= 2 && (() => {
    const coverageDrop = toNum(judgeRows[judgeRows.length - 1].coverage, 0) < toNum(judgeRows[0].coverage, 0);
    const skewRise     = toNum(judgeRows[judgeRows.length - 1].skewX, 0) > toNum(judgeRows[0].skewX, 0);
    return coverageDrop && skewRise;
  })();

  console.log('\n--- 判定 ---');
  console.log(`  best uplift:      move-bps=${bestUplift?.moveBps}  uplift=${bestUplift?.uplift}`);
  console.log(`  best efficiency:  move-bps=${bestEffic?.moveBps}  coverage×tailScore=${bestEffic?.efficiencyScore}`);
  console.log(`  best skew:        move-bps=${bestSkew?.moveBps}  skewX=${bestSkew?.skewX}`);
  console.log(`  uplift monotone↑: ${monotoneUp}`);
  console.log(`  coverage↓ skew↑:  ${coverageDropSkewRise} (ブレイク捕捉型の兆候)`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.moveBpsList.length === 0) {
    console.error('[ws_edge_sweep] --move-bps-list is empty');
    process.exit(1);
  }

  const outDirAbs = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const rows = [];
  const directionOrder = Object.fromEntries(args.directionList.map((d, i) => [d, i]));

  for (const moveBps of args.moveBpsList) {
    for (const direction of args.directionList) {
      const runOut = path.join(outDirAbs, `movebps_${moveBps}_${direction}`);
      fs.mkdirSync(runOut, { recursive: true });
      const summary = runStateEval(args, moveBps, direction, runOut);
      const row = extractRow(moveBps, direction, summary, args.minNxy);
      rows.push(row);
    }
  }

  rows.sort((a, b) => {
    const dm = toNum(a.moveBps, Infinity) - toNum(b.moveBps, Infinity);
    if (dm !== 0) return dm;
    return toNum(directionOrder[a.direction], Infinity) - toNum(directionOrder[b.direction], Infinity);
  });

  printTable(rows, args.xSpec);

  const output = {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      raw: args.raw,
      logsDir: args.logsDir,
      xSpec: args.xSpec,
      moveBpsList: args.moveBpsList,
      directionList: args.directionList,
      leadWindowSec: args.leadWindowSec,
      horizonSec: args.horizonSec,
      postWindowSec: args.postWindowSec,
      sampleSec: args.sampleSec,
      trainDays: args.trainDays,
      testDays: args.testDays,
      feeBps: args.feeBps,
      slippageBps: args.slippageBps,
      minNxy: args.minNxy,
    },
    sweep: rows,
    interpretation: {
      watchFor: [
        'uplift最大の move-bps（強発火の閾値）',
        'coverage×tailScore が最大の move-bps（実運用効率）',
        'skewX が正に増えるか（ブレイク捕捉型か）',
        'conditionalSkew / conditionalP90 / meanRetGivenY（X∧Y成立後の伸び）',
        'ciContainsZero=false の範囲（統計的有意帯域）',
        'coverage↓ + skewX↑ → ブレイク捕捉型エッジの兆候',
      ],
    },
    notes: [
      'feeBps/slippageBps=0 で計算（raw uplift 確認用）',
      'Research-only output; no live trading logic is changed.',
    ],
  };

  fs.writeFileSync(path.join(outDirAbs, 'sweep_summary.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'sweep_table.csv'), toCsv(rows), 'utf8');

  console.log(`\n[出力] ${outDirAbs}`);
}

main();
