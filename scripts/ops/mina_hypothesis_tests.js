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

function variance(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / arr.length;
}

function parseArgs(argv) {
  const out = {
    raw: null,
    horizonSec: 30,
    wallPercentile: 0.9,
    wallGapMs: 1500,
    breakBps: 1.5,
    breakLookaheadSec: 20,
    extWindowSec: 30,
    out: 'logs/ops/mina_hypothesis_tests_latest.json',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? '');
    else if (a === '--horizon-sec') out.horizonSec = Math.max(5, Math.floor(toNum(argv[++i], out.horizonSec)));
    else if (a === '--wall-percentile') out.wallPercentile = Math.max(0.5, Math.min(0.99, toNum(argv[++i], out.wallPercentile)));
    else if (a === '--wall-gap-ms') out.wallGapMs = Math.max(200, Math.floor(toNum(argv[++i], out.wallGapMs)));
    else if (a === '--break-bps') out.breakBps = Math.max(0.2, toNum(argv[++i], out.breakBps));
    else if (a === '--break-lookahead-sec') out.breakLookaheadSec = Math.max(5, Math.floor(toNum(argv[++i], out.breakLookaheadSec)));
    else if (a === '--ext-window-sec') out.extWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.extWindowSec)));
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
  }
  return out;
}

function resolveLatestRawFile(logsDir = 'logs') {
  try {
    const abs = path.resolve(process.cwd(), logsDir);
    const names = fs.readdirSync(abs).filter((n) => /^raw-\d{8}\.jsonl$/.test(n)).sort();
    if (names.length === 0) return null;
    return path.join(abs, names[names.length - 1]);
  } catch {
    return null;
  }
}

function lowerBoundByTs(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function summarizeSeries(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  if (vals.length === 0) return { n: 0, mean: null, median: null, p75: null, p90: null, variance: null };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    n: vals.length,
    mean: round(mean, 4),
    median: round(median(vals) ?? NaN, 4),
    p75: round(quantile(vals, 0.75) ?? NaN, 4),
    p90: round(quantile(vals, 0.9) ?? NaN, 4),
    variance: round(variance(vals) ?? NaN, 6),
  };
}

function extractTradesFromEvent(row) {
  const out = [];
  const d = row?.data;
  const inner = d && typeof d === 'object' ? d.data : null;
  if (!Array.isArray(inner)) return out;
  for (const t of inner) {
    const px = toNum(t?.px, NaN);
    const sz = toNum(t?.sz, NaN);
    const ts = toNum(t?.time, toNum(row?.ts, NaN));
    const sideRaw = String(t?.side ?? '').toUpperCase();
    const sign = sideRaw === 'B' ? 1 : sideRaw === 'A' ? -1 : 0;
    if (!Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(ts) || sign === 0) continue;
    out.push({ ts, px, sz, sign, notional: px * sz });
  }
  return out;
}

function extractOrderbookFromEvent(row) {
  const d = row?.data;
  const inner = d && typeof d === 'object' ? d.data : null;
  const levels = inner && typeof inner === 'object' ? inner.levels : null;
  const ts = toNum(inner?.time, toNum(row?.ts, NaN));
  if (!Number.isFinite(ts) || !Array.isArray(levels) || levels.length < 2) return null;
  const bidsRaw = Array.isArray(levels[0]) ? levels[0] : [];
  const asksRaw = Array.isArray(levels[1]) ? levels[1] : [];

  const toLvl = (x) => {
    const px = toNum(x?.px, NaN);
    const sz = toNum(x?.sz, NaN);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || sz <= 0) return null;
    return { px, sz, usd: px * sz };
  };
  const bids = bidsRaw.map(toLvl).filter(Boolean);
  const asks = asksRaw.map(toLvl).filter(Boolean);
  if (bids.length === 0 || asks.length === 0) return null;
  const mid = (bids[0].px + asks[0].px) / 2;
  return { ts, mid, bids, asks };
}

async function loadRaw(rawPath) {
  const trades = [];
  const books = [];
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
    const ch = String(row?.channel ?? '');
    if (ch === 'trades') {
      const ex = extractTradesFromEvent(row);
      for (const t of ex) trades.push(t);
    } else if (ch === 'orderbook') {
      const b = extractOrderbookFromEvent(row);
      if (b) books.push(b);
    }
  }
  trades.sort((a, b) => a.ts - b.ts);
  books.sort((a, b) => a.ts - b.ts);
  return { trades, books };
}

function runMinaIdea1(trades, horizonSec = 30) {
  if (trades.length < 200) {
    return { ok: false, reason: 'insufficient_trades', nTrades: trades.length };
  }

  const secMap = new Map();
  for (const t of trades) {
    const sec = Math.floor(t.ts / 1000);
    const cur = secMap.get(sec) ?? { sec, signedNotional: 0, absNotional: 0, lastPx: null };
    cur.signedNotional += t.sign * t.notional;
    cur.absNotional += Math.abs(t.notional);
    cur.lastPx = t.px;
    secMap.set(sec, cur);
  }

  const secs = [...secMap.values()].sort((a, b) => a.sec - b.sec);
  const secIndex = new Map(secs.map((x, i) => [x.sec, i]));

  const signSeries = [];
  let prevSign = 0;
  let runLen = 0;
  for (const row of secs) {
    const sign = row.signedNotional > 0 ? 1 : row.signedNotional < 0 ? -1 : 0;
    if (sign !== 0 && sign === prevSign) runLen += 1;
    else if (sign !== 0) runLen = 1;
    else runLen = 0;
    prevSign = sign === 0 ? prevSign : sign;
    signSeries.push({ ...row, sign, persistenceSec: runLen });
  }

  const rows = [];
  for (let i = 0; i < signSeries.length; i += 1) {
    const r = signSeries[i];
    if (!Number.isFinite(r.lastPx) || r.lastPx <= 0) continue;
    const targetSec = r.sec + horizonSec;
    const j = secIndex.get(targetSec);
    if (j == null) continue;
    const future = signSeries[j];
    if (!Number.isFinite(future.lastPx) || future.lastPx <= 0) continue;
    const absRetBps = Math.abs(((future.lastPx - r.lastPx) / r.lastPx) * 10000);

    const from = Math.max(0, i - 29);
    let flips = 0;
    let prev = 0;
    for (let k = from; k <= i; k += 1) {
      const s = signSeries[k].sign;
      if (s === 0) continue;
      if (prev !== 0 && s !== prev) flips += 1;
      prev = s;
    }
    const reversalFreq = flips / 30;
    rows.push({ persistenceSec: r.persistenceSec, reversalFreq, absRetBps });
  }

  const pBins = {
    'p_1_2': rows.filter((r) => r.persistenceSec >= 1 && r.persistenceSec <= 2),
    'p_3_5': rows.filter((r) => r.persistenceSec >= 3 && r.persistenceSec <= 5),
    'p_6_10': rows.filter((r) => r.persistenceSec >= 6 && r.persistenceSec <= 10),
    'p_11_plus': rows.filter((r) => r.persistenceSec >= 11),
  };
  const revBins = {
    'rev_low': rows.filter((r) => r.reversalFreq <= 0.05),
    'rev_mid': rows.filter((r) => r.reversalFreq > 0.05 && r.reversalFreq <= 0.2),
    'rev_high': rows.filter((r) => r.reversalFreq > 0.2),
  };

  const persistenceResult = Object.fromEntries(
    Object.entries(pBins).map(([k, arr]) => [k, summarizeSeries(arr.map((x) => x.absRetBps))])
  );
  const reversalResult = Object.fromEntries(
    Object.entries(revBins).map(([k, arr]) => [k, summarizeSeries(arr.map((x) => x.absRetBps))])
  );

  return {
    ok: true,
    nRows: rows.length,
    hypothesis: {
      persistence_longer_has_fatter_tail: true,
      high_reversal_has_lower_variance: true,
    },
    persistenceXAbsReturn30s: persistenceResult,
    reversalFreqXAbsReturn30s: reversalResult,
  };
}

function percentile(arr, p) {
  return quantile(arr, p);
}

function wallLifetimeBin(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'unknown';
  if (sec <= 3) return 'short_0_3s';
  if (sec <= 10) return 'mid_3_10s';
  return 'long_10s_plus';
}

function runMinaIdea2(books, cfg) {
  if (books.length < 500) {
    return { ok: false, reason: 'insufficient_orderbook', nBooks: books.length };
  }

  const allUsd = [];
  for (const b of books) {
    for (const lv of b.bids) allUsd.push(lv.usd);
    for (const lv of b.asks) allUsd.push(lv.usd);
  }
  const wallUsdTh = percentile(allUsd, cfg.wallPercentile) ?? Infinity;

  const active = new Map();
  const walls = [];

  function makeKey(side, px) {
    const rounded = Math.round(px * 2) / 2;
    return `${side}|${rounded.toFixed(1)}`;
  }

  function closeWall(w, closeTs) {
    const lifeSec = Math.max(0, (closeTs - w.firstTs) / 1000);
    walls.push({
      side: w.side,
      px: w.px,
      firstTs: w.firstTs,
      lastTs: closeTs,
      lifeSec,
      maxUsd: w.maxUsd,
    });
  }

  for (const ob of books) {
    const ts = ob.ts;
    const currentKeys = new Set();

    for (const lv of ob.bids) {
      if (lv.usd < wallUsdTh) continue;
      const key = makeKey('bid', lv.px);
      currentKeys.add(key);
      const cur = active.get(key);
      if (!cur) {
        active.set(key, { side: 'bid', px: lv.px, firstTs: ts, lastSeenTs: ts, maxUsd: lv.usd });
      } else {
        cur.lastSeenTs = ts;
        if (lv.usd > cur.maxUsd) cur.maxUsd = lv.usd;
      }
    }

    for (const lv of ob.asks) {
      if (lv.usd < wallUsdTh) continue;
      const key = makeKey('ask', lv.px);
      currentKeys.add(key);
      const cur = active.get(key);
      if (!cur) {
        active.set(key, { side: 'ask', px: lv.px, firstTs: ts, lastSeenTs: ts, maxUsd: lv.usd });
      } else {
        cur.lastSeenTs = ts;
        if (lv.usd > cur.maxUsd) cur.maxUsd = lv.usd;
      }
    }

    for (const [key, w] of active.entries()) {
      if (currentKeys.has(key)) continue;
      if ((ts - w.lastSeenTs) >= cfg.wallGapMs) {
        closeWall(w, w.lastSeenTs);
        active.delete(key);
      }
    }
  }

  const lastTs = books[books.length - 1].ts;
  for (const [, w] of active.entries()) {
    closeWall(w, w.lastSeenTs ?? lastTs);
  }

  const midSeries = books.map((b) => ({ ts: b.ts, mid: b.mid }));
  const breakLookaheadMs = cfg.breakLookaheadSec * 1000;
  const extWindowMs = cfg.extWindowSec * 1000;

  const analyzed = [];
  for (const w of walls) {
    const startIdx = lowerBoundByTs(midSeries, w.lastTs);
    const endBreakIdx = lowerBoundByTs(midSeries, w.lastTs + breakLookaheadMs);
    if (startIdx >= midSeries.length) continue;
    let breakTs = null;

    const upBreak = (m) => ((m - w.px) / w.px) * 10000 >= cfg.breakBps;
    const downBreak = (m) => ((w.px - m) / w.px) * 10000 >= cfg.breakBps;

    for (let i = startIdx; i < endBreakIdx && i < midSeries.length; i += 1) {
      const m = midSeries[i].mid;
      if (!Number.isFinite(m) || m <= 0) continue;
      if (w.side === 'ask' && upBreak(m)) {
        breakTs = midSeries[i].ts;
        break;
      }
      if (w.side === 'bid' && downBreak(m)) {
        breakTs = midSeries[i].ts;
        break;
      }
    }
    if (!Number.isFinite(breakTs)) continue;

    const extStart = lowerBoundByTs(midSeries, breakTs);
    const extEnd = lowerBoundByTs(midSeries, breakTs + extWindowMs);
    let maxExtBps = 0;
    for (let i = extStart; i < extEnd && i < midSeries.length; i += 1) {
      const m = midSeries[i].mid;
      if (!Number.isFinite(m) || m <= 0) continue;
      const ext = w.side === 'ask'
        ? ((m - w.px) / w.px) * 10000
        : ((w.px - m) / w.px) * 10000;
      if (ext > maxExtBps) maxExtBps = ext;
    }

    analyzed.push({
      lifeSec: w.lifeSec,
      lifeBin: wallLifetimeBin(w.lifeSec),
      maxExtBps,
    });
  }

  const byBin = {};
  for (const row of analyzed) {
    if (!byBin[row.lifeBin]) byBin[row.lifeBin] = [];
    byBin[row.lifeBin].push(row.maxExtBps);
  }
  const resultByBin = Object.fromEntries(
    Object.entries(byBin).map(([k, vals]) => [k, summarizeSeries(vals)])
  );

  return {
    ok: true,
    nOrderbook: books.length,
    wallUsdThreshold: round(wallUsdTh, 2),
    wallsDetected: walls.length,
    wallsWithBreak: analyzed.length,
    wallLifetimeXPostBreakExtension: resultByBin,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const rawPath = args.raw ? path.resolve(process.cwd(), args.raw) : resolveLatestRawFile('logs');
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.error('[mina_hypothesis_tests] raw file not found');
    process.exit(1);
  }

  const { trades, books } = await loadRaw(rawPath);
  const idea1 = runMinaIdea1(trades, args.horizonSec);
  const idea2 = runMinaIdea2(books, {
    wallPercentile: args.wallPercentile,
    wallGapMs: args.wallGapMs,
    breakBps: args.breakBps,
    breakLookaheadSec: args.breakLookaheadSec,
    extWindowSec: args.extWindowSec,
  });

  const report = {
    ok: true,
    rawPath,
    config: {
      horizonSec: args.horizonSec,
      wallPercentile: args.wallPercentile,
      wallGapMs: args.wallGapMs,
      breakBps: args.breakBps,
      breakLookaheadSec: args.breakLookaheadSec,
      extWindowSec: args.extWindowSec,
    },
    sample: {
      tradesTicks: trades.length,
      orderbookTicks: books.length,
    },
    minaIdea1: idea1,
    minaIdea2: idea2,
    notes: [
      'Idea1 evaluates absolute 30s return distribution by flow persistence and reversal frequency.',
      'Idea2 evaluates post-break extension by wall lifetime bins.',
      'Direction forecasting is intentionally not used.'
    ],
  };

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[mina_hypothesis_tests] failed', err?.stack || err?.message || String(err));
  process.exit(1);
});
