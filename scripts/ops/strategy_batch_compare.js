#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return 0;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0;
  return (a / b) * 100;
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function quantile(arr, q) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function parseArgs(argv) {
  const out = {
    raw: null,
    horizonSec: 60,
    trainRatio: 0.6,
    minBucket: 20,
    out: 'logs/ops/strategy_batch_compare_latest.json',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? '');
    else if (a === '--horizon-sec') out.horizonSec = Math.max(5, Math.floor(toNum(argv[++i], out.horizonSec)));
    else if (a === '--train-ratio') out.trainRatio = Math.max(0.4, Math.min(0.9, toNum(argv[++i], out.trainRatio)));
    else if (a === '--min-bucket') out.minBucket = Math.max(5, Math.floor(toNum(argv[++i], out.minBucket)));
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
  }
  return out;
}

function resolveLatestRawFile(logsDir = 'logs') {
  try {
    const abs = path.resolve(process.cwd(), logsDir);
    const names = fs.readdirSync(abs)
      .filter((n) => /^raw-\d{8}\.jsonl$/.test(n))
      .sort();
    if (names.length === 0) return null;
    return path.join(abs, names[names.length - 1]);
  } catch {
    return null;
  }
}

function isEntryAllowed(decision = {}) {
  const reasonCode = String(decision?.reasonCode ?? '').toUpperCase();
  const reason = String(decision?.reason ?? '').toLowerCase();
  return reasonCode.includes('ENTRY_ALLOWED') || reason.includes('entry allowed');
}

function normalizeSide(side) {
  const s = String(side ?? '').toLowerCase();
  if (s === 'buy' || s === 'b') return 'buy';
  if (s === 'sell' || s === 's' || s === 'a') return 'sell';
  return null;
}

function extractTradesFromRawEvent(row) {
  const out = [];
  const tsOuter = toNum(row?.ts, NaN);
  const data = row?.data;
  if (!data || typeof data !== 'object') return out;
  const payload = Array.isArray(data?.data) ? data.data : [];
  for (const t of payload) {
    const px = toNum(t?.px, NaN);
    const ts = toNum(t?.time, tsOuter);
    if (!Number.isFinite(px) || !Number.isFinite(ts)) continue;
    out.push({ ts, px });
  }
  return out;
}

async function loadDataset(rawPath) {
  const candidates = [];
  const trades = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(rawPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = String(line || '').trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue;
    }

    if (row?.type === 'decision_trace') {
      const payload = row?.payload ?? {};
      const decision = payload?.decision ?? {};
      const side = normalizeSide(decision?.side);
      if (!side || !isEntryAllowed(decision)) continue;

      const context = payload?.context ?? {};
      const bResult = context?.bResult ?? {};
      const mid = toNum(bResult?.midPrice, toNum(context?.mid, NaN));
      if (!Number.isFinite(mid) || mid <= 0) continue;

      const ts = toNum(row?.ts, NaN);
      if (!Number.isFinite(ts)) continue;

      const marketMicro = context?.marketMicro ?? payload?.marketMicro ?? {};
      candidates.push({
        ts,
        side,
        mid,
        expectedUsd: toNum(bResult?.expectedUsd, NaN),
        structuralDistanceUsd: Math.abs(toNum(bResult?.structuralDistanceUsd, NaN)),
        mapStrength: toNum(bResult?.mapStrength, NaN),
        spreadBps: toNum(marketMicro?.spreadBps, toNum(bResult?.entryProfile?.spreadBps, NaN)),
      });
      continue;
    }

    if (String(row?.channel ?? '') === 'trades') {
      const ex = extractTradesFromRawEvent(row);
      for (const t of ex) trades.push(t);
    }
  }

  candidates.sort((a, b) => a.ts - b.ts);
  trades.sort((a, b) => a.ts - b.ts);
  return { candidates, trades };
}

function lowerBoundByTs(items, ts) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function attachForwardReturn(candidates, trades, horizonSec) {
  const out = [];
  const horizonMs = horizonSec * 1000;
  for (const c of candidates) {
    const idx = lowerBoundByTs(trades, c.ts + horizonMs);
    if (idx >= trades.length) continue;
    const futurePx = toNum(trades[idx]?.px, NaN);
    if (!Number.isFinite(futurePx) || futurePx <= 0) continue;
    const rawBps = ((futurePx - c.mid) / c.mid) * 10000;
    const retBps = c.side === 'buy' ? rawBps : -rawBps;
    out.push({ ...c, futurePx, retBps });
  }
  return out;
}

function bin3(v, q1, q2) {
  if (!Number.isFinite(v)) return 'na';
  if (v <= q1) return 'lo';
  if (v <= q2) return 'mid';
  return 'hi';
}

function buildBucketModel(trainRows) {
  const expected = trainRows.map((r) => r.expectedUsd).filter(Number.isFinite);
  const dist = trainRows.map((r) => r.structuralDistanceUsd).filter(Number.isFinite);
  const map = trainRows.map((r) => r.mapStrength).filter(Number.isFinite);

  const t = {
    expQ1: quantile(expected, 1 / 3) ?? 0,
    expQ2: quantile(expected, 2 / 3) ?? 0,
    distQ1: quantile(dist, 1 / 3) ?? 0,
    distQ2: quantile(dist, 2 / 3) ?? 0,
    mapQ1: quantile(map, 1 / 3) ?? 0,
    mapQ2: quantile(map, 2 / 3) ?? 0,
  };

  const buckets = new Map();
  for (const r of trainRows) {
    const key = `${bin3(r.expectedUsd, t.expQ1, t.expQ2)}|${bin3(r.structuralDistanceUsd, t.distQ1, t.distQ2)}|${bin3(r.mapStrength, t.mapQ1, t.mapQ2)}|${r.side}`;
    const cur = buckets.get(key) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += r.retBps;
    buckets.set(key, cur);
  }

  const score = (row, minBucket) => {
    const key = `${bin3(row.expectedUsd, t.expQ1, t.expQ2)}|${bin3(row.structuralDistanceUsd, t.distQ1, t.distQ2)}|${bin3(row.mapStrength, t.mapQ1, t.mapQ2)}|${row.side}`;
    const b = buckets.get(key);
    if (!b || b.n < minBucket) return 0;
    return b.sum / b.n;
  };

  return { t, score };
}

function summarize(name, selectedRows, totalRows) {
  const n = selectedRows.length;
  if (n === 0) {
    return {
      name,
      n: 0,
      selectionRate: 0,
      winRate: 0,
      avgRetBps: null,
      medRetBps: null,
      sumRetBps: null,
    };
  }
  const rets = selectedRows.map((r) => r.retBps).filter(Number.isFinite);
  const win = rets.filter((v) => v > 0).length;
  const sum = rets.reduce((a, b) => a + b, 0);
  return {
    name,
    n,
    selectionRate: round(pct(n, Math.max(1, totalRows)), 2),
    winRate: round(pct(win, Math.max(1, rets.length)), 2),
    avgRetBps: round(sum / Math.max(1, rets.length), 4),
    medRetBps: round(median(rets) ?? NaN, 4),
    sumRetBps: round(sum, 4),
  };
}

function compareWithBaseline(metrics, baseline) {
  return metrics.map((m) => ({
    ...m,
    deltaWinRate: round((m.winRate ?? 0) - (baseline.winRate ?? 0), 2),
    deltaAvgRetBps: (m.avgRetBps != null && baseline.avgRetBps != null)
      ? round(m.avgRetBps - baseline.avgRetBps, 4)
      : null,
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  const rawPath = args.raw
    ? path.resolve(process.cwd(), args.raw)
    : resolveLatestRawFile('logs');
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.error('[strategy_batch_compare] raw file not found');
    process.exit(1);
  }

  const { candidates, trades } = await loadDataset(rawPath);
  const rows = attachForwardReturn(candidates, trades, args.horizonSec);
  if (rows.length < 80) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'insufficient_rows',
      rawPath,
      candidates: candidates.length,
      labeledRows: rows.length,
    }, null, 2));
    return;
  }

  const split = Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length * args.trainRatio)));
  const train = rows.slice(0, split);
  const test = rows.slice(split);

  const expVals = train.map((r) => r.expectedUsd).filter(Number.isFinite);
  const mapVals = train.map((r) => r.mapStrength).filter(Number.isFinite);
  const distVals = train.map((r) => r.structuralDistanceUsd).filter(Number.isFinite);
  const spreadVals = train.map((r) => r.spreadBps).filter(Number.isFinite);
  const expP60 = quantile(expVals, 0.6) ?? 0;
  const mapP60 = quantile(mapVals, 0.6) ?? 0;
  const distP40 = quantile(distVals, 0.4) ?? 0;
  const spreadP50 = quantile(spreadVals, 0.5) ?? 0;

  const model = buildBucketModel(train);
  const modelScores = test.map((r) => model.score(r, args.minBucket));
  const scorePos = modelScores.filter((v) => v > 0);
  const scoreQ75 = quantile(scorePos, 0.75) ?? 0;

  const strategies = [
    { name: 'v2_all', pick: () => true },
    { name: 'exp_usd_gt0', pick: (r) => Number.isFinite(r.expectedUsd) && r.expectedUsd > 0 },
    { name: 'exp_usd_p60', pick: (r) => Number.isFinite(r.expectedUsd) && r.expectedUsd >= expP60 },
    { name: 'map_p60', pick: (r) => Number.isFinite(r.mapStrength) && r.mapStrength >= mapP60 },
    { name: 'dist_p40_near', pick: (r) => Number.isFinite(r.structuralDistanceUsd) && r.structuralDistanceUsd <= distP40 },
    {
      name: 'combo_quality',
      pick: (r) => Number.isFinite(r.expectedUsd) && r.expectedUsd >= expP60
        && Number.isFinite(r.mapStrength) && r.mapStrength >= mapP60
        && Number.isFinite(r.structuralDistanceUsd) && r.structuralDistanceUsd <= distP40
    },
    {
      name: 'combo_quality_tightspread',
      pick: (r) => Number.isFinite(r.expectedUsd) && r.expectedUsd >= expP60
        && Number.isFinite(r.mapStrength) && r.mapStrength >= mapP60
        && Number.isFinite(r.structuralDistanceUsd) && r.structuralDistanceUsd <= distP40
        && Number.isFinite(r.spreadBps) && r.spreadBps <= spreadP50
    },
    { name: 'bucket_ev_pos', pick: (r) => model.score(r, args.minBucket) > 0 },
    { name: 'bucket_ev_topq', pick: (r) => model.score(r, args.minBucket) >= scoreQ75 && model.score(r, args.minBucket) > 0 },
  ];

  const metricsRaw = strategies.map((s) => {
    const selected = test.filter((r) => s.pick(r));
    return summarize(s.name, selected, test.length);
  });

  const baseline = metricsRaw.find((m) => m.name === 'v2_all') ?? metricsRaw[0];
  const metrics = compareWithBaseline(metricsRaw, baseline)
    .sort((a, b) => {
      const av = Number.isFinite(a.avgRetBps) ? a.avgRetBps : -Infinity;
      const bv = Number.isFinite(b.avgRetBps) ? b.avgRetBps : -Infinity;
      if (bv !== av) return bv - av;
      return (b.winRate ?? 0) - (a.winRate ?? 0);
    });

  const report = {
    ok: true,
    rawPath,
    config: {
      horizonSec: args.horizonSec,
      trainRatio: args.trainRatio,
      minBucket: args.minBucket,
    },
    sample: {
      decisionEntryAllowed: candidates.length,
      tradesTicks: trades.length,
      labeledRows: rows.length,
      trainRows: train.length,
      testRows: test.length,
    },
    thresholds: {
      expP60: round(expP60, 6),
      mapP60: round(mapP60, 6),
      distP40: round(distP40, 6),
      spreadP50: round(spreadP50, 6),
      bucketScoreQ75: round(scoreQ75, 6),
    },
    baseline: baseline.name,
    strategies: metrics,
    notes: [
      'All strategies are evaluated on the same test split.',
      'No runtime config or execution logic is changed by this script.',
      'Use multi-day repetition before any production decision.'
    ],
  };

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[strategy_batch_compare] failed', err?.stack || err?.message || String(err));
  process.exit(1);
});
