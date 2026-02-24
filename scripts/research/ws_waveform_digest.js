#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 6) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function fmt(v, d = 6) {
  if (v == null || v === '') return 'n/a';
  const r = round(toNum(v, NaN), d);
  return r == null ? 'n/a' : String(r);
}

function fmtInt(v) {
  if (v == null || v === '') return 'n/a';
  const n = Math.floor(toNum(v, NaN));
  return Number.isFinite(n) ? String(n) : 'n/a';
}

function parseArgs(argv) {
  const out = {
    runDir: 'logs/ops/ws_waveform_pipeline/latest',
    out: 'logs/ops/ws_waveform_digest.txt',
    jsonOut: 'logs/ops/ws_waveform_digest.json',
    top: 5,
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
  const runDirAbs = path.resolve(process.cwd(), args.runDir);
  const source = loadJson(path.join(runDirAbs, 'source', 'summary.json'));
  const wave = loadJson(path.join(runDirAbs, 'waveform', 'waveform_model.json'));
  const liqJoin = loadJson(path.join(runDirAbs, 'liquidation', 'liq_wave_join_summary.json'));
  const liqJoinKeep = loadJson(path.join(runDirAbs, 'liquidation_keep', 'liq_wave_join_summary.json'));
  const liqBase = loadJson(path.join(runDirAbs, 'liquidation', 'liq_summary.json'));
  if (!source?.ok || !wave?.ok) {
    console.error('[ws_waveform_digest] required files are missing or invalid');
    process.exit(1);
  }

  const patterns = Array.isArray(wave.patterns) ? wave.patterns : [];
  const top = patterns.slice(0, args.top).map((p) => ({
    patternName: p.patternName,
    status: p.status,
    uplift: round(toNum(p.uplift, NaN), 6),
    fitRate: round(toNum(p.fitRate, NaN), 6),
    n: toNum(p.n, NaN),
    dailySignStability: round(toNum(p.dailySignStability, NaN), 6),
  }));

  const counts = {
    KEEP: patterns.filter((p) => p.status === 'KEEP').length,
    WATCH: patterns.filter((p) => p.status === 'WATCH').length,
    DROP: patterns.filter((p) => p.status === 'DROP').length,
  };

  const lines = [
    'WS Waveform Pattern Report',
    `RunDir: ${runDirAbs}`,
    `Rows=${toNum(source?.sample?.rows, NaN)}, Dates=${Array.isArray(source?.sample?.dates) ? source.sample.dates.length : 'n/a'}, BaseRate=${round(toNum(wave?.patterns?.[0]?.baseRate, NaN), 6)}`,
    `Counts: KEEP=${counts.KEEP} WATCH=${counts.WATCH} DROP=${counts.DROP}`,
    '',
    '[Top Patterns]',
    ...top.map((p, i) => `${i + 1}. ${p.patternName} status=${p.status} uplift=${p.uplift} fit=${p.fitRate} n=${p.n} stability=${p.dailySignStability}`),
    '',
    '[Liq x Wave Join]',
    `ANY liqEvents=${fmtInt(liqJoin?.nLiqEvents ?? liqBase?.nEvents)} matched=${fmtInt(liqJoin?.matched)} hitMove=${fmtInt(liqJoin?.hitMoveCount)} matchRatio=${fmt(liqJoin?.matchRatio)} hitOnMatched=${fmt(liqJoin?.hitMoveRatioOnMatched)} meanWaveRetBps=${fmt(liqJoin?.meanWaveRetBps)}`,
    `ANY buy[n=${fmtInt(liqJoin?.bySide?.buy?.n)} match=${fmt(liqJoin?.bySide?.buy?.matchRatio)} hit=${fmt(liqJoin?.bySide?.buy?.hitRatioOnMatched)} ret=${fmt(liqJoin?.bySide?.buy?.meanWaveRetBps)}]`,
    `ANY sell[n=${fmtInt(liqJoin?.bySide?.sell?.n)} match=${fmt(liqJoin?.bySide?.sell?.matchRatio)} hit=${fmt(liqJoin?.bySide?.sell?.hitRatioOnMatched)} ret=${fmt(liqJoin?.bySide?.sell?.meanWaveRetBps)}]`,
    `KEEP liqEvents=${fmtInt(liqJoinKeep?.nLiqEvents)} matched=${fmtInt(liqJoinKeep?.matched)} hitMove=${fmtInt(liqJoinKeep?.hitMoveCount)} matchRatio=${fmt(liqJoinKeep?.matchRatio)} hitOnMatched=${fmt(liqJoinKeep?.hitMoveRatioOnMatched)} meanWaveRetBps=${fmt(liqJoinKeep?.meanWaveRetBps)}`,
    `KEEP buy[n=${fmtInt(liqJoinKeep?.bySide?.buy?.n)} match=${fmt(liqJoinKeep?.bySide?.buy?.matchRatio)} hit=${fmt(liqJoinKeep?.bySide?.buy?.hitRatioOnMatched)} ret=${fmt(liqJoinKeep?.bySide?.buy?.meanWaveRetBps)}]`,
    `KEEP sell[n=${fmtInt(liqJoinKeep?.bySide?.sell?.n)} match=${fmt(liqJoinKeep?.bySide?.sell?.matchRatio)} hit=${fmt(liqJoinKeep?.bySide?.sell?.hitRatioOnMatched)} ret=${fmt(liqJoinKeep?.bySide?.sell?.meanWaveRetBps)}]`,
  ].join('\n');

  const digest = {
    ok: true,
    generatedAt: new Date().toISOString(),
    runDir: runDirAbs,
    counts,
    liqJoin: liqJoin ?? null,
    liqJoinKeep: liqJoinKeep ?? null,
    liqBase: liqBase ?? null,
    top,
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
