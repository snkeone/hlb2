#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function parseArgs(argv) {
  const args = {
    input: [],
    outDir: null,
    sampleMs: null,
    maxDistanceUsd: null,
    minCount: 300,
    minCountFinal: 1000,
    simMinScore: 0,
    simMinSpreadBps: 0,
    simMaxSpreadBps: 5,
    simHoldMs: 30000,
    simCooldownMs: 3000,
    simIncludeTypes: ''
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') {
      const v = String(argv[i + 1] || '');
      i += 1;
      args.input = v.split(',').map((x) => x.trim()).filter(Boolean);
    } else if (a === '--out-dir') {
      args.outDir = String(argv[i + 1] || '');
      i += 1;
    } else if (a === '--sample-ms') {
      args.sampleMs = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--max-distance-usd') {
      args.maxDistanceUsd = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--min-count') {
      args.minCount = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--min-count-final') {
      args.minCountFinal = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--sim-min-score') {
      args.simMinScore = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--sim-min-spread-bps') {
      args.simMinSpreadBps = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--sim-max-spread-bps') {
      args.simMaxSpreadBps = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--sim-hold-ms') {
      args.simHoldMs = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--sim-cooldown-ms') {
      args.simCooldownMs = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--sim-include-types') {
      args.simIncludeTypes = String(argv[i + 1] || '');
      i += 1;
    }
  }
  return args;
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

function runNode(scriptPath, scriptArgs, cwd) {
  const r = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd,
    stdio: 'inherit',
    env: process.env
  });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

function requireInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('missing --input raw-*.jsonl(.gz) path(s)');
  }
  for (const p of inputs) {
    if (!fs.existsSync(p)) {
      throw new Error(`input not found: ${p}`);
    }
  }
}

function main() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv);
  requireInputs(args.input);

  const outDir = args.outDir
    ? path.resolve(args.outDir)
    : path.resolve(cwd, 'data', 'validation', `raw-backtest-${nowStamp()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const truthScript = path.resolve(cwd, 'scripts', 'validation', 'ws_event_truth_eval.js');
  const judgeScript = path.resolve(cwd, 'scripts', 'validation', 'judge_validation_results.js');
  const simScript = path.resolve(cwd, 'scripts', 'ops', 'simulate_from_events.js');

  const truthArgs = [
    '--input',
    args.input.join(','),
    '--out-dir',
    outDir
  ];
  if (Number.isFinite(args.sampleMs) && args.sampleMs > 0) {
    truthArgs.push('--sample-ms', String(Math.floor(args.sampleMs)));
  }
  if (Number.isFinite(args.maxDistanceUsd) && args.maxDistanceUsd > 0) {
    truthArgs.push('--max-distance-usd', String(args.maxDistanceUsd));
  }

  const judgeArgs = [
    '--run-dir',
    outDir,
    '--min-count',
    String(Number.isFinite(args.minCount) ? args.minCount : 300),
    '--min-count-final',
    String(Number.isFinite(args.minCountFinal) ? args.minCountFinal : 1000)
  ];

  const simArgs = [
    '--run-dir',
    outDir,
    '--min-score',
    String(Number.isFinite(args.simMinScore) ? args.simMinScore : 0),
    '--min-spread-bps',
    String(Number.isFinite(args.simMinSpreadBps) ? args.simMinSpreadBps : 0),
    '--max-spread-bps',
    String(Number.isFinite(args.simMaxSpreadBps) ? args.simMaxSpreadBps : 5),
    '--hold-ms',
    String(Number.isFinite(args.simHoldMs) ? args.simHoldMs : 30000),
    '--cooldown-ms',
    String(Number.isFinite(args.simCooldownMs) ? args.simCooldownMs : 3000)
  ];
  if (args.simIncludeTypes) {
    simArgs.push('--include-types', args.simIncludeTypes);
  }

  runNode(truthScript, truthArgs, cwd);
  runNode(judgeScript, judgeArgs, cwd);
  runNode(simScript, simArgs, cwd);

  const summaryPath = path.join(outDir, 'validation_summary.txt');
  if (fs.existsSync(summaryPath)) {
    const summary = fs.readFileSync(summaryPath, 'utf8');
    process.stdout.write(`\n[raw-backtest] done: ${outDir}\n`);
    process.stdout.write(`${summary}\n`);
  } else {
    process.stdout.write(`\n[raw-backtest] done: ${outDir}\n`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[raw-backtest] ${err.message}`);
  process.exit(1);
}
