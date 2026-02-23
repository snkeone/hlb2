#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
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

function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function parseArgs(argv) {
  const out = {
    raw: null,
    moveWindowSec: 30,
    leadWindowSec: 20,
    moveBps: null,
    eventQuantile: 0.9,
    minGapSec: 30,
    out: 'logs/ops/ws_lead_indicator_scan_latest.json',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? '');
    else if (a === '--move-window-sec') out.moveWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.moveWindowSec)));
    else if (a === '--lead-window-sec') out.leadWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.leadWindowSec)));
    else if (a === '--move-bps') out.moveBps = Math.max(0.2, toNum(argv[++i], 0.2));
    else if (a === '--event-quantile') out.eventQuantile = Math.max(0.7, Math.min(0.99, toNum(argv[++i], out.eventQuantile)));
    else if (a === '--min-gap-sec') out.minGapSec = Math.max(5, Math.floor(toNum(argv[++i], out.minGapSec)));
    else if (a === '--out') out.out = String(argv[++i] ?? out.out);
  }
  return out;
}

function resolveLatestRawFile(logsDir = 'logs') {
  try {
    const abs = path.resolve(process.cwd(), logsDir);
    const files = fs.readdirSync(abs).filter((n) => /^raw-\d{8}\.jsonl$/.test(n)).sort();
    if (files.length === 0) return null;
    return path.join(abs, files[files.length - 1]);
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

function extractTrades(row) {
  const out = [];
  const d = row?.data;
  const inner = d && typeof d === 'object' ? d.data : null;
  if (!Array.isArray(inner)) return out;
  for (const t of inner) {
    const ts = toNum(t?.time, toNum(row?.ts, NaN));
    const px = toNum(t?.px, NaN);
    const sz = toNum(t?.sz, NaN);
    const sideRaw = String(t?.side ?? '').toUpperCase();
    const side = sideRaw === 'B' ? 'buy' : sideRaw === 'A' ? 'sell' : null;
    if (!Number.isFinite(ts) || !Number.isFinite(px) || !Number.isFinite(sz) || !side) continue;
    out.push({ ts, px, sz, side, notional: px * sz });
  }
  return out;
}

function extractOrderbook(row) {
  const d = row?.data;
  const inner = d && typeof d === 'object' ? d.data : null;
  const ts = toNum(inner?.time, toNum(row?.ts, NaN));
  const levels = inner?.levels;
  if (!Number.isFinite(ts) || !Array.isArray(levels) || levels.length < 2) return null;

  const mapLv = (lv) => {
    const px = toNum(lv?.px, NaN);
    const sz = toNum(lv?.sz, NaN);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || sz <= 0) return null;
    return { px, sz, usd: px * sz };
  };
  const bids = (Array.isArray(levels[0]) ? levels[0] : []).map(mapLv).filter(Boolean);
  const asks = (Array.isArray(levels[1]) ? levels[1] : []).map(mapLv).filter(Boolean);
  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = bids[0].px;
  const bestAsk = asks[0].px;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : null;
  const bidUsdTop5 = bids.slice(0, 5).reduce((s, x) => s + x.usd, 0);
  const askUsdTop5 = asks.slice(0, 5).reduce((s, x) => s + x.usd, 0);
  const depthImbalance = (bidUsdTop5 + askUsdTop5) > 0
    ? ((bidUsdTop5 - askUsdTop5) / (bidUsdTop5 + askUsdTop5))
    : 0;
  const wallUsdMax = Math.max(
    bids.length > 0 ? Math.max(...bids.slice(0, 10).map((x) => x.usd)) : 0,
    asks.length > 0 ? Math.max(...asks.slice(0, 10).map((x) => x.usd)) : 0,
  );

  return {
    ts,
    mid,
    spreadBps,
    depthImbalance,
    bestBid,
    bestAsk,
    wallUsdMax,
  };
}

function extractCtx(row) {
  const d = row?.data;
  const inner = d && typeof d === 'object' ? d.data : null;
  const ctx = inner?.ctx;
  if (!ctx || typeof ctx !== 'object') return null;
  const ts = toNum(inner?.time, toNum(row?.ts, NaN));
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    oi: toNum(ctx?.openInterest, NaN),
    funding: toNum(ctx?.funding, NaN),
    premium: toNum(ctx?.premium, NaN),
    markPx: toNum(ctx?.markPx, NaN),
    oraclePx: toNum(ctx?.oraclePx, NaN),
  };
}

async function loadRaw(rawPath) {
  const trades = [];
  const books = [];
  const ctxs = [];
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
      const ex = extractTrades(row);
      for (const t of ex) trades.push(t);
    } else if (ch === 'orderbook') {
      const ob = extractOrderbook(row);
      if (ob) books.push(ob);
    } else if (ch === 'activeAssetCtx') {
      const cx = extractCtx(row);
      if (cx) ctxs.push(cx);
    }
  }

  trades.sort((a, b) => a.ts - b.ts);
  books.sort((a, b) => a.ts - b.ts);
  ctxs.sort((a, b) => a.ts - b.ts);
  return { trades, books, ctxs };
}

function buildPriceSecondSeries(trades) {
  const bySec = new Map();
  for (const t of trades) {
    const sec = Math.floor(t.ts / 1000);
    bySec.set(sec, t.px);
  }
  return [...bySec.entries()].map(([sec, px]) => ({ sec, px })).sort((a, b) => a.sec - b.sec);
}

function detectMoveEvents(priceSecs, cfg) {
  const secIdx = new Map(priceSecs.map((x, i) => [x.sec, i]));
  const candidates = [];
  for (let i = 0; i < priceSecs.length; i += 1) {
    const start = priceSecs[i];
    const endSec = start.sec + cfg.moveWindowSec;
    const j = secIdx.get(endSec);
    if (j == null) continue;
    const end = priceSecs[j];
    if (!Number.isFinite(start.px) || !Number.isFinite(end.px) || start.px <= 0) continue;
    const retBps = ((end.px - start.px) / start.px) * 10000;
    candidates.push({
      startSec: start.sec,
      endSec: end.sec,
      eventTs: end.sec * 1000,
      absRetBps: Math.abs(retBps),
      retBps,
    });
  }
  if (candidates.length === 0) return { thresholdBps: null, events: [] };

  const absArr = candidates.map((x) => x.absRetBps);
  const th = Number.isFinite(cfg.moveBps) ? cfg.moveBps : (quantile(absArr, cfg.eventQuantile) ?? 2.0);
  const selected = candidates.filter((x) => x.absRetBps >= th).sort((a, b) => a.eventTs - b.eventTs);

  const events = [];
  let lastTs = -Infinity;
  const minGapMs = cfg.minGapSec * 1000;
  for (const ev of selected) {
    if ((ev.eventTs - lastTs) < minGapMs) continue;
    events.push(ev);
    lastTs = ev.eventTs;
  }
  return { thresholdBps: th, events };
}

function featureWindow(startTs, endTs, trades, books, ctxs) {
  const ti = lowerBoundByTs(trades, startTs);
  const tj = lowerBoundByTs(trades, endTs);
  const bi = lowerBoundByTs(books, startTs);
  const bj = lowerBoundByTs(books, endTs);
  const ci = lowerBoundByTs(ctxs, startTs);
  const cj = lowerBoundByTs(ctxs, endTs);

  const tw = trades.slice(ti, tj);
  const bw = books.slice(bi, bj);
  const cw = ctxs.slice(ci, cj);

  let buyNotional = 0;
  let sellNotional = 0;
  for (const t of tw) {
    if (t.side === 'buy') buyNotional += t.notional;
    else if (t.side === 'sell') sellNotional += t.notional;
  }
  const totalNotional = buyNotional + sellNotional;
  const ofi = totalNotional > 0 ? ((buyNotional - sellNotional) / totalNotional) : 0;

  const halfTs = startTs + Math.floor((endTs - startTs) / 2);
  const firstHalf = tw.filter((t) => t.ts < halfTs);
  const secondHalf = tw.filter((t) => t.ts >= halfTs);
  function ofiOf(arr) {
    let b = 0; let s = 0;
    for (const t of arr) {
      if (t.side === 'buy') b += t.notional;
      else if (t.side === 'sell') s += t.notional;
    }
    return (b + s) > 0 ? ((b - s) / (b + s)) : 0;
  }
  const flowAccel = ofiOf(secondHalf) - ofiOf(firstHalf);

  const signs = tw.map((t) => (t.side === 'buy' ? 1 : -1));
  let flips = 0;
  for (let i = 1; i < signs.length; i += 1) {
    if (signs[i] !== signs[i - 1]) flips += 1;
  }
  const flipRate = signs.length > 1 ? (flips / (signs.length - 1)) : 0;
  const tradeRate = (endTs - startTs) > 0 ? (tw.length / ((endTs - startTs) / 1000)) : 0;

  const spreads = bw.map((x) => x.spreadBps).filter(Number.isFinite);
  const depthImb = bw.map((x) => x.depthImbalance).filter(Number.isFinite);
  const wallMax = bw.map((x) => x.wallUsdMax).filter(Number.isFinite);
  const avgSpreadBps = spreads.length > 0 ? mean(spreads) : null;
  const spreadDeltaBps = spreads.length > 1 ? (spreads[spreads.length - 1] - spreads[0]) : null;
  const avgDepthImbalance = depthImb.length > 0 ? mean(depthImb) : null;
  const wallStrengthP90 = wallMax.length > 0 ? quantile(wallMax, 0.9) : null;

  const firstCtx = cw.length > 0 ? cw[0] : null;
  const lastCtx = cw.length > 0 ? cw[cw.length - 1] : null;
  const deltaPremium = (firstCtx && lastCtx && Number.isFinite(firstCtx.premium) && Number.isFinite(lastCtx.premium))
    ? (lastCtx.premium - firstCtx.premium)
    : null;
  const deltaOiPct = (firstCtx && lastCtx && Number.isFinite(firstCtx.oi) && Number.isFinite(lastCtx.oi) && firstCtx.oi > 0)
    ? ((lastCtx.oi - firstCtx.oi) / firstCtx.oi)
    : null;

  return {
    ofi,
    flowAccel,
    flipRate,
    tradeRate,
    avgSpreadBps,
    spreadDeltaBps,
    avgDepthImbalance,
    wallStrengthP90,
    deltaPremium,
    deltaOiPct,
    nTrades: tw.length,
    nBooks: bw.length,
    nCtx: cw.length,
  };
}

function collectFeatureRows(events, leadWindowSec, trades, books, ctxs) {
  const out = [];
  for (const ev of events) {
    const endTs = ev.eventTs;
    const startTs = endTs - (leadWindowSec * 1000);
    const feat = featureWindow(startTs, endTs, trades, books, ctxs);
    out.push({
      ts: endTs,
      absRetBps: ev.absRetBps,
      retBps: ev.retBps,
      ...feat,
    });
  }
  return out;
}

function buildControlEvents(priceSecs, eventSetTs, leadWindowSec, maxCount) {
  const controls = [];
  const gapSec = Math.max(leadWindowSec, 30);
  for (let i = gapSec; i < priceSecs.length - gapSec; i += gapSec) {
    const ts = priceSecs[i].sec * 1000;
    if (eventSetTs.has(ts)) continue;
    controls.push({ eventTs: ts, absRetBps: 0, retBps: 0 });
    if (controls.length >= maxCount) break;
  }
  return controls;
}

function evaluateLeadSignals(eventRows, controlRows) {
  const features = [
    'ofi', 'flowAccel', 'flipRate', 'tradeRate',
    'avgSpreadBps', 'spreadDeltaBps', 'avgDepthImbalance', 'wallStrengthP90',
    'deltaPremium', 'deltaOiPct'
  ];
  const results = [];

  for (const f of features) {
    const eVals = eventRows.map((r) => r[f]).filter(Number.isFinite);
    const cVals = controlRows.map((r) => r[f]).filter(Number.isFinite);
    if (eVals.length < 20 || cVals.length < 20) {
      results.push({
        feature: f,
        usable: false,
        reason: 'insufficient_samples',
      });
      continue;
    }

    const eMean = mean(eVals) ?? 0;
    const cMean = mean(cVals) ?? 0;
    const direction = eMean >= cMean ? 'higher' : 'lower';
    const threshold = direction === 'higher'
      ? (quantile(cVals, 0.75) ?? cMean)
      : (quantile(cVals, 0.25) ?? cMean);

    const hitE = eVals.filter((v) => direction === 'higher' ? v >= threshold : v <= threshold).length;
    const hitC = cVals.filter((v) => direction === 'higher' ? v >= threshold : v <= threshold).length;
    const hitRateE = hitE / eVals.length;
    const hitRateC = hitC / cVals.length;

    results.push({
      feature: f,
      usable: true,
      direction,
      threshold: round(threshold, 6),
      eventMean: round(eMean, 6),
      controlMean: round(cMean, 6),
      eventHitRate: round(hitRateE, 4),
      controlHitRate: round(hitRateC, 4),
      repeatabilityLift: round(hitRateE - hitRateC, 4),
      eventSamples: eVals.length,
      controlSamples: cVals.length,
    });
  }

  results.sort((a, b) => {
    const av = Number.isFinite(a.repeatabilityLift) ? a.repeatabilityLift : -Infinity;
    const bv = Number.isFinite(b.repeatabilityLift) ? b.repeatabilityLift : -Infinity;
    return bv - av;
  });
  return results;
}

function signalSatisfied(row, signal) {
  if (!signal || signal.usable !== true) return false;
  const value = toNum(row?.[signal.feature], NaN);
  if (!Number.isFinite(value) || !Number.isFinite(signal.threshold)) return false;
  if (signal.direction === 'higher') return value >= signal.threshold;
  if (signal.direction === 'lower') return value <= signal.threshold;
  return false;
}

function evaluateCompositeSignals(eventRows, controlRows, leadSignals) {
  const usable = leadSignals
    .filter((s) => s.usable === true && Number.isFinite(s.repeatabilityLift))
    .sort((a, b) => (b.repeatabilityLift ?? -Infinity) - (a.repeatabilityLift ?? -Infinity));

  const top3 = usable.slice(0, 3);
  if (top3.length < 3) {
    return {
      available: false,
      reason: 'insufficient_usable_signals',
      topSignals: top3.map((s) => s.feature),
    };
  }

  function countHits(rows, minMatch) {
    let hit = 0;
    for (const r of rows) {
      let matched = 0;
      for (const s of top3) {
        if (signalSatisfied(r, s)) matched += 1;
      }
      if (matched >= minMatch) hit += 1;
    }
    return hit;
  }

  const eventN = Math.max(1, eventRows.length);
  const controlN = Math.max(1, controlRows.length);
  const hit2Event = countHits(eventRows, 2);
  const hit2Control = countHits(controlRows, 2);
  const hit3Event = countHits(eventRows, 3);
  const hit3Control = countHits(controlRows, 3);

  return {
    available: true,
    topSignals: top3.map((s) => ({
      feature: s.feature,
      direction: s.direction,
      threshold: s.threshold,
      repeatabilityLift: s.repeatabilityLift,
    })),
    match2of3: {
      eventHitRate: round(hit2Event / eventN, 4),
      controlHitRate: round(hit2Control / controlN, 4),
      lift: round((hit2Event / eventN) - (hit2Control / controlN), 4),
    },
    match3of3: {
      eventHitRate: round(hit3Event / eventN, 4),
      controlHitRate: round(hit3Control / controlN, 4),
      lift: round((hit3Event / eventN) - (hit3Control / controlN), 4),
    },
  };
}

function pearsonCorrelation(rows, featureA, featureB) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const pairs = [];
  for (const row of rows) {
    const a = toNum(row?.[featureA], NaN);
    const b = toNum(row?.[featureB], NaN);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  if (pairs.length < 20) return null;

  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function evaluateTopSignalCorrelations(eventRows, controlRows, leadSignals, topN = 5) {
  const usable = leadSignals
    .filter((s) => s.usable === true && Number.isFinite(s.repeatabilityLift))
    .sort((a, b) => (b.repeatabilityLift ?? -Infinity) - (a.repeatabilityLift ?? -Infinity));
  const top = usable.slice(0, topN);
  if (top.length < 2) {
    return {
      available: false,
      reason: 'insufficient_top_signals',
      topSignals: top.map((s) => s.feature),
    };
  }

  const pairs = [];
  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) {
      const a = top[i].feature;
      const b = top[j].feature;
      const eventCorr = pearsonCorrelation(eventRows, a, b);
      const controlCorr = pearsonCorrelation(controlRows, a, b);
      const absEvent = Number.isFinite(eventCorr) ? Math.abs(eventCorr) : null;
      const absControl = Number.isFinite(controlCorr) ? Math.abs(controlCorr) : null;
      const independenceFlag = Number.isFinite(absEvent) && Number.isFinite(absControl)
        ? (absEvent < 0.3 && absControl < 0.3)
        : null;
      pairs.push({
        pair: `${a}__${b}`,
        eventPearson: round(eventCorr, 4),
        controlPearson: round(controlCorr, 4),
        absEventPearson: round(absEvent, 4),
        absControlPearson: round(absControl, 4),
        likelyIndependent: independenceFlag,
      });
    }
  }

  return {
    available: true,
    topSignals: top.map((s) => ({
      feature: s.feature,
      direction: s.direction,
      threshold: s.threshold,
      repeatabilityLift: s.repeatabilityLift,
    })),
    pairs,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const rawPath = args.raw ? path.resolve(process.cwd(), args.raw) : resolveLatestRawFile('logs');
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.error('[ws_lead_indicator_scan] raw file not found');
    process.exit(1);
  }

  const { trades, books, ctxs } = await loadRaw(rawPath);
  const priceSecs = buildPriceSecondSeries(trades);
  if (priceSecs.length < 300) {
    console.log(JSON.stringify({ ok: false, reason: 'insufficient_price_series', nPriceSecs: priceSecs.length }, null, 2));
    return;
  }

  const move = detectMoveEvents(priceSecs, args);
  const eventRows = collectFeatureRows(move.events, args.leadWindowSec, trades, books, ctxs);
  const eventSet = new Set(move.events.map((e) => e.eventTs));
  const controls = buildControlEvents(priceSecs, eventSet, args.leadWindowSec, eventRows.length);
  const controlRows = collectFeatureRows(controls, args.leadWindowSec, trades, books, ctxs);
  const leadSignals = evaluateLeadSignals(eventRows, controlRows);
  const compositeSignals = evaluateCompositeSignals(eventRows, controlRows, leadSignals);
  const topSignalCorrelations = evaluateTopSignalCorrelations(eventRows, controlRows, leadSignals, 5);

  const report = {
    ok: true,
    rawPath,
    config: {
      moveWindowSec: args.moveWindowSec,
      leadWindowSec: args.leadWindowSec,
      eventQuantile: args.eventQuantile,
      moveBpsThreshold: round(move.thresholdBps, 4),
      minGapSec: args.minGapSec,
    },
    sample: {
      tradesTicks: trades.length,
      orderbookTicks: books.length,
      ctxTicks: ctxs.length,
      priceSeconds: priceSecs.length,
      events: move.events.length,
      controls: controls.length,
    },
    eventMoveStats: {
      absRetBpsMedian: round(median(move.events.map((e) => e.absRetBps)) ?? NaN, 4),
      absRetBpsP90: round(quantile(move.events.map((e) => e.absRetBps), 0.9) ?? NaN, 4),
    },
    topSignalCorrelations,
    compositeSignals,
    leadSignalsTop: leadSignals.slice(0, 10),
    leadSignalsAll: leadSignals,
    notes: [
      'Goal: find WS features that appear BEFORE large price moves.',
      'repeatabilityLift = eventHitRate - controlHitRate (higher is better).',
      'This is research-only; no trading logic is changed.'
    ],
  };

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[ws_lead_indicator_scan] failed', err?.stack || err?.message || String(err));
  process.exit(1);
});
