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
    runDir: 'logs/ops/ws_pattern_pipeline/latest',
    out: 'logs/ops/ws_pattern_digest.txt',
    jsonOut: 'logs/ops/ws_pattern_digest.json',
    top: 3,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--run-dir') out.runDir = String(argv[++i] ?? out.runDir);
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--json-out') out.jsonOut = String(argv[++i] ?? out.jsonOut);
    else if (a === '--top') out.top = Math.max(1, Math.floor(toNum(argv[++i], out.top)));
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const runDirAbs = path.resolve(process.cwd(), args.runDir);

  const source = loadJson(path.join(runDirAbs, 'source', 'summary.json'));
  const refreshed = loadJson(path.join(runDirAbs, 'refresh', 'pattern_model_refreshed.json'));
  const apply = loadJson(path.join(runDirAbs, 'apply', 'pattern_apply_summary.json'));

  if (!source?.ok || !refreshed?.ok || !apply?.ok) {
    console.error('[ws_pattern_digest] required files are missing or invalid');
    process.exit(1);
  }

  const topRows = (Array.isArray(refreshed?.patterns) ? refreshed.patterns : []).slice(0, args.top).map((r) => ({
    patternName: r.patternName,
    trainFitRate: round(toNum(r.trainFitRate, NaN), 4),
    testFitRate: round(toNum(r.testFitRate, NaN), 4),
    trainN: toNum(r.trainN, NaN),
    testN: toNum(r.testN, NaN),
    gate: r.gate || '',
  }));

  const applyTop = (Array.isArray(apply?.report) ? apply.report : []).slice(0, args.top).map((r) => ({
    patternName: r.patternName,
    fitRate: round(toNum(r.fitRate, NaN), 4),
    n: toNum(r.n, NaN),
    meanRetBps: round(toNum(r.meanRetBps, NaN), 4),
    p10RetBps: round(toNum(r.p10RetBps, NaN), 4),
  }));

  const rs = refreshed?.refreshStats || {};
  const rows = toNum(source?.sample?.rows, NaN);
  const dates = Array.isArray(source?.sample?.dates) ? source.sample.dates.length : NaN;
  const threshold = round(toNum(refreshed?.config?.eventThresholdBps, NaN), 4);

  const lines = [
    'WS Pattern Refresh Report',
    `RunDir: ${runDirAbs}`,
    `Rows=${rows}, Dates=${dates}, EventThresholdBps=${threshold}`,
    `Refresh: kept=${toNum(rs.kept, 0)} dropped=${toNum(rs.dropped, 0)} created=${toNum(rs.created, 0)}`,
    '',
    '[Top Refreshed Patterns]',
    ...topRows.map((r, i) => `${i + 1}. ${r.patternName} gate=${r.gate} trainFit=${r.trainFitRate} testFit=${r.testFitRate} n(train/test)=${r.trainN}/${r.testN}`),
    '',
    '[Top Apply Patterns]',
    ...applyTop.map((r, i) => `${i + 1}. ${r.patternName} fit=${r.fitRate} n=${r.n} mean=${r.meanRetBps} p10=${r.p10RetBps}`),
  ].join('\n');

  const digest = {
    ok: true,
    generatedAt: new Date().toISOString(),
    runDir: runDirAbs,
    source: { rows, dates, eventThresholdBps: threshold },
    refresh: {
      kept: toNum(rs.kept, 0),
      dropped: toNum(rs.dropped, 0),
      created: toNum(rs.created, 0),
      topPatterns: topRows,
    },
    apply: { topPatterns: applyTop },
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
