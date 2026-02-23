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

function pearson(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys)) return null;
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function parseArgs(argv) {
  const out = {
    inDir: 'logs/ops',
    shortPrefix: 'ws_lead_indicator_scan_short',
    midPrefix: 'ws_lead_indicator_scan_mid',
    out: 'logs/ops/ws_lead_horizon_relation_latest.json',
    weakThreshold: 0.1,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--in-dir') out.inDir = String(argv[++i] ?? out.inDir);
    else if (a === '--short-prefix') out.shortPrefix = String(argv[++i] ?? out.shortPrefix);
    else if (a === '--mid-prefix') out.midPrefix = String(argv[++i] ?? out.midPrefix);
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--weak-threshold') out.weakThreshold = Math.max(0, toNum(argv[++i], out.weakThreshold));
  }

  return out;
}

function loadByPrefix(inDir, prefix) {
  const abs = path.resolve(process.cwd(), inDir);
  if (!fs.existsSync(abs)) return [];

  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}_(\\d{8})\\.json$`);

  return fs.readdirSync(abs)
    .map((name) => {
      const m = name.match(re);
      if (!m) return null;
      const full = path.join(abs, name);
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (data?.ok !== true) return null;
        return { date: m[1], path: full, data };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function topAvgLift(report, topN = 3) {
  const arr = Array.isArray(report?.leadSignalsTop) ? report.leadSignalsTop : [];
  const vals = arr
    .slice(0, topN)
    .map((x) => toNum(x?.repeatabilityLift, NaN))
    .filter(Number.isFinite);
  return vals.length > 0 ? mean(vals) : null;
}

function dayMetrics(report) {
  return {
    events: toNum(report?.sample?.events, NaN),
    controls: toNum(report?.sample?.controls, NaN),
    composite2of3Lift: toNum(report?.compositeSignals?.match2of3?.lift, NaN),
    composite3of3Lift: toNum(report?.compositeSignals?.match3of3?.lift, NaN),
    top3AvgLift: topAvgLift(report, 3),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const shortRows = loadByPrefix(args.inDir, args.shortPrefix);
  const midRows = loadByPrefix(args.inDir, args.midPrefix);

  const shortByDate = new Map(shortRows.map((x) => [x.date, x]));
  const midByDate = new Map(midRows.map((x) => [x.date, x]));
  const dates = [...new Set([...shortByDate.keys(), ...midByDate.keys()])].sort();

  const daily = [];
  const pairedTop3Short = [];
  const pairedTop3Mid = [];
  const pairedComp2Short = [];
  const pairedComp2Mid = [];

  for (const date of dates) {
    const s = shortByDate.get(date);
    const m = midByDate.get(date);
    const sm = s ? dayMetrics(s.data) : null;
    const mm = m ? dayMetrics(m.data) : null;

    if (sm && mm) {
      if (Number.isFinite(sm.top3AvgLift) && Number.isFinite(mm.top3AvgLift)) {
        pairedTop3Short.push(sm.top3AvgLift);
        pairedTop3Mid.push(mm.top3AvgLift);
      }
      if (Number.isFinite(sm.composite2of3Lift) && Number.isFinite(mm.composite2of3Lift)) {
        pairedComp2Short.push(sm.composite2of3Lift);
        pairedComp2Mid.push(mm.composite2of3Lift);
      }
    }

    const shortWeak = sm ? (Number.isFinite(sm.top3AvgLift) ? sm.top3AvgLift < args.weakThreshold : null) : null;
    const midWeak = mm ? (Number.isFinite(mm.top3AvgLift) ? mm.top3AvgLift < args.weakThreshold : null) : null;

    daily.push({
      date,
      short: sm,
      mid: mm,
      weakFlags: {
        threshold: args.weakThreshold,
        shortWeak,
        midWeak,
      },
    });
  }

  const bothAvailable = daily.filter((d) => d.short && d.mid);
  const shortStrongMidWeakDays = bothAvailable
    .filter((d) => d.weakFlags.shortWeak === false && d.weakFlags.midWeak === true)
    .map((d) => d.date);

  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    input: {
      inDir: path.resolve(process.cwd(), args.inDir),
      shortPrefix: args.shortPrefix,
      midPrefix: args.midPrefix,
      weakThreshold: args.weakThreshold,
    },
    counts: {
      shortDays: shortRows.length,
      midDays: midRows.length,
      pairedDays: bothAvailable.length,
    },
    relation: {
      top3AvgLiftPearson: round(pearson(pairedTop3Short, pairedTop3Mid), 4),
      composite2of3LiftPearson: round(pearson(pairedComp2Short, pairedComp2Mid), 4),
      shortStrongMidWeakDays,
      shortStrongMidWeakRate: bothAvailable.length > 0
        ? round(shortStrongMidWeakDays.length / bothAvailable.length, 4)
        : null,
      note: 'With very small pairedDays, correlation is indicative only.',
    },
    daily,
  };

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
