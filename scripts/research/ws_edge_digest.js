#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    mode: 'daily',
    runDir: 'logs/ops/ws_edge_pipeline/latest',
    out: 'logs/ops/ws_edge_digest_daily.txt',
    jsonOut: 'logs/ops/ws_edge_digest_daily.json',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--mode') out.mode = String(argv[++i] ?? out.mode);
    else if (a === '--run-dir') out.runDir = String(argv[++i] ?? out.runDir);
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--json-out') out.jsonOut = String(argv[++i] ?? out.jsonOut);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const runDirAbs = path.resolve(process.cwd(), args.runDir);
  const compare = loadJson(path.join(runDirAbs, 'compare', 'compare_summary.json'));
  const sweep = loadJson(path.join(runDirAbs, 'sweep', 'sweep_summary.json'));
  const branch = loadJson(path.join(runDirAbs, 'branch', 'scan_summary.json'));
  if (!compare?.ok || !sweep?.ok || !branch?.ok) {
    console.error('[ws_edge_digest] required files are missing or invalid');
    process.exit(1);
  }

  const winner = compare.winner || {};
  const dir = compare.directionCheck || {};
  const sweepRows = Array.isArray(sweep.sweep) ? sweep.sweep : [];
  const sweepAbs = sweepRows.filter((r) => String(r.direction || 'abs') === 'abs');
  const bestUplift = sweepAbs.length > 0
    ? [...sweepAbs].sort((a, b) => toNum(b.uplift, -Infinity) - toNum(a.uplift, -Infinity))[0]
    : null;
  const scanTop = Array.isArray(branch.top) ? branch.top.slice(0, 3) : [];

  const lines = [
    `WS Edge ${args.mode} Report`,
    `RunDir: ${runDirAbs}`,
    '',
    `[Compare Winner] name=${winner.name ?? 'n/a'} rec=${winner.recommendation ?? 'n/a'} score=${winner.score ?? 'n/a'} uplift=${winner.uplift ?? 'n/a'} coverage=${winner.coverage ?? 'n/a'}`,
    `[Direction] bias=${dir.bias ?? 'n/a'} up.pyx=${dir?.up?.pyx ?? 'n/a'} down.pyx=${dir?.down?.pyx ?? 'n/a'} up.uplift=${dir?.up?.uplift ?? 'n/a'} down.uplift=${dir?.down?.uplift ?? 'n/a'}`,
    '',
    `[Sweep Best(abs)] move=${bestUplift?.moveBps ?? 'n/a'} uplift=${bestUplift?.uplift ?? 'n/a'} nxy=${bestUplift?.nxy ?? 'n/a'} gate=${bestUplift?.sampleGate ?? 'n/a'} mean|X&Y=${bestUplift?.meanRetGivenY ?? 'n/a'} postMean=${bestUplift?.postRetMean ?? 'n/a'}`,
    '',
    '[Branch Scan Top]',
    ...scanTop.map((r, i) => `${i + 1}. score=${r.score} mean=${r.totalMeanNet} p10=${r.totalP10Net} n=${r.totalTradesN} gate=${r.hardGate} A=${r.aSpec} B=${r.bSpec} C=${r.cSpec}`),
  ].join('\n');

  const digest = {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    runDir: runDirAbs,
    compare: {
      winner: winner || null,
      directionCheck: dir || null,
    },
    sweep: {
      bestAbs: bestUplift ? {
        moveBps: bestUplift.moveBps,
        uplift: round(toNum(bestUplift.uplift, NaN), 6),
        nxy: toNum(bestUplift.nxy, NaN),
        gate: bestUplift.sampleGate,
        meanRetGivenY: round(toNum(bestUplift.meanRetGivenY, NaN), 6),
        postRetMean: round(toNum(bestUplift.postRetMean, NaN), 6),
      } : null,
    },
    branchTop: scanTop,
    text: lines,
  };

  const outAbs = path.resolve(process.cwd(), args.out);
  const jsonOutAbs = path.resolve(process.cwd(), args.jsonOut);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.mkdirSync(path.dirname(jsonOutAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${lines}\n`, 'utf8');
  fs.writeFileSync(jsonOutAbs, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
  console.log(lines);
}

main();
