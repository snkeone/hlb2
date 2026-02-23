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
    out: 'logs/ops/shadow_model_compare_latest.json'
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
      if (!side) continue;
      if (!isEntryAllowed(decision)) continue;

      const context = payload?.context ?? {};
      const bResult = context?.bResult ?? {};
      const mid = toNum(bResult?.midPrice, toNum(context?.mid, NaN));
      if (!Number.isFinite(mid) || mid <= 0) continue;

      const ts = toNum(row?.ts, NaN);
      if (!Number.isFinite(ts)) continue;

      const marketMicro = context?.marketMicro ?? payload?.marketMicro ?? {};
      const expectedUsd = toNum(bResult?.expectedUsd, NaN);
      const structuralDistanceUsd = Math.abs(toNum(bResult?.structuralDistanceUsd, NaN));
      const mapStrength = toNum(bResult?.mapStrength, NaN);
      const spreadBps = toNum(marketMicro?.spreadBps, toNum(bResult?.entryProfile?.spreadBps, NaN));

      candidates.push({
        ts,
        side,
        mid,
        expectedUsd,
        structuralDistanceUsd,
        mapStrength,
        spreadBps,
      });
      continue;
    }

    if (String(row?.channel ?? '') === 'trades') {
      const extracted = extractTradesFromRawEvent(row);
      for (const t of extracted) trades.push(t);
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
    const targetTs = c.ts + horizonMs;
    const idx = lowerBoundByTs(trades, targetTs);
    if (idx >= trades.length) continue;
    const futurePx = toNum(trades[idx]?.px, NaN);
    if (!Number.isFinite(futurePx) || futurePx <= 0) continue;
    const rawBps = ((futurePx - c.mid) / c.mid) * 10000;
    const sideAlignedBps = c.side === 'buy' ? rawBps : -rawBps;
    out.push({ ...c, futurePx, retBps: sideAlignedBps });
  }
  return out;
}

function binByQuantiles(value, q1, q2) {
  if (!Number.isFinite(value)) return 'na';
  if (value <= q1) return 'lo';
  if (value <= q2) return 'mid';
  return 'hi';
}

function buildBuckets(trainRows) {
  const expVals = trainRows.map((r) => r.expectedUsd).filter(Number.isFinite);
  const distVals = trainRows.map((r) => r.structuralDistanceUsd).filter(Number.isFinite);
  const mapVals = trainRows.map((r) => r.mapStrength).filter(Number.isFinite);

  const expQ1 = quantile(expVals, 1 / 3) ?? 0;
  const expQ2 = quantile(expVals, 2 / 3) ?? 0;
  const distQ1 = quantile(distVals, 1 / 3) ?? 0;
  const distQ2 = quantile(distVals, 2 / 3) ?? 0;
  const mapQ1 = quantile(mapVals, 1 / 3) ?? 0;
  const mapQ2 = quantile(mapVals, 2 / 3) ?? 0;

  const bins = new Map();
  for (const row of trainRows) {
    const expBin = binByQuantiles(row.expectedUsd, expQ1, expQ2);
    const distBin = binByQuantiles(row.structuralDistanceUsd, distQ1, distQ2);
    const mapBin = binByQuantiles(row.mapStrength, mapQ1, mapQ2);
    const key = `${expBin}|${distBin}|${mapBin}|${row.side}`;
    const cur = bins.get(key) ?? { n: 0, sum: 0, win: 0 };
    cur.n += 1;
    cur.sum += row.retBps;
    if (row.retBps > 0) cur.win += 1;
    bins.set(key, cur);
  }

  return {
    thresholds: { expQ1, expQ2, distQ1, distQ2, mapQ1, mapQ2 },
    bins,
  };
}

function scoreRow(row, model, minBucket) {
  const t = model.thresholds;
  const expBin = binByQuantiles(row.expectedUsd, t.expQ1, t.expQ2);
  const distBin = binByQuantiles(row.structuralDistanceUsd, t.distQ1, t.distQ2);
  const mapBin = binByQuantiles(row.mapStrength, t.mapQ1, t.mapQ2);
  const key = `${expBin}|${distBin}|${mapBin}|${row.side}`;
  const bucket = model.bins.get(key);
  if (!bucket || bucket.n < minBucket) return { score: 0, key, bucketN: bucket?.n ?? 0 };
  return { score: bucket.sum / bucket.n, key, bucketN: bucket.n };
}

function summarize(rows) {
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      winRate: 0,
      avgRetBps: null,
      medRetBps: null,
      sumRetBps: null,
    };
  }
  const rets = rows.map((r) => r.retBps).filter(Number.isFinite);
  const win = rets.filter((v) => v > 0).length;
  const sum = rets.reduce((a, b) => a + b, 0);
  const avg = sum / Math.max(1, rets.length);
  return {
    n,
    winRate: round(pct(win, Math.max(1, rets.length)), 2),
    avgRetBps: round(avg, 4),
    medRetBps: round(median(rets) ?? NaN, 4),
    sumRetBps: round(sum, 4),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const rawPath = args.raw
    ? path.resolve(process.cwd(), args.raw)
    : resolveLatestRawFile('logs');
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.error('[shadow_model_compare] raw file not found');
    process.exit(1);
  }

  const { candidates, trades } = await loadDataset(rawPath);
  const rows = attachForwardReturn(candidates, trades, args.horizonSec);
  if (rows.length < 50) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'insufficient_rows',
      rawPath,
      candidates: candidates.length,
      trades: trades.length,
      labeledRows: rows.length,
    }, null, 2));
    return;
  }

  const splitIdx = Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length * args.trainRatio)));
  const trainRows = rows.slice(0, splitIdx);
  const testRows = rows.slice(splitIdx);

  const model = buildBuckets(trainRows);
  const baselineTest = [...testRows];
  const altTest = testRows
    .map((r) => ({ ...r, model: scoreRow(r, model, args.minBucket) }))
    .filter((r) => r.model.score > 0);

  const baseline = summarize(baselineTest);
  const alternative = summarize(altTest);

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
      trainRows: trainRows.length,
      testRows: testRows.length,
    },
    baselineV2: baseline,
    alternativeShadow: alternative,
    liftVsBaseline: {
      avgRetBpsDiff: (baseline.avgRetBps != null && alternative.avgRetBps != null)
        ? round(alternative.avgRetBps - baseline.avgRetBps, 4)
        : null,
      winRateDiff: round((alternative.winRate ?? 0) - (baseline.winRate ?? 0), 2),
      sampleReductionRate: round(
        pct(Math.max(0, (baseline.n ?? 0) - (alternative.n ?? 0)), Math.max(1, baseline.n ?? 0)),
        2
      ),
    },
    notes: [
      'baselineV2 = ENTRY_ALLOWED candidates (test split).',
      'alternativeShadow = train buckets with positive expected return only.',
      'This is offline validation logic; no trading behavior/config is changed.'
    ],
  };

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[shadow_model_compare] failed', err?.stack || err?.message || String(err));
  process.exit(1);
});
