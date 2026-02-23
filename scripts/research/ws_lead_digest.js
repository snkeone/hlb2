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

function loadJson(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    mode: 'daily',
    inDir: 'logs/ops',
    days: 7,
    out: 'logs/ops/ws_lead_digest_daily.txt',
    jsonOut: 'logs/ops/ws_lead_digest_daily.json',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--mode') out.mode = String(argv[++i] ?? out.mode);
    else if (a === '--in-dir') out.inDir = String(argv[++i] ?? out.inDir);
    else if (a === '--days') out.days = Math.max(2, Math.floor(toNum(argv[++i], out.days)));
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
    else if (a === '--json-out') out.jsonOut = String(argv[++i] ?? out.jsonOut);
  }
  return out;
}

function pickTopFeatureNames(stability, n = 3) {
  const top = Array.isArray(stability?.topFeatures) ? stability.topFeatures.slice(0, n) : [];
  return top.map((x) => `${x.feature}(${round(toNum(x.avgLift, NaN), 3)})`);
}

function findHorizon(summary, horizonName) {
  const arr = Array.isArray(summary?.latest) ? summary.latest : [];
  return arr.find((x) => x?.horizon === horizonName) ?? null;
}

function dailyDigest(summary, shortStability, midStability, relation) {
  const latestDate = summary?.latestDate ?? 'n/a';
  const short = findHorizon(summary, 'short');
  const mid = findHorizon(summary, 'mid');

  const shortTop = (short?.topSignals ?? []).slice(0, 3).map((x) => `${x.feature}:${round(toNum(x.lift, NaN), 3)}`).join(', ');
  const midTop = (mid?.topSignals ?? []).slice(0, 3).map((x) => `${x.feature}:${round(toNum(x.lift, NaN), 3)}`).join(', ');

  const shortEvents = toNum(short?.sample?.events, NaN);
  const midEvents = toNum(mid?.sample?.events, NaN);
  const shortComp2 = toNum(short?.composite2of3?.lift, NaN);
  const midComp2 = toNum(mid?.composite2of3?.lift, NaN);

  const checks = {
    shortSampleOk: Number.isFinite(shortEvents) && shortEvents >= 20,
    midSampleOk: Number.isFinite(midEvents) && midEvents >= 15,
    shortCompPositive: Number.isFinite(shortComp2) && shortComp2 > 0,
    midCompPositive: Number.isFinite(midComp2) && midComp2 > 0,
  };

  const passCount = Object.values(checks).filter(Boolean).length;
  const gate = passCount === 4 ? 'GREEN' : passCount >= 2 ? 'YELLOW' : 'RED';

  const text = [
    `WS Lead Daily (${latestDate})`,
    `Gate: ${gate} (${passCount}/4 checks passed)`,
    ``,
    `[Short] events=${shortEvents}, comp2Lift=${round(shortComp2, 4)}, comp3Lift=${round(toNum(short?.composite3of3?.lift, NaN), 4)}`,
    `[Short] top=${shortTop || 'n/a'}`,
    `[Short stability] top=${pickTopFeatureNames(shortStability, 3).join(', ') || 'n/a'}`,
    ``,
    `[Mid] events=${midEvents}, comp2Lift=${round(midComp2, 4)}, comp3Lift=${round(toNum(mid?.composite3of3?.lift, NaN), 4)}`,
    `[Mid] top=${midTop || 'n/a'}`,
    `[Mid stability] top=${pickTopFeatureNames(midStability, 3).join(', ') || 'n/a'}`,
    ``,
    `[Relation] pairedDays=${relation?.counts?.pairedDays ?? 'n/a'}, top3Corr=${relation?.relation?.top3AvgLiftPearson ?? null}, shortStrongMidWeakRate=${relation?.relation?.shortStrongMidWeakRate ?? null}`,
  ].join('\n');

  return {
    mode: 'daily',
    latestDate,
    gate,
    checks,
    summary: {
      short: {
        events: shortEvents,
        composite2Lift: round(shortComp2, 4),
        composite3Lift: round(toNum(short?.composite3of3?.lift, NaN), 4),
        top3: (short?.topSignals ?? []).slice(0, 3),
      },
      mid: {
        events: midEvents,
        composite2Lift: round(midComp2, 4),
        composite3Lift: round(toNum(mid?.composite3of3?.lift, NaN), 4),
        top3: (mid?.topSignals ?? []).slice(0, 3),
      },
      relation: relation?.relation ?? null,
    },
    text,
  };
}

function weeklyDigest(summary, shortStability, midStability, relation, days) {
  const daily = Array.isArray(relation?.daily) ? relation.daily : [];
  const scope = daily.slice(-days);

  const shortComp2 = scope.map((d) => toNum(d?.short?.composite2of3Lift, NaN)).filter(Number.isFinite);
  const midComp2 = scope.map((d) => toNum(d?.mid?.composite2of3Lift, NaN)).filter(Number.isFinite);
  const shortTop3 = scope.map((d) => toNum(d?.short?.top3AvgLift, NaN)).filter(Number.isFinite);
  const midTop3 = scope.map((d) => toNum(d?.mid?.top3AvgLift, NaN)).filter(Number.isFinite);

  const shortWeakDays = scope.filter((d) => d?.weakFlags?.shortWeak === true).map((d) => d.date);
  const midWeakDays = scope.filter((d) => d?.weakFlags?.midWeak === true).map((d) => d.date);

  const week = {
    rangeStart: scope.length > 0 ? scope[0].date : null,
    rangeEnd: scope.length > 0 ? scope[scope.length - 1].date : null,
    observedDays: scope.length,
    avgShortComp2Lift: round(mean(shortComp2), 4),
    avgMidComp2Lift: round(mean(midComp2), 4),
    avgShortTop3Lift: round(mean(shortTop3), 4),
    avgMidTop3Lift: round(mean(midTop3), 4),
    shortWeakDays,
    midWeakDays,
    shortWeakRate: scope.length > 0 ? round(shortWeakDays.length / scope.length, 4) : null,
    midWeakRate: scope.length > 0 ? round(midWeakDays.length / scope.length, 4) : null,
  };

  const text = [
    `WS Lead Weekly (${week.rangeStart ?? 'n/a'}~${week.rangeEnd ?? 'n/a'})`,
    `ObservedDays: ${week.observedDays}`,
    ``,
    `[Short avg] comp2Lift=${week.avgShortComp2Lift}, top3Lift=${week.avgShortTop3Lift}, weakRate=${week.shortWeakRate}`,
    `[Mid avg] comp2Lift=${week.avgMidComp2Lift}, top3Lift=${week.avgMidTop3Lift}, weakRate=${week.midWeakRate}`,
    ``,
    `[Short stability top] ${pickTopFeatureNames(shortStability, 3).join(', ') || 'n/a'}`,
    `[Mid stability top] ${pickTopFeatureNames(midStability, 3).join(', ') || 'n/a'}`,
    ``,
    `[Relation] pairedDays=${relation?.counts?.pairedDays ?? 'n/a'}, top3Corr=${relation?.relation?.top3AvgLiftPearson ?? null}, comp2Corr=${relation?.relation?.composite2of3LiftPearson ?? null}`,
    `[Note] shortWeakMidStrong split check: ${relation?.relation?.shortStrongMidWeakRate ?? null}`,
  ].join('\n');

  return {
    mode: 'weekly',
    days,
    week,
    text,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const base = args.inDir;

  const summary = loadJson(path.join(base, 'ws_lead_multi_horizon_summary.json'));
  const shortStability = loadJson(path.join(base, 'ws_lead_stability_score_short.json'));
  const midStability = loadJson(path.join(base, 'ws_lead_stability_score_mid.json'));
  const relation = loadJson(path.join(base, 'ws_lead_horizon_relation_latest.json'));

  if (!summary?.ok || !shortStability?.ok || !midStability?.ok || !relation?.ok) {
    console.error('[ws_lead_digest] required input files are missing or invalid');
    process.exit(1);
  }

  let digest;
  if (args.mode === 'weekly') digest = weeklyDigest(summary, shortStability, midStability, relation, args.days);
  else digest = dailyDigest(summary, shortStability, midStability, relation);

  const output = {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode: digest.mode,
    digest,
  };

  const outPath = path.resolve(process.cwd(), args.out);
  const jsonOutPath = path.resolve(process.cwd(), args.jsonOut);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
  fs.writeFileSync(outPath, `${digest.text}\n`, 'utf8');
  fs.writeFileSync(jsonOutPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(digest.text);
}

main();
