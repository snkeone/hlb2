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

function mean(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parseCsv(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const txt = fs.readFileSync(csvPath, 'utf8').trim();
  if (!txt) return [];
  const lines = txt.split('\n');
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = cols[j] ?? '';
    rows.push(row);
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return `${[keys.join(',')].concat(rows.map((r) => keys.map((k) => esc(r[k])).join(','))).join('\n')}\n`;
}

function parseArgs(argv) {
  const out = {
    liqEventsCsv: 'logs/ops/ws_liq_monitor/latest/liq_events.csv',
    waveEventsCsv: 'logs/ops/ws_waveform_pipeline/latest/source/events_all.csv',
    outDir: 'logs/ops/ws_liq_monitor/latest',
    matchWindowSec: 30,
    moveBps: 5,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--liq-events-csv') out.liqEventsCsv = String(argv[++i] ?? out.liqEventsCsv);
    else if (a === '--wave-events-csv') out.waveEventsCsv = String(argv[++i] ?? out.waveEventsCsv);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--match-window-sec') out.matchWindowSec = Math.max(1, Math.floor(toNum(argv[++i], out.matchWindowSec)));
    else if (a === '--move-bps') out.moveBps = Math.max(0.1, toNum(argv[++i], out.moveBps));
  }
  return out;
}

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].sec < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestWave(waves, sec0, winSec) {
  if (!waves.length) return null;
  const p = lowerBound(waves, sec0);
  const cand = [];
  if (p > 0) cand.push(waves[p - 1]);
  if (p < waves.length) cand.push(waves[p]);
  if (p + 1 < waves.length) cand.push(waves[p + 1]);
  let best = null;
  let bestAbs = Infinity;
  for (const c of cand) {
    const d = Math.abs(c.sec - sec0);
    if (d <= winSec && d < bestAbs) {
      best = c;
      bestAbs = d;
    }
  }
  return best;
}

function main() {
  const args = parseArgs(process.argv);
  const liqRows = parseCsv(path.resolve(process.cwd(), args.liqEventsCsv));
  const waveRows = parseCsv(path.resolve(process.cwd(), args.waveEventsCsv));

  const waves = waveRows
    .map((r) => {
      const sec = toNum(r.sec, NaN);
      const retBps = toNum(r.retBps, NaN);
      return Number.isFinite(sec) && Number.isFinite(retBps)
        ? { sec, retBps, date: String(r.date ?? '') }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.sec - b.sec);

  const joined = liqRows.map((r) => {
    const sec = toNum(r.tsSec, NaN);
    if (!Number.isFinite(sec)) {
      return { ...r, waveMatched: 0, waveHitMove: 0, waveDeltaSec: null, waveRetBps: null, waveDate: null };
    }
    const w = nearestWave(waves, sec, args.matchWindowSec);
    const waveMatched = !!w;
    const waveRetBps = w ? w.retBps : NaN;
    const waveHitMove = w ? (Math.abs(waveRetBps) >= args.moveBps ? 1 : 0) : 0;
    return {
      ...r,
      waveMatched: waveMatched ? 1 : 0,
      waveHitMove,
      waveDeltaSec: w ? (w.sec - sec) : null,
      waveRetBps: Number.isFinite(waveRetBps) ? round(waveRetBps, 6) : null,
      waveDate: w ? w.date : null,
    };
  });

  const n = joined.length;
  const matched = joined.filter((x) => toNum(x.waveMatched, 0) === 1);
  const hits = matched.filter((x) => toNum(x.waveHitMove, 0) === 1);
  const meanWaveRet = mean(matched.map((x) => toNum(x.waveRetBps, NaN)).filter(Number.isFinite));

  const bySide = {};
  for (const side of ['buy', 'sell']) {
    const xs = joined.filter((x) => String(x.burstSide || '') === side);
    const xm = xs.filter((x) => toNum(x.waveMatched, 0) === 1);
    const xh = xm.filter((x) => toNum(x.waveHitMove, 0) === 1);
    bySide[side] = {
      n: xs.length,
      matched: xm.length,
      matchRatio: xs.length > 0 ? round(xm.length / xs.length, 6) : null,
      hitRatioOnMatched: xm.length > 0 ? round(xh.length / xm.length, 6) : null,
      meanWaveRetBps: round(mean(xm.map((x) => toNum(x.waveRetBps, NaN)).filter(Number.isFinite)), 6),
    };
  }

  const outDirAbs = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'liq_wave_join.csv'), toCsv(joined), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'liq_wave_join_summary.json'), `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    params: {
      liqEventsCsv: path.resolve(process.cwd(), args.liqEventsCsv),
      waveEventsCsv: path.resolve(process.cwd(), args.waveEventsCsv),
      matchWindowSec: args.matchWindowSec,
      moveBps: args.moveBps,
    },
    nLiqEvents: n,
    matched: matched.length,
    matchRatio: n > 0 ? round(matched.length / n, 6) : null,
    hitMoveCount: hits.length,
    hitMoveRatioOnMatched: matched.length > 0 ? round(hits.length / matched.length, 6) : null,
    meanWaveRetBps: round(meanWaveRet, 6),
    bySide,
  }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    nLiqEvents: n,
    matched: matched.length,
    hitMoveCount: hits.length,
  }, null, 2));
}

main();
