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
      'min-count-final': 1000
    }
  });

  const runDir = path.resolve(String(argv['run-dir']));
  const eventsPath = path.join(runDir, 'events_labeled.csv');

  if (!fs.existsSync(eventsPath)) {
    console.error('[ERR] required files not found in run dir');
    process.exit(1);
  }

  const events = parseCsv(eventsPath);

  const groups = new Map();
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const r of events) {
    const ts = toNum(r.ts, NaN);
    if (!Number.isFinite(ts)) continue;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;

    const net = toNum(r.net30Pes, NaN);
    if (!Number.isFinite(net)) continue;

    const k = `${r.cohort}|${r.type}|${r.side}`;
    const g = groups.get(k) || [];
    g.push({ ts, net });
    groups.set(k, g);
  }

  const durationDays = Math.max(1, (maxTs - minTs) / 86400000);

  const realMetrics = new Map();
  const placeboMetrics = new Map();

  for (const [k, arr] of groups.entries()) {
    const parts = k.split('|');
    const cohort = parts[0];
    const type = parts[1];
    const side = parts[2];

    arr.sort((a, b) => a.ts - b.ts);

    let sumNet = 0;
    let sumWin = 0;
    let countWin = 0;
    let currentConsLoss = 0;
    let maxConsLoss = 0;
    let cml = 0;
    let peakCml = 0;
    let maxDD = 0;
    const netArr = [];

    for (const r of arr) {
      const net = r.net;
      netArr.push(net);
      sumNet += net;
      if (net > 0) {
        sumWin += net;
        countWin += 1;
        currentConsLoss = 0;
      } else if (net < 0) {
        currentConsLoss += 1;
        if (currentConsLoss > maxConsLoss) maxConsLoss = currentConsLoss;
      }
      cml += net;
      if (cml > peakCml) peakCml = cml;
      const dd = peakCml - cml;
      if (dd > maxDD) maxDD = dd;
    }

    const count = arr.length;
    const avgNet = sumNet / count;
    const pPos = countWin / count;
    const meanWin = countWin > 0 ? sumWin / countWin : 0;
    const p95Loss = Math.abs(Math.min(0, percentile(netArr, 0.05) ?? 0));
    const avgDailyNet = sumNet / durationDays;

    let grossLoss = 0;
    for (const net of netArr) if (net < 0) grossLoss -= net;
    const pf = grossLoss > 0 ? sumWin / grossLoss : 999;

    const metrics = {
      type, side, count,
      avgNet, pPos, meanWin, p95Loss, maxConsLoss, maxDD, avgDailyNet, pf
    };

    if (cohort === 'real') {
      realMetrics.set(`${type}|${side}`, metrics);
    } else if (cohort === 'placebo' && type === 'placebo_random') {
      placeboMetrics.set(side, metrics);
    }
  }

  const candidates = [];
  for (const [k, real] of realMetrics.entries()) {
    const placebo = placeboMetrics.get(real.side) || { avgNet: 0, pPos: 0 };

    const count = real.count;
    const stage = stageFromCount(count);

    const enoughForScreen = count >= toNum(argv['min-count'], 300);
    const enoughForFinal = count >= toNum(argv['min-count-final'], 1000);

    const passCore = (
      real.avgNet > 0 &&
      real.pPos >= 0.55 &&
      real.p95Loss <= 3.5 * real.meanWin &&
      real.maxConsLoss <= 12 &&
      real.maxDD <= Math.max(0, 5 * real.avgDailyNet)
    );

    let decision = 'reject';
    if (!enoughForScreen) decision = 'hold_sample';
    else if (passCore && enoughForFinal) decision = 'adopt_candidate';
    else if (passCore) decision = 'watchlist';

    candidates.push({
      type: real.type,
      side: real.side,
      count,
      stage,
      decision,
      avg_net_real: real.avgNet,
      avg_net_placebo: placebo.avgNet,
      p_pos_real: real.pPos,
      p_pos_placebo: placebo.pPos,
      mean_win_real: real.meanWin,
      p95_loss_real: real.p95Loss,
      max_dd_real: real.maxDD,
      max_cons_loss_real: real.maxConsLoss,
      pf_real: real.pf
    });
  }

  candidates.sort((a, b) => {
    if (stageOrder(b.stage) !== stageOrder(a.stage)) return stageOrder(b.stage) - stageOrder(a.stage);
    if (b.decision !== a.decision) return b.decision.localeCompare(a.decision);
    return (b.avg_net_real - a.avg_net_real);
  });

  const summary = {
    runDir,
    generatedAt: new Date().toISOString(),
    thresholds: {
      minCount: toNum(argv['min-count'], 300),
      minCountFinal: toNum(argv['min-count-final'], 1000),
      minPPos: 0.55,
      maxTailLossRatio: 3.5,
      maxConsLoss: 12,
      maxDDRatio: 5.0
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
    'avg_net_real', 'avg_net_placebo',
    'p_pos_real', 'p_pos_placebo',
    'mean_win_real', 'p95_loss_real',
    'max_dd_real', 'max_cons_loss_real', 'pf_real'
  ];

  const csvLines = [candHeaders.join(',')];
  for (const c of candidates) {
    csvLines.push(candHeaders.map((h) => String(c[h] ?? '')).join(','));
  }

  const summaryTxt = [
    'HLB2 Validation Judgement (Pessimistic)',
    `generatedAt: ${summary.generatedAt}`,
    `runDir: ${runDir}`,
    '',
    `[totals] real=${summary.totals.realRows} placebo=${summary.totals.placeboRows} groups=${summary.totals.groupsEvaluated}`,
    `[decision] adopt=${summary.totals.adoptCandidates} watchlist=${summary.totals.watchlist} reject=${summary.totals.rejected} hold_sample=${summary.totals.holdSample}`,
    '',
    '[top candidates]'
  ];

  for (const c of candidates.slice(0, 10)) {
    summaryTxt.push(`${c.type}/${c.side} decision=${c.decision} stage=${c.stage} count=${c.count} avgNet=${c.avg_net_real.toFixed(4)} pPos=${(c.p_pos_real * 100).toFixed(1)}% p95Loss=${c.p95_loss_real.toFixed(4)} maxDD=${c.max_dd_real.toFixed(4)} maxConsLoss=${c.max_cons_loss_real} PF=${c.pf_real.toFixed(2)}`);
  }

  fs.writeFileSync(path.join(runDir, 'validation_judgement.json'), JSON.stringify({ summary, candidates }, null, 2));
  fs.writeFileSync(path.join(runDir, 'validation_candidates.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(runDir, 'validation_summary.txt'), `${summaryTxt.join('\n')}\n`);

  console.log(JSON.stringify(summary, null, 2));
}

main();
