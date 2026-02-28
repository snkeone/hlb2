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
  if (!Number.isFinite(v)) return 'n/a';
  const r = round(v, d);
  return r == null ? 'n/a' : String(r);
}

function fmtInt(v) {
  if (!Number.isFinite(v)) return 'n/a';
  return String(Math.round(v));
}

function parseArgs(argv) {
  const out = {
    runsDir: 'logs/ops/ws_waveform_pipeline/runs',
    out: 'logs/ops/ws_waveform_motif_watch_digest_scheduled.txt',
    jsonOut: 'logs/ops/ws_waveform_motif_watch_digest_scheduled.json',
    alertConsecutiveDeclines: 2,
    maxRuns: 30,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--runs-dir') out.runsDir = String(argv[++i] ?? out.runsDir);
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--json-out') out.jsonOut = String(argv[++i] ?? out.jsonOut);
    else if (a === '--alert-consecutive-declines') out.alertConsecutiveDeclines = Math.max(1, Math.floor(toNum(argv[++i], out.alertConsecutiveDeclines)));
    else if (a === '--max-runs') out.maxRuns = Math.max(3, Math.floor(toNum(argv[++i], out.maxRuns)));
  }
  return out;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readCsvRows(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    if (lines.length < 2) return [];
    const header = lines[0].split(',');
    return lines.slice(1).map((line) => {
      const cols = line.split(',');
      const row = {};
      for (let i = 0; i < header.length; i += 1) row[header[i]] = cols[i];
      return row;
    });
  } catch {
    return [];
  }
}

function parsePatternTokens(patternName) {
  const clean = String(patternName || '').replace(/^WF\d+_/, '');
  if (!clean) return [];
  const t = clean.split('_');
  const out = [];
  for (let i = 0; i + 1 < t.length; i += 2) out.push({ dir: t[i], feat: t[i + 1] });
  return out;
}

function hasPair(tokens, featA, featB) {
  const a = tokens.find((x) => x.feat === featA);
  const b = tokens.find((x) => x.feat === featB);
  if (!a || !b) return false;
  return a.dir === b.dir;
}

function calcDeclineStreak(series) {
  const vals = series.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return 0;
  let streak = 0;
  for (let i = vals.length - 1; i >= 1; i -= 1) {
    if (vals[i] < vals[i - 1]) streak += 1;
    else break;
  }
  return streak;
}

function motifStats(rows, motif) {
  let totalN = 0;
  let totalU = 0;
  let keepN = 0;
  let keepU = 0;
  let hitRows = 0;
  for (const r of rows) {
    const n = toNum(r.n, 0);
    const u = toNum(r.uplift, NaN);
    const status = String(r.status || '');
    const tokens = parsePatternTokens(r.patternName);
    if (!tokens.some((x) => x.feat === motif)) continue;
    hitRows += 1;
    totalN += n;
    if (Number.isFinite(u)) totalU += n * u;
    if (status === 'KEEP') {
      keepN += n;
      if (Number.isFinite(u)) keepU += n * u;
    }
  }
  return {
    motif,
    patternRows: hitRows,
    weightedN: totalN,
    weightedUplift: totalN > 0 ? totalU / totalN : null,
    keepWeightedN: keepN,
    keepWeightedUplift: keepN > 0 ? keepU / keepN : null,
  };
}

function perRunMotifValue(rows, motif) {
  let nSum = 0;
  let uSum = 0;
  for (const r of rows) {
    const n = toNum(r.n, 0);
    const u = toNum(r.uplift, NaN);
    if (!Number.isFinite(u)) continue;
    const tokens = parsePatternTokens(r.patternName);
    if (!tokens.some((x) => x.feat === motif)) continue;
    nSum += n;
    uSum += n * u;
  }
  return nSum > 0 ? uSum / nSum : null;
}

function main() {
  const args = parseArgs(process.argv);
  const runsDirAbs = path.resolve(process.cwd(), args.runsDir);
  const outAbs = path.resolve(process.cwd(), args.out);
  const jsonOutAbs = path.resolve(process.cwd(), args.jsonOut);

  const runIds = fs.existsSync(runsDirAbs)
    ? fs.readdirSync(runsDirAbs).filter((d) => /^\d{8}T\d{6}Z$/.test(d)).sort().slice(-args.maxRuns)
    : [];

  const runs = [];
  for (const runId of runIds) {
    const runDir = path.join(runsDirAbs, runId);
    const digest = readJson(path.join(runDir, 'ws_waveform_digest_scheduled.json'));
    const patterns = readCsvRows(path.join(runDir, 'waveform', 'waveform_patterns.csv'));
    if (!digest || !patterns.length) continue;
    runs.push({ runId, runDir, digest, patterns });
  }

  if (!runs.length) {
    console.error('[ws_waveform_motif_watch_digest] no valid runs found');
    process.exit(1);
  }

  const motifs = ['tradeRate', 'avgSpreadBps', 'microDriftBps'];
  const allRows = runs.flatMap((r) => r.patterns);
  const motifSummary = motifs.map((m) => motifStats(allRows, m));

  const sameDirTradeSpread = (() => {
    let nSum = 0;
    let uSum = 0;
    let rows = 0;
    for (const r of allRows) {
      const tokens = parsePatternTokens(r.patternName);
      if (!hasPair(tokens, 'tradeRate', 'avgSpreadBps')) continue;
      const n = toNum(r.n, 0);
      const u = toNum(r.uplift, NaN);
      rows += 1;
      nSum += n;
      if (Number.isFinite(u)) uSum += n * u;
    }
    return {
      patternRows: rows,
      weightedN: nSum,
      weightedUplift: nSum > 0 ? uSum / nSum : null,
    };
  })();

  const runLines = runs.map((r) => {
    const c = r.digest?.counts || {};
    const liqAny = r.digest?.liqJoin?.meanWaveRetBps;
    const liqKeep = r.digest?.liqJoinKeep?.meanWaveRetBps;
    return `${r.runId} KEEP=${fmtInt(toNum(c.KEEP, NaN))} WATCH=${fmtInt(toNum(c.WATCH, NaN))} DROP=${fmtInt(toNum(c.DROP, NaN))} liqANY=${fmt(toNum(liqAny, NaN), 4)} liqKEEP=${fmt(toNum(liqKeep, NaN), 4)}`;
  });

  const recentSeries = motifs.map((m) => {
    const vals = runs.map((r) => perRunMotifValue(r.patterns, m));
    const streak = calcDeclineStreak(vals);
    return {
      motif: m,
      recentValues: vals.slice(-5).map((v) => (Number.isFinite(v) ? round(v, 6) : null)),
      declineStreak: streak,
      alert: streak >= args.alertConsecutiveDeclines,
    };
  });

  const alertLines = recentSeries
    .filter((x) => x.alert)
    .map((x) => `ALERT ${x.motif}: decline_streak=${x.declineStreak} recent=${JSON.stringify(x.recentValues)}`);

  const lines = [
    'WS Waveform Motif Watch Report',
    `RunsDir: ${runsDirAbs}`,
    `RunsUsed=${runs.length} (latest=${runs[runs.length - 1].runId})`,
    '',
    '[Core Motifs]',
    ...motifSummary.map((m) => `${m.motif} rows=${m.patternRows} weightedN=${fmtInt(m.weightedN)} weightedUplift=${fmt(toNum(m.weightedUplift, NaN))} keepWeightedN=${fmtInt(m.keepWeightedN)} keepWeightedUplift=${fmt(toNum(m.keepWeightedUplift, NaN))}`),
    '',
    '[Combo: tradeRate x avgSpreadBps (same direction)]',
    `rows=${sameDirTradeSpread.patternRows} weightedN=${fmtInt(sameDirTradeSpread.weightedN)} weightedUplift=${fmt(toNum(sameDirTradeSpread.weightedUplift, NaN))}`,
    '',
    '[Recent Trend Check]',
    ...recentSeries.map((r) => `${r.motif} declineStreak=${r.declineStreak} recent5=${JSON.stringify(r.recentValues)}`),
    ...(alertLines.length ? ['', '[Alerts]', ...alertLines] : ['', '[Alerts]', 'none']),
    '',
    '[Runs Snapshot]',
    ...runLines,
  ].join('\n');

  const outJson = {
    ok: true,
    generatedAt: new Date().toISOString(),
    runsDir: runsDirAbs,
    runsUsed: runs.map((r) => r.runId),
    motifSummary,
    sameDirTradeSpread,
    recentSeries,
    alerts: alertLines,
    runsSnapshot: runs.map((r) => ({
      runId: r.runId,
      counts: r.digest?.counts ?? null,
      liqAnyMeanWaveRetBps: r.digest?.liqJoin?.meanWaveRetBps ?? null,
      liqKeepMeanWaveRetBps: r.digest?.liqJoinKeep?.meanWaveRetBps ?? null,
      top1: r.digest?.top?.[0] ?? null,
    })),
    text: lines,
  };

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.mkdirSync(path.dirname(jsonOutAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${lines}\n`, 'utf8');
  fs.writeFileSync(jsonOutAbs, `${JSON.stringify(outJson, null, 2)}\n`, 'utf8');
  console.log(lines);
}

main();
