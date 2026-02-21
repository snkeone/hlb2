#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import minimist from 'minimist';

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw) continue;
    const cols = raw.split(',');
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = cols[j] ?? '';
    rows.push(row);
  }
  return rows;
}

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function percentile(arr, p) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor((s.length - 1) * p)));
  return s[idx];
}

function stageFromCount(n) {
  if (n >= 3000) return 'robust';
  if (n >= 1000) return 'actionable';
  if (n >= 300) return 'provisional';
  return 'insufficient';
}

function stageOrder(stage) {
  switch (stage) {
    case 'robust': return 4;
    case 'actionable': return 3;
    case 'provisional': return 2;
    default: return 1;
  }
}

function mkKey(type, side) {
  return `${type}|${side}`;
}

function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['run-dir'],
    default: {
      'run-dir': '/home/hlws/hlb2/data/validation/run-latest',
      'min-count': 300,
      'min-count-final': 1000,
      'min-delta-p-pos': 0.02,
      'min-delta-hit3': 0.02,
      'max-tail-loss-p95': 3.0
    }
  });

  const runDir = path.resolve(String(argv['run-dir']));
  const eventsPath = path.join(runDir, 'events_labeled.csv');
  const statsPath = path.join(runDir, 'event_stats.csv');

  if (!fs.existsSync(eventsPath) || !fs.existsSync(statsPath)) {
    console.error('[ERR] required files not found in run dir');
    process.exit(1);
  }

  const events = parseCsv(eventsPath);
  const stats = parseCsv(statsPath);

  const realByKey = new Map();
  const placeboByKey = new Map();

  for (const r of stats) {
    const type = r.type;
    const side = r.side;
    const k = mkKey(type, side);
    if (r.cohort === 'real') realByKey.set(k, r);
    if (r.cohort === 'placebo' && r.type === 'placebo_random') placeboByKey.set(side, r);
  }

  const netByKeyReal = new Map();
  const netByKeyPlacebo = new Map();
  for (const r of events) {
    const side = r.side;
    const net30 = toNum(r.net30, NaN);
    if (!Number.isFinite(net30)) continue;
    if (r.cohort === 'real') {
      const k = mkKey(r.type, side);
      const arr = netByKeyReal.get(k) || [];
      arr.push(net30);
      netByKeyReal.set(k, arr);
    } else if (r.cohort === 'placebo') {
      const arr = netByKeyPlacebo.get(side) || [];
      arr.push(net30);
      netByKeyPlacebo.set(side, arr);
    }
  }

  const candidates = [];
  for (const [k, real] of realByKey.entries()) {
    const [type, side] = k.split('|');
    const placebo = placeboByKey.get(side);
    if (!placebo) continue;

    const count = toNum(real.count, 0);
    const stage = stageFromCount(count);

    const avgNetReal = toNum(real.avg_net30, 0);
    const avgNetPl = toNum(placebo.avg_net30, 0);
    const pPosReal = toNum(real.p_net30_pos, 0);
    const pPosPl = toNum(placebo.p_net30_pos, 0);
    const hit3Real = toNum(real.hit3_30_rate, 0);
    const hit3Pl = toNum(placebo.hit3_30_rate, 0);

    const dPos = pPosReal - pPosPl;
    const dHit3 = hit3Real - hit3Pl;
    const liftNet = avgNetReal - avgNetPl;

    const p95LossReal = Math.abs(Math.min(0, percentile(netByKeyReal.get(k) || [], 0.05) ?? 0));
    const p95LossPl = Math.abs(Math.min(0, percentile(netByKeyPlacebo.get(side) || [], 0.05) ?? 0));

    const enoughForScreen = count >= toNum(argv['min-count'], 300);
    const enoughForFinal = count >= toNum(argv['min-count-final'], 1000);

    const passCore = (
      avgNetReal > 0 &&
      dPos >= toNum(argv['min-delta-p-pos'], 0.02) &&
      dHit3 >= toNum(argv['min-delta-hit3'], 0.02) &&
      p95LossReal <= toNum(argv['max-tail-loss-p95'], 3.0)
    );

    let decision = 'reject';
    if (!enoughForScreen) decision = 'hold_sample';
    else if (passCore && enoughForFinal) decision = 'adopt_candidate';
    else if (passCore) decision = 'watchlist';

    candidates.push({
      type,
      side,
      count,
      stage,
      decision,
      avg_net30_real: avgNetReal,
      avg_net30_placebo: avgNetPl,
      lift_net30: liftNet,
      p_net30_pos_real: pPosReal,
      p_net30_pos_placebo: pPosPl,
      delta_p_net30_pos: dPos,
      hit3_30_real: hit3Real,
      hit3_30_placebo: hit3Pl,
      delta_hit3_30: dHit3,
      tail_loss_p95_real: p95LossReal,
      tail_loss_p95_placebo: p95LossPl
    });
  }

  candidates.sort((a, b) => {
    if (stageOrder(b.stage) !== stageOrder(a.stage)) return stageOrder(b.stage) - stageOrder(a.stage);
    if (b.decision !== a.decision) return b.decision.localeCompare(a.decision);
    return (b.lift_net30 - a.lift_net30);
  });

  const summary = {
    runDir,
    generatedAt: new Date().toISOString(),
    thresholds: {
      minCount: toNum(argv['min-count'], 300),
      minCountFinal: toNum(argv['min-count-final'], 1000),
      minDeltaPPos: toNum(argv['min-delta-p-pos'], 0.02),
      minDeltaHit3: toNum(argv['min-delta-hit3'], 0.02),
      maxTailLossP95: toNum(argv['max-tail-loss-p95'], 3.0)
    },
    totals: {
      realRows: events.filter((x) => x.cohort === 'real').length,
      placeboRows: events.filter((x) => x.cohort === 'placebo').length,
      groupsEvaluated: candidates.length,
      adoptCandidates: candidates.filter((x) => x.decision === 'adopt_candidate').length,
      watchlist: candidates.filter((x) => x.decision === 'watchlist').length,
      rejected: candidates.filter((x) => x.decision === 'reject').length,
      holdSample: candidates.filter((x) => x.decision === 'hold_sample').length
    }
  };

  const candHeaders = [
    'type', 'side', 'count', 'stage', 'decision',
    'avg_net30_real', 'avg_net30_placebo', 'lift_net30',
    'p_net30_pos_real', 'p_net30_pos_placebo', 'delta_p_net30_pos',
    'hit3_30_real', 'hit3_30_placebo', 'delta_hit3_30',
    'tail_loss_p95_real', 'tail_loss_p95_placebo'
  ];

  const csvLines = [candHeaders.join(',')];
  for (const c of candidates) {
    csvLines.push(candHeaders.map((h) => String(c[h] ?? '')).join(','));
  }

  const summaryTxt = [
    'HLB2 Validation Judgement',
    `generatedAt: ${summary.generatedAt}`,
    `runDir: ${runDir}`,
    '',
    `[totals] real=${summary.totals.realRows} placebo=${summary.totals.placeboRows} groups=${summary.totals.groupsEvaluated}`,
    `[decision] adopt=${summary.totals.adoptCandidates} watchlist=${summary.totals.watchlist} reject=${summary.totals.rejected} hold_sample=${summary.totals.holdSample}`,
    '',
    '[top candidates]'
  ];

  for (const c of candidates.slice(0, 10)) {
    summaryTxt.push(`${c.type}/${c.side} decision=${c.decision} stage=${c.stage} count=${c.count} liftNet=${c.lift_net30.toFixed(4)} dP=${c.delta_p_net30_pos.toFixed(4)} dHit3=${c.delta_hit3_30.toFixed(4)}`);
  }

  fs.writeFileSync(path.join(runDir, 'validation_judgement.json'), JSON.stringify({ summary, candidates }, null, 2));
  fs.writeFileSync(path.join(runDir, 'validation_candidates.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(runDir, 'validation_summary.txt'), `${summaryTxt.join('\n')}\n`);

  console.log(JSON.stringify(summary, null, 2));
}

main();
