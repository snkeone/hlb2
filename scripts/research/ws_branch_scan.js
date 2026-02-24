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

function parseList(s) {
  return String(s || '').split(',').map((x) => String(x || '').trim()).filter(Boolean);
}

function parseNumList(s) {
  return parseList(s).map((x) => toNum(x, NaN)).filter(Number.isFinite);
}

function choose(arr, k) {
  const out = [];
  const n = arr.length;
  if (k <= 0 || k > n) return out;
  const rec = (start, picked) => {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      picked.push(arr[i]);
      rec(i + 1, picked);
      picked.pop();
    }
  };
  rec(0, []);
  return out;
}

function cartesian(lists) {
  if (!lists.length) return [[]];
  let out = [[]];
  for (const list of lists) {
    const next = [];
    for (const base of out) {
      for (const v of list) next.push([...base, v]);
    }
    out = next;
  }
  return out;
}

function uniqueKey(arr) {
  return [...arr].sort().join(',');
}

function parseArgs(argv) {
  const out = {
    raw: null,
    logsDir: 'logs',
    outDir: 'logs/ops/ws_branch_scan',
    leadWindowSec: 20,
    horizonSec: 10,
    postWindowSec: 20,
    sampleSec: 5,
    moveBps: 5,
    direction: 'abs',
    trainDays: 20,
    testDays: 10,
    feeBps: 0,
    slippageBps: 0,
    maxSamplesPerDay: 0,
    minBaseAN: 200,
    minGroupN: 50,
    minDates: 20,
    scoreLambda: 1.0,
    scoreMu: 20.0,
    topK: 20,
    maxCombos: 0,
    allowFeatureOverlap: false,

    aFeatures: [
      'avgSpreadBps', 'tradeRate', 'flipRate', 'flowAccel', 'avgDepthImbalance', 'wallStrengthP90',
      'spreadDeltaBps', 'ofi', 'avgMicropriceDevBps', 'microDriftBps',
      'wallImbalance', 'wallBidDominanceRate', 'wallAskDominanceRate', 'wallDominanceFlipRate',
      'buyRunShare', 'sellRunShare',
    ],
    bFeatures: [
      'avgDepthImbalance', 'flowAccel', 'flipRate', 'ofi', 'tradeRate', 'wallStrengthP90',
      'avgMicropriceDevBps', 'microDriftBps', 'wallImbalance', 'wallBidDominanceRate',
      'wallDominanceFlipRate', 'buyRunShare', 'sellRunShare',
    ],
    cFeatures: [
      'avgDepthImbalance', 'flowAccel', 'flipRate', 'ofi', 'tradeRate', 'wallStrengthP90',
      'avgMicropriceDevBps', 'microDriftBps', 'wallImbalance', 'wallAskDominanceRate',
      'wallDominanceFlipRate', 'buyRunShare', 'sellRunShare',
    ],
    aQuantiles: [0.85, 0.9],
    bQuantiles: [0.8, 0.85, 0.9],
    cQuantiles: [0.1, 0.15, 0.2],
    aOps: ['ge'],
    bOps: ['ge'],
    cOps: ['le'],
    aArity: 2,
    bArity: 1,
    cArity: 1,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? out.raw);
    else if (a === '--logs-dir') out.logsDir = String(argv[++i] ?? out.logsDir);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--lead-window-sec') out.leadWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.leadWindowSec)));
    else if (a === '--horizon-sec') out.horizonSec = Math.max(1, Math.floor(toNum(argv[++i], out.horizonSec)));
    else if (a === '--post-window-sec') out.postWindowSec = Math.max(0, Math.floor(toNum(argv[++i], out.postWindowSec)));
    else if (a === '--sample-sec') out.sampleSec = Math.max(1, Math.floor(toNum(argv[++i], out.sampleSec)));
    else if (a === '--move-bps') out.moveBps = Math.max(0.1, toNum(argv[++i], out.moveBps));
    else if (a === '--direction') {
      const d = String(argv[++i] ?? out.direction).toLowerCase();
      if (['abs', 'up', 'down'].includes(d)) out.direction = d;
    }
    else if (a === '--train-days') out.trainDays = Math.max(1, Math.floor(toNum(argv[++i], out.trainDays)));
    else if (a === '--test-days') out.testDays = Math.max(1, Math.floor(toNum(argv[++i], out.testDays)));
    else if (a === '--fee-bps') out.feeBps = Math.max(0, toNum(argv[++i], out.feeBps));
    else if (a === '--slippage-bps') out.slippageBps = Math.max(0, toNum(argv[++i], out.slippageBps));
    else if (a === '--max-samples-per-day') out.maxSamplesPerDay = Math.max(0, Math.floor(toNum(argv[++i], out.maxSamplesPerDay)));
    else if (a === '--min-base-a-n') out.minBaseAN = Math.max(1, Math.floor(toNum(argv[++i], out.minBaseAN)));
    else if (a === '--min-group-n') out.minGroupN = Math.max(1, Math.floor(toNum(argv[++i], out.minGroupN)));
    else if (a === '--min-dates') out.minDates = Math.max(1, Math.floor(toNum(argv[++i], out.minDates)));
    else if (a === '--score-lambda') out.scoreLambda = Math.max(0, toNum(argv[++i], out.scoreLambda));
    else if (a === '--score-mu') out.scoreMu = Math.max(0, toNum(argv[++i], out.scoreMu));
    else if (a === '--top-k') out.topK = Math.max(1, Math.floor(toNum(argv[++i], out.topK)));
    else if (a === '--max-combos') out.maxCombos = Math.max(0, Math.floor(toNum(argv[++i], out.maxCombos)));
    else if (a === '--allow-feature-overlap') out.allowFeatureOverlap = String(argv[++i] ?? 'false') === 'true';
    else if (a === '--a-features') out.aFeatures = parseList(argv[++i]);
    else if (a === '--b-features') out.bFeatures = parseList(argv[++i]);
    else if (a === '--c-features') out.cFeatures = parseList(argv[++i]);
    else if (a === '--a-quantiles') out.aQuantiles = parseNumList(argv[++i]);
    else if (a === '--b-quantiles') out.bQuantiles = parseNumList(argv[++i]);
    else if (a === '--c-quantiles') out.cQuantiles = parseNumList(argv[++i]);
    else if (a === '--a-ops') out.aOps = parseList(argv[++i]);
    else if (a === '--b-ops') out.bOps = parseList(argv[++i]);
    else if (a === '--c-ops') out.cOps = parseList(argv[++i]);
    else if (a === '--a-arity') out.aArity = Math.max(1, Math.floor(toNum(argv[++i], out.aArity)));
    else if (a === '--b-arity') out.bArity = Math.max(1, Math.floor(toNum(argv[++i], out.bArity)));
    else if (a === '--c-arity') out.cArity = Math.max(1, Math.floor(toNum(argv[++i], out.cArity)));
  }
  return out;
}

function buildSpecs(features, quantiles, ops, arity) {
  const feats = [...new Set(features)];
  const qs = quantiles.filter((q) => q >= 0 && q <= 1);
  const os = ops.filter((op) => op === 'ge' || op === 'le');
  const featComb = choose(feats, arity);
  const out = [];
  for (const group of featComb) {
    const perFeature = group.map((f) => qs.flatMap((q) => os.map((op) => `${f}:${q}:${op}`)));
    const combos = cartesian(perFeature);
    for (const c of combos) out.push(c.join(','));
  }
  return [...new Set(out)];
}

function tokensOfSpec(spec) {
  return parseList(spec).map((t) => String(t.split(':')[0] || '').trim()).filter(Boolean);
}

function overlap(aSpec, bSpec, cSpec) {
  const fa = new Set(tokensOfSpec(aSpec));
  const fb = new Set(tokensOfSpec(bSpec));
  const fc = new Set(tokensOfSpec(cSpec));
  for (const x of fa) if (fb.has(x) || fc.has(x)) return true;
  for (const x of fb) if (fc.has(x)) return true;
  return false;
}

function runEval(cfg, idx, aSpec, bSpec, cSpec, outDir) {
  const scriptPath = path.resolve(process.cwd(), 'scripts/research/ws_state_edge_eval.js');
  const runDir = path.join(outDir, `run_${String(idx).padStart(5, '0')}`);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [
    scriptPath,
    '--logs-dir', cfg.logsDir,
    '--out-dir', runDir,
    '--lead-window-sec', String(cfg.leadWindowSec),
    '--horizon-sec', String(cfg.horizonSec),
    '--post-window-sec', String(cfg.postWindowSec),
    '--sample-sec', String(cfg.sampleSec),
    '--move-bps', String(cfg.moveBps),
    '--direction', cfg.direction,
    '--train-days', String(cfg.trainDays),
    '--test-days', String(cfg.testDays),
    '--fee-bps', String(cfg.feeBps),
    '--slippage-bps', String(cfg.slippageBps),
    '--max-samples-per-day', String(cfg.maxSamplesPerDay),
    '--min-base-a-n', String(cfg.minBaseAN),
    '--min-group-n', String(cfg.minGroupN),
    '--x-spec', aSpec,
    '--b-spec', bSpec,
    '--c-spec', cSpec,
  ];
  if (cfg.raw) args.push('--raw', cfg.raw);
  const res = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (res.status !== 0) {
    return { ok: false, runDir, error: (res.stderr || res.stdout || '').slice(0, 500) };
  }
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) return { ok: false, runDir, error: 'missing summary.json' };
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  return { ok: true, runDir, summary };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return `${[keys.join(',')].concat(rows.map((r) => keys.map((k) => esc(r[k])).join(','))).join('\n')}\n`;
}

function main() {
  const cfg = parseArgs(process.argv);
  const outDirAbs = path.resolve(process.cwd(), cfg.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const aSpecs = buildSpecs(cfg.aFeatures, cfg.aQuantiles, cfg.aOps, cfg.aArity);
  const bSpecs = buildSpecs(cfg.bFeatures, cfg.bQuantiles, cfg.bOps, cfg.bArity);
  const cSpecs = buildSpecs(cfg.cFeatures, cfg.cQuantiles, cfg.cOps, cfg.cArity);
  if (!aSpecs.length || !bSpecs.length || !cSpecs.length) {
    console.error('[ws_branch_scan] no specs generated');
    process.exit(1);
  }

  const rows = [];
  let tested = 0;
  let skippedOverlap = 0;
  let failed = 0;
  let stop = false;

  for (const aSpec of aSpecs) {
    if (stop) break;
    for (const bSpec of bSpecs) {
      if (stop) break;
      for (const cSpec of cSpecs) {
        if (!cfg.allowFeatureOverlap && overlap(aSpec, bSpec, cSpec)) {
          skippedOverlap += 1;
          continue;
        }
        if (cfg.maxCombos > 0 && tested >= cfg.maxCombos) {
          stop = true;
          break;
        }
        tested += 1;
        const run = runEval(cfg, tested, aSpec, bSpec, cSpec, outDirAbs);
        if (!run.ok) {
          failed += 1;
          rows.push({
            idx: tested,
            ok: false,
            aSpec,
            bSpec,
            cSpec,
            error: run.error,
          });
          continue;
        }

        const s = run.summary || {};
        const routing = s.routing || {};
        const pnl = routing.pnlExecution || {};
        const total = pnl.totalTrades || {};
        const b = pnl.bTrades || {};
        const c = pnl.cTrades || {};
        const sampleRows = toNum(s?.sample?.rows, NaN);
        const dates = Array.isArray(s?.sample?.dates) ? s.sample.dates.length : 0;
        const turnover = Number.isFinite(sampleRows) && sampleRows > 0 ? (toNum(total.n, 0) / sampleRows) : null;
        const meanNet = toNum(total.meanNetRetBps, NaN);
        const p10Net = toNum(total.p10NetRetBps, NaN);
        const score = Number.isFinite(meanNet) && Number.isFinite(p10Net) && Number.isFinite(turnover)
          ? (meanNet - (cfg.scoreLambda * Math.abs(p10Net)) - (cfg.scoreMu * turnover))
          : NaN;
        const baseGate = String(routing?.baseA?.gate || 'GRAY');
        const bg = String((routing?.groups || []).find((g) => g?.name === 'B_only')?.gate || 'GRAY');
        const cg = String((routing?.groups || []).find((g) => g?.name === 'C_only')?.gate || 'GRAY');
        const datesGate = dates >= cfg.minDates ? 'GREEN' : 'GRAY';
        const hardGate = (baseGate === 'GREEN' && bg === 'GREEN' && cg === 'GREEN' && datesGate === 'GREEN') ? 'GREEN' : 'GRAY';

        rows.push({
          idx: tested,
          ok: true,
          aSpec,
          bSpec,
          cSpec,
          dates,
          datesGate,
          baseGate,
          bGate: bg,
          cGate: cg,
          hardGate,
          antisymmetry: routing?.antisymmetry?.pass === true,
          stabilityBUp: round(toNum(routing?.stability?.bOnly?.upliftUpPositiveRatio, NaN), 6),
          stabilityBDown: round(toNum(routing?.stability?.bOnly?.upliftDownNegativeRatio, NaN), 6),
          stabilityCDown: round(toNum(routing?.stability?.cOnly?.upliftDownPositiveRatio, NaN), 6),
          stabilityCUp: round(toNum(routing?.stability?.cOnly?.upliftUpNegativeRatio, NaN), 6),
          aCount: toNum(pnl?.aCount, NaN),
          bTradesN: toNum(b?.n, NaN),
          cTradesN: toNum(c?.n, NaN),
          totalTradesN: toNum(total?.n, NaN),
          bMeanNet: round(toNum(b?.meanNetRetBps, NaN), 6),
          bP10Net: round(toNum(b?.p10NetRetBps, NaN), 6),
          cMeanNet: round(toNum(c?.meanNetRetBps, NaN), 6),
          cP10Net: round(toNum(c?.p10NetRetBps, NaN), 6),
          totalMeanNet: round(meanNet, 6),
          totalP10Net: round(p10Net, 6),
          totalPositiveRatio: round(toNum(total?.positiveRatio, NaN), 6),
          turnover: round(turnover, 6),
          score: round(score, 6),
          runDir: run.runDir,
        });
      }
    }
  }

  const okRows = rows.filter((r) => r.ok === true);
  okRows.sort((a, b) => toNum(b.score, -Infinity) - toNum(a.score, -Infinity));
  const ranked = okRows.filter((r) => toNum(r.totalTradesN, 0) > 0);
  const top = (ranked.length > 0 ? ranked : okRows).slice(0, cfg.topK);

  fs.writeFileSync(path.join(outDirAbs, 'scan_results.csv'), toCsv(rows), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'scan_top.csv'), toCsv(top), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'scan_summary.json'), `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    config: cfg,
    counts: {
      aSpecs: aSpecs.length,
      bSpecs: bSpecs.length,
      cSpecs: cSpecs.length,
      tested,
      skippedOverlap,
      failed,
      success: okRows.length,
    },
    top,
  }, null, 2)}\n`, 'utf8');

  const pad = (v, n = 10) => String(v ?? '').padStart(n);
  console.log('\n=== ws_branch_scan top ===');
  console.log([
    'rank'.padEnd(5),
    pad('score'),
    pad('totMean'),
    pad('totP10'),
    pad('bMean'),
    pad('cMean'),
    pad('nTot', 6),
    pad('gate', 6),
    pad('dates', 6),
  ].join('  '));
  top.forEach((r, i) => {
    console.log([
      String(i + 1).padEnd(5),
      pad(r.score),
      pad(r.totalMeanNet),
      pad(r.totalP10Net),
      pad(r.bMeanNet),
      pad(r.cMeanNet),
      pad(r.totalTradesN, 6),
      pad(r.hardGate, 6),
      pad(r.dates, 6),
    ].join('  '));
  });
  console.log(`\n[output] ${outDirAbs}`);
}

main();
