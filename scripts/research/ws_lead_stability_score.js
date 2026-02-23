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

function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function variance(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const m = mean(arr);
  if (!Number.isFinite(m)) return null;
  return arr.reduce((acc, x) => acc + ((x - m) ** 2), 0) / arr.length;
}

function parseArgs(argv) {
  const out = {
    inDir: 'logs/ops',
    prefix: 'ws_lead_indicator_scan',
    minDays: 2,
    out: 'logs/ops/ws_lead_stability_score_latest.json',
    top: 20,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--in-dir') out.inDir = String(argv[++i] ?? out.inDir);
    else if (a === '--prefix') out.prefix = String(argv[++i] ?? out.prefix);
    else if (a === '--min-days') out.minDays = Math.max(1, Math.floor(toNum(argv[++i], out.minDays)));
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--top') out.top = Math.max(1, Math.floor(toNum(argv[++i], out.top)));
  }

  return out;
}

function listReports(inDir, pattern) {
  const absDir = path.resolve(process.cwd(), inDir);
  if (!fs.existsSync(absDir)) return [];

  const files = fs.readdirSync(absDir)
    .map((name) => {
      const m = name.match(pattern);
      if (!m) return null;
      return {
        file: path.join(absDir, name),
        date: m[1],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  return files;
}

function loadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractFeatureLiftMap(report) {
  const map = new Map();
  const rows = Array.isArray(report?.leadSignalsAll) ? report.leadSignalsAll : [];
  for (const row of rows) {
    const feature = String(row?.feature ?? '');
    const lift = toNum(row?.repeatabilityLift, NaN);
    const usable = row?.usable === true;
    if (!feature || !usable || !Number.isFinite(lift)) continue;
    map.set(feature, lift);
  }
  return map;
}

function buildStabilityRows(reports, minDays) {
  const featureMap = new Map();
  const byDay = [];

  for (const rep of reports) {
    const liftMap = extractFeatureLiftMap(rep.data);
    byDay.push({ date: rep.date, liftMap });
    for (const [feature] of liftMap) {
      if (!featureMap.has(feature)) featureMap.set(feature, []);
    }
  }

  for (const [feature, _arr] of featureMap) {
    const vals = [];
    for (const day of byDay) {
      const v = day.liftMap.get(feature);
      if (Number.isFinite(v)) vals.push(v);
    }
    featureMap.set(feature, vals);
  }

  const rows = [];
  for (const [feature, vals] of featureMap) {
    if (vals.length < minDays) continue;
    const posDays = vals.filter((v) => v > 0).length;
    rows.push({
      feature,
      sampleDays: vals.length,
      avgLift: round(mean(vals), 4),
      signConsistencyRate: round(posDays / vals.length, 4),
      dailyVariance: round(variance(vals), 6),
      minLift: round(Math.min(...vals), 4),
      maxLift: round(Math.max(...vals), 4),
      liftsByDay: vals.map((v) => round(v, 4)),
    });
  }

  rows.sort((a, b) => {
    const av = Number.isFinite(a.avgLift) ? a.avgLift : -Infinity;
    const bv = Number.isFinite(b.avgLift) ? b.avgLift : -Infinity;
    if (bv !== av) return bv - av;
    const as = Number.isFinite(a.signConsistencyRate) ? a.signConsistencyRate : -Infinity;
    const bs = Number.isFinite(b.signConsistencyRate) ? b.signConsistencyRate : -Infinity;
    if (bs !== as) return bs - as;
    const avar = Number.isFinite(a.dailyVariance) ? a.dailyVariance : Infinity;
    const bvar = Number.isFinite(b.dailyVariance) ? b.dailyVariance : Infinity;
    return avar - bvar;
  });

  return rows;
}

function main() {
  const args = parseArgs(process.argv);
  const escapedPrefix = args.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedPrefix}_(\\d{8})\\.json$`);
  const reportFiles = listReports(args.inDir, pattern);
  if (reportFiles.length === 0) {
    const out = {
      ok: false,
      reason: 'no_reports_found',
      inDir: path.resolve(process.cwd(), args.inDir),
      prefix: args.prefix,
      pattern: String(pattern),
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  const reports = reportFiles
    .map((f) => ({ ...f, data: loadJson(f.file) }))
    .filter((x) => x.data && x.data.ok === true);

  const rows = buildStabilityRows(reports, args.minDays);
  const topRows = rows.slice(0, args.top);

  const output = {
    ok: true,
    generatedAt: new Date().toISOString(),
    input: {
      inDir: path.resolve(process.cwd(), args.inDir),
      prefix: args.prefix,
      minDays: args.minDays,
      reportsFound: reports.length,
      reportDates: reports.map((r) => r.date),
    },
    scoring: {
      metrics: [
        'avgLift',
        'signConsistencyRate',
        'dailyVariance',
      ],
      notes: [
        'avgLift: mean of repeatabilityLift across available days.',
        'signConsistencyRate: fraction of days where lift > 0.',
        'dailyVariance: variance of day-level lift (lower = more stable).',
      ],
    },
    topFeatures: topRows,
    allFeatures: rows,
  };

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

main();
