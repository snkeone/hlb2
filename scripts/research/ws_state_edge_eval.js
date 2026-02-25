#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(v, d = 6) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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

function median(arr) {
  return quantile(arr, 0.5);
}

function lowerBoundNum(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

function formatYmdFromSec(sec) {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseArgs(argv) {
  const out = {
    raw: null,
    logsDir: 'logs',
    outDir: 'logs/ops/ws_edge_eval',
    leadWindowSec: 20,
    horizonSec: 10,
    sampleSec: 5,
    moveBps: 5,
    postWindowSec: 0,
    direction: 'abs',
    trainDays: 20,
    testDays: 5,
    xSpec: 'avgSpreadBps:0.90:ge,tradeRate:0.85:ge,wallStrengthP90:0.80:ge',
    bSpec: '',
    cSpec: '',
    minBaseAN: 100,
    minGroupN: 30,
    feeBps: 0,
    slippageBps: 0,
    maxSamplesPerDay: 0,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--raw') out.raw = String(argv[++i] ?? '');
    else if (a === '--logs-dir') out.logsDir = String(argv[++i] ?? out.logsDir);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--lead-window-sec') out.leadWindowSec = Math.max(5, Math.floor(toNum(argv[++i], out.leadWindowSec)));
    else if (a === '--horizon-sec') out.horizonSec = Math.max(1, Math.floor(toNum(argv[++i], out.horizonSec)));
    else if (a === '--sample-sec') out.sampleSec = Math.max(1, Math.floor(toNum(argv[++i], out.sampleSec)));
    else if (a === '--move-bps') out.moveBps = Math.max(0.1, toNum(argv[++i], out.moveBps));
    else if (a === '--post-window-sec') out.postWindowSec = Math.max(0, Math.floor(toNum(argv[++i], out.postWindowSec)));
    else if (a === '--direction') {
      const d = String(argv[++i] ?? out.direction).toLowerCase();
      if (['abs', 'up', 'down'].includes(d)) out.direction = d;
    } else if (a === '--train-days') out.trainDays = Math.max(1, Math.floor(toNum(argv[++i], out.trainDays)));
    else if (a === '--test-days') out.testDays = Math.max(1, Math.floor(toNum(argv[++i], out.testDays)));
    else if (a === '--x-spec') out.xSpec = String(argv[++i] ?? out.xSpec);
    else if (a === '--b-spec') out.bSpec = String(argv[++i] ?? out.bSpec);
    else if (a === '--c-spec') out.cSpec = String(argv[++i] ?? out.cSpec);
    else if (a === '--min-base-a-n') out.minBaseAN = Math.max(1, Math.floor(toNum(argv[++i], out.minBaseAN)));
    else if (a === '--min-group-n') out.minGroupN = Math.max(1, Math.floor(toNum(argv[++i], out.minGroupN)));
    else if (a === '--fee-bps') out.feeBps = Math.max(0, toNum(argv[++i], out.feeBps));
    else if (a === '--slippage-bps') out.slippageBps = Math.max(0, toNum(argv[++i], out.slippageBps));
    else if (a === '--max-samples-per-day') out.maxSamplesPerDay = Math.max(0, Math.floor(toNum(argv[++i], out.maxSamplesPerDay)));
  }
  return out;
}

function listRawFiles(logsDir) {
  const abs = path.resolve(process.cwd(), logsDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((n) => /^raw-\d{8}\.jsonl$/.test(n))
    .sort()
    .map((n) => path.join(abs, n));
}

function pickRawTargets(args) {
  if (args.raw) {
    const rawAbs = path.resolve(process.cwd(), args.raw);
    return [rawAbs];
  }
  return listRawFiles(args.logsDir);
}

function extractSourceDate(rawPath) {
  const base = path.basename(String(rawPath || ''));
  const m = base.match(/^raw-(\d{8})\.jsonl$/);
  return m ? m[1] : null;
}

function parseXSpec(spec) {
  const tokens = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const [feature, qStr, opRaw] = t.split(':');
    const q = toNum(qStr, NaN);
    const op = String(opRaw || 'ge').toLowerCase();
    if (!feature || !Number.isFinite(q) || q < 0 || q > 1 || !['ge', 'le'].includes(op)) {
      throw new Error(`invalid --x-spec token: ${t}`);
    }
    out.push({ feature, q, op });
  }
  if (out.length === 0) throw new Error('x-spec is empty');
  return out;
}

function parseOptionalSpec(spec) {
  const s = String(spec || '').trim();
  if (!s) return [];
  return parseXSpec(s);
}

function extractTrades(row) {
  const out = [];
  const envelope = row?.message && typeof row.message === 'object' ? row.message : row;
  const d = envelope?.data ?? row?.data;
  const inner = Array.isArray(d)
    ? d
    : (d && typeof d === 'object' && Array.isArray(d.data) ? d.data : null);
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
  const envelope = row?.message && typeof row.message === 'object' ? row.message : row;
  const d = envelope?.data ?? row?.data;
  const inner = (d && typeof d === 'object' && Array.isArray(d.levels))
    ? d
    : (d && typeof d === 'object' && d.data && typeof d.data === 'object' ? d.data : null);
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
  const bestBidSz = bids[0].sz;
  const bestAskSz = asks[0].sz;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : null;
  const microprice = (bestBidSz + bestAskSz) > 0
    ? ((bestAsk * bestBidSz) + (bestBid * bestAskSz)) / (bestBidSz + bestAskSz)
    : null;
  const micropriceDevBps = (Number.isFinite(microprice) && mid > 0)
    ? ((microprice - mid) / mid) * 10000
    : null;
  const bidUsdTop5 = bids.slice(0, 5).reduce((s, x) => s + x.usd, 0);
  const askUsdTop5 = asks.slice(0, 5).reduce((s, x) => s + x.usd, 0);
  const depthImbalance = (bidUsdTop5 + askUsdTop5) > 0
    ? ((bidUsdTop5 - askUsdTop5) / (bidUsdTop5 + askUsdTop5))
    : 0;
  const wallUsdMax = Math.max(
    bids.length > 0 ? Math.max(...bids.slice(0, 10).map((x) => x.usd)) : 0,
    asks.length > 0 ? Math.max(...asks.slice(0, 10).map((x) => x.usd)) : 0,
  );
  const bidWallUsdMax = bids.length > 0 ? Math.max(...bids.slice(0, 10).map((x) => x.usd)) : 0;
  const askWallUsdMax = asks.length > 0 ? Math.max(...asks.slice(0, 10).map((x) => x.usd)) : 0;

  return {
    ts,
    mid,
    spreadBps,
    micropriceDevBps,
    depthImbalance,
    wallUsdMax,
    bidWallUsdMax,
    askWallUsdMax,
  };
}

function buildPriceSecondSeries(trades) {
  const bySec = new Map();
  for (const t of trades) {
    const sec = Math.floor(t.ts / 1000);
    bySec.set(sec, t.px);
  }
  return [...bySec.entries()].map(([sec, px]) => ({ sec, px })).sort((a, b) => a.sec - b.sec);
}

function priceAtOrBefore(priceSecs, sec) {
  const secArr = priceSecs.map((x) => x.sec);
  const pos = lowerBoundNum(secArr, sec + 1) - 1;
  if (pos < 0 || pos >= priceSecs.length) return null;
  return priceSecs[pos].px;
}

function featureWindow(startTs, endTs, trades, books) {
  const ti = lowerBoundByTs(trades, startTs);
  const tj = lowerBoundByTs(trades, endTs);
  const bi = lowerBoundByTs(books, startTs);
  const bj = lowerBoundByTs(books, endTs);

  const tw = trades.slice(ti, tj);
  const bw = books.slice(bi, bj);

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
    let b = 0;
    let s = 0;
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
  const maxRun = (targetSign) => {
    let run = 0;
    let best = 0;
    for (const s of signs) {
      if (s === targetSign) {
        run += 1;
        if (run > best) best = run;
      } else run = 0;
    }
    return best;
  };
  const maxBuyRun = maxRun(1);
  const maxSellRun = maxRun(-1);
  const buyRunShare = signs.length > 0 ? (maxBuyRun / signs.length) : 0;
  const sellRunShare = signs.length > 0 ? (maxSellRun / signs.length) : 0;

  const px0 = tw.length > 0 ? toNum(tw[0]?.px, NaN) : NaN;
  const px1 = tw.length > 0 ? toNum(tw[tw.length - 1]?.px, NaN) : NaN;
  const microDriftBps = Number.isFinite(px0) && Number.isFinite(px1) && px0 > 0
    ? ((px1 - px0) / px0) * 10000
    : null;

  const spreads = bw.map((x) => x.spreadBps).filter(Number.isFinite);
  const depthImb = bw.map((x) => x.depthImbalance).filter(Number.isFinite);
  const wallMax = bw.map((x) => x.wallUsdMax).filter(Number.isFinite);
  const microDev = bw.map((x) => x.micropriceDevBps).filter(Number.isFinite);
  const bidWallMax = bw.map((x) => x.bidWallUsdMax).filter(Number.isFinite);
  const askWallMax = bw.map((x) => x.askWallUsdMax).filter(Number.isFinite);
  const wallDomSign = bw.map((x) => {
    const b = toNum(x.bidWallUsdMax, NaN);
    const a = toNum(x.askWallUsdMax, NaN);
    if (!Number.isFinite(b) || !Number.isFinite(a)) return 0;
    if (b > a) return 1;
    if (a > b) return -1;
    return 0;
  });
  const nonZeroWallSigns = wallDomSign.filter((s) => s !== 0);
  let wallFlips = 0;
  for (let i = 1; i < nonZeroWallSigns.length; i += 1) {
    if (nonZeroWallSigns[i] !== nonZeroWallSigns[i - 1]) wallFlips += 1;
  }
  const wallDominanceFlipRate = nonZeroWallSigns.length > 1 ? (wallFlips / (nonZeroWallSigns.length - 1)) : 0;
  const wallBidDominanceRate = wallDomSign.length > 0 ? (wallDomSign.filter((s) => s > 0).length / wallDomSign.length) : 0;
  const wallAskDominanceRate = wallDomSign.length > 0 ? (wallDomSign.filter((s) => s < 0).length / wallDomSign.length) : 0;
  const wallImbalance = (() => {
    const mb = mean(bidWallMax);
    const ma = mean(askWallMax);
    if (!Number.isFinite(mb) || !Number.isFinite(ma) || (mb + ma) === 0) return null;
    return (mb - ma) / (mb + ma);
  })();

  return {
    ofi,
    flowAccel,
    flipRate,
    tradeRate,
    avgSpreadBps: spreads.length > 0 ? mean(spreads) : null,
    spreadDeltaBps: spreads.length > 1 ? (spreads[spreads.length - 1] - spreads[0]) : null,
    avgMicropriceDevBps: microDev.length > 0 ? mean(microDev) : null,
    microDriftBps,
    avgDepthImbalance: depthImb.length > 0 ? mean(depthImb) : null,
    wallImbalance,
    wallBidDominanceRate,
    wallAskDominanceRate,
    wallDominanceFlipRate,
    wallStrengthP90: wallMax.length > 0 ? quantile(wallMax, 0.9) : null,
    buyRunShare,
    sellRunShare,
    nTrades: tw.length,
    nBooks: bw.length,
  };
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
    const envelope = row?.message && typeof row.message === 'object' ? row.message : row;
    const ch = String(envelope?.channel ?? row?.channel ?? '');
    if (ch === 'trades') {
      const ex = extractTrades(row);
      for (const t of ex) trades.push(t);
    } else if (ch === 'orderbook' || ch === 'l2Book') {
      const ob = extractOrderbook(row);
      if (ob) books.push(ob);
    }
  }

  trades.sort((a, b) => a.ts - b.ts);
  books.sort((a, b) => a.ts - b.ts);
  return { trades, books };
}

function buildRowsForRaw(rawPath, cfg) {
  const sourceDate = extractSourceDate(rawPath);
  return loadRaw(rawPath).then(({ trades, books }) => {
    const priceSecs = buildPriceSecondSeries(trades);
    if (priceSecs.length === 0) return [];

    const firstSec = priceSecs[0].sec;
    const lastSec = priceSecs[priceSecs.length - 1].sec;
    const rows = [];

    for (let sec = firstSec + cfg.leadWindowSec; sec <= lastSec - cfg.horizonSec; sec += cfg.sampleSec) {
      const px0 = priceAtOrBefore(priceSecs, sec);
      const px1 = priceAtOrBefore(priceSecs, sec + cfg.horizonSec);
      const px2 = cfg.postWindowSec > 0 ? priceAtOrBefore(priceSecs, sec + cfg.horizonSec + cfg.postWindowSec) : null;
      if (!Number.isFinite(px0) || !Number.isFinite(px1) || px0 <= 0) continue;

      const endTs = sec * 1000;
      const startTs = endTs - (cfg.leadWindowSec * 1000);
      const f = featureWindow(startTs, endTs, trades, books);
      if (!Number.isFinite(f.avgSpreadBps) && !Number.isFinite(f.tradeRate)) continue;

      const retBps = ((px1 - px0) / px0) * 10000;
      const postRetBps = (cfg.postWindowSec > 0 && Number.isFinite(px2) && px1 > 0)
        ? ((px2 - px1) / px1) * 10000
        : null;
      rows.push({
        date: sourceDate || formatYmdFromSec(sec),
        utcDate: formatYmdFromSec(sec),
        ts: endTs,
        sec,
        retBps,
        netRetBps: retBps - (cfg.feeBps + cfg.slippageBps),
        postRetBps,
        postNetRetBps: Number.isFinite(postRetBps) ? (postRetBps - (cfg.feeBps + cfg.slippageBps)) : null,
        ...f,
      });

      if (cfg.maxSamplesPerDay > 0 && rows.length >= cfg.maxSamplesPerDay) break;
    }

    return rows;
  });
}

function yHit(retBps, direction, moveBps) {
  if (!Number.isFinite(retBps)) return false;
  if (direction === 'abs') return Math.abs(retBps) >= moveBps;
  if (direction === 'up') return retBps >= moveBps;
  return retBps <= -moveBps;
}

function buildXMask(rows, conds, thresholds) {
  const out = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    let ok = true;
    for (const c of conds) {
      const v = toNum(r?.[c.feature], NaN);
      const th = toNum(thresholds?.[c.feature], NaN);
      if (!Number.isFinite(v) || !Number.isFinite(th)) {
        ok = false;
        break;
      }
      if (c.op === 'ge' && !(v >= th)) {
        ok = false;
        break;
      }
      if (c.op === 'le' && !(v <= th)) {
        ok = false;
        break;
      }
    }
    out[i] = ok;
  }
  return out;
}

function fitThresholds(rows, conds, minSamples = 20) {
  const th = {};
  for (const c of conds) {
    const vals = rows.map((r) => toNum(r?.[c.feature], NaN)).filter(Number.isFinite);
    if (vals.length < minSamples) throw new Error(`insufficient feature samples: ${c.feature}`);
    const qv = quantile(vals, c.q);
    if (!Number.isFinite(qv)) throw new Error(`quantile failed: ${c.feature}`);
    th[c.feature] = qv;
  }
  return th;
}

function upliftCI95(py, pyx, n, nx) {
  if (!Number.isFinite(py) || !Number.isFinite(pyx) || n <= 0 || nx <= 0) return { low: null, high: null };
  const se = Math.sqrt((py * (1 - py) / n) + (pyx * (1 - pyx) / nx));
  return { low: pyx - py - (1.96 * se), high: pyx - py + (1.96 * se) };
}

function skewness(arr) {
  const vals = arr.filter(Number.isFinite);
  if (vals.length < 3) return null;
  const m = mean(vals);
  const n = vals.length;
  let m2 = 0;
  let m3 = 0;
  for (const v of vals) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 <= 0) return null;
  return m3 / (m2 ** 1.5);
}

function calcMetrics(rows, xmask, cfg) {
  const n = rows.length;
  let nx = 0;
  let ny = 0;
  let nxy = 0;
  const allRet = [];
  const xRet = [];
  const xyRet = [];
  const xyPostRet = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const y = yHit(r.retBps, cfg.direction, cfg.moveBps);
    const x = xmask[i] === true;
    const ret = toNum(r.netRetBps, NaN);
    if (Number.isFinite(ret)) allRet.push(ret);
    if (y) ny += 1;
    if (x) {
      nx += 1;
      if (Number.isFinite(ret)) xRet.push(ret);
      if (y) {
        nxy += 1;
        if (Number.isFinite(ret)) xyRet.push(ret);
        const postRet = toNum(r.postNetRetBps, NaN);
        if (Number.isFinite(postRet)) xyPostRet.push(postRet);
      }
    }
  }

  const py = n > 0 ? ny / n : null;
  const pyx = nx > 0 ? nxy / nx : null;
  const uplift = (Number.isFinite(py) && Number.isFinite(pyx)) ? (pyx - py) : null;
  const ratio = (Number.isFinite(py) && py > 0 && Number.isFinite(pyx)) ? (pyx / py) : null;
  const ci = upliftCI95(py, pyx, n, nx);

  return {
    n,
    nx,
    ny,
    nxy,
    coverage: n > 0 ? nx / n : null,
    py,
    pyx,
    uplift,
    ratio,
    upliftCi95Low: ci.low,
    upliftCi95High: ci.high,
    distribution: {
      baseline: {
        medianNetRetBps: median(allRet),
        p10NetRetBps: quantile(allRet, 0.1),
        p90NetRetBps: quantile(allRet, 0.9),
        skewNetRet: skewness(allRet),
      },
      conditionedX: {
        medianNetRetBps: median(xRet),
        p10NetRetBps: quantile(xRet, 0.1),
        p90NetRetBps: quantile(xRet, 0.9),
        skewNetRet: skewness(xRet),
      },
      conditionedXY: {
        meanNetRetBps: mean(xyRet),
        medianNetRetBps: median(xyRet),
        p10NetRetBps: quantile(xyRet, 0.1),
        p90NetRetBps: quantile(xyRet, 0.9),
        skewNetRet: skewness(xyRet),
        postWindowSec: cfg.postWindowSec,
        postMeanNetRetBps: mean(xyPostRet),
        postMedianNetRetBps: median(xyPostRet),
        postP10NetRetBps: quantile(xyPostRet, 0.1),
        postP90NetRetBps: quantile(xyPostRet, 0.9),
        postSkewNetRet: skewness(xyPostRet),
      },
    },
  };
}

function calcRoutingMetrics(rows, aMask, bMask, cMask, cfg) {
  const idxA = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (aMask[i] === true) idxA.push(i);
  }

  const base = (() => {
    const n = idxA.length;
    if (n === 0) return { n: 0, pAbsMove: null, pUpMove: null, pDownMove: null, meanRetBps: null };
    let nAbs = 0;
    let nUp = 0;
    let nDown = 0;
    const rets = [];
    for (const i of idxA) {
      const ret = toNum(rows[i]?.retBps, NaN);
      if (Number.isFinite(ret)) rets.push(ret);
      if (Number.isFinite(ret) && Math.abs(ret) >= cfg.moveBps) nAbs += 1;
      if (Number.isFinite(ret) && ret >= cfg.moveBps) nUp += 1;
      if (Number.isFinite(ret) && ret <= -cfg.moveBps) nDown += 1;
    }
    return {
      n,
      pAbsMove: nAbs / n,
      pUpMove: nUp / n,
      pDownMove: nDown / n,
      meanRetBps: mean(rets),
    };
  })();

  function calcGroup(name, pred) {
    const ids = idxA.filter((i) => pred(i));
    const n = ids.length;
    if (n === 0) {
      return {
        name,
        n: 0,
        pAbsMove: null,
        pUpMove: null,
        pDownMove: null,
        meanRetBps: null,
        upliftUpVsA: null,
        upliftDownVsA: null,
      };
    }
    let nAbs = 0;
    let nUp = 0;
    let nDown = 0;
    const rets = [];
    for (const i of ids) {
      const ret = toNum(rows[i]?.retBps, NaN);
      if (Number.isFinite(ret)) rets.push(ret);
      if (Number.isFinite(ret) && Math.abs(ret) >= cfg.moveBps) nAbs += 1;
      if (Number.isFinite(ret) && ret >= cfg.moveBps) nUp += 1;
      if (Number.isFinite(ret) && ret <= -cfg.moveBps) nDown += 1;
    }
    const pUp = nUp / n;
    const pDown = nDown / n;
    return {
      name,
      n,
      pAbsMove: nAbs / n,
      pUpMove: pUp,
      pDownMove: pDown,
      meanRetBps: mean(rets),
      upliftUpVsA: Number.isFinite(base.pUpMove) ? (pUp - base.pUpMove) : null,
      upliftDownVsA: Number.isFinite(base.pDownMove) ? (pDown - base.pDownMove) : null,
    };
  }

  return {
    baseA: base,
    groups: [
      calcGroup('B_only', (i) => bMask[i] === true && cMask[i] !== true),
      calcGroup('C_only', (i) => cMask[i] === true && bMask[i] !== true),
      calcGroup('B_and_C', (i) => bMask[i] === true && cMask[i] === true),
      calcGroup('neither', (i) => bMask[i] !== true && cMask[i] !== true),
    ],
  };
}

function calcRoutingPnl(rows, aMask, bMask, cMask, cfg) {
  const totalCostBps = cfg.feeBps + cfg.slippageBps;
  const bRets = [];
  const cRets = [];
  const allRets = [];
  let aCount = 0;
  let skippedConflict = 0;
  let skippedNeither = 0;

  for (let i = 0; i < rows.length; i += 1) {
    if (aMask[i] !== true) continue;
    aCount += 1;
    const ret = toNum(rows[i]?.retBps, NaN);
    if (!Number.isFinite(ret)) continue;

    const b = bMask[i] === true;
    const c = cMask[i] === true;
    if (b && !c) {
      const net = ret - totalCostBps;
      bRets.push(net);
      allRets.push(net);
    } else if (c && !b) {
      const net = (-ret) - totalCostBps;
      cRets.push(net);
      allRets.push(net);
    } else if (b && c) {
      skippedConflict += 1;
    } else {
      skippedNeither += 1;
    }
  }

  const out = {
    aCount,
    bTrades: {
      n: bRets.length,
      meanNetRetBps: mean(bRets),
      p10NetRetBps: quantile(bRets, 0.1),
      medianNetRetBps: median(bRets),
    },
    cTrades: {
      n: cRets.length,
      meanNetRetBps: mean(cRets),
      p10NetRetBps: quantile(cRets, 0.1),
      medianNetRetBps: median(cRets),
    },
    totalTrades: {
      n: allRets.length,
      meanNetRetBps: mean(allRets),
      p10NetRetBps: quantile(allRets, 0.1),
      medianNetRetBps: median(allRets),
      positiveRatio: allRets.length > 0 ? (allRets.filter((v) => v > 0).length / allRets.length) : null,
    },
    skipped: {
      conflictBAndC: skippedConflict,
      neither: skippedNeither,
    },
  };

  return out;
}

function gateColor(n, minN) {
  return Number.isFinite(n) && n >= minN ? 'GREEN' : 'GRAY';
}

function withRoutingGate(routing, cfg) {
  if (!routing) return null;
  const gatedGroups = (routing.groups || []).map((g) => ({
    ...g,
    gate: gateColor(toNum(g?.n, NaN), cfg.minGroupN),
  }));
  return {
    ...routing,
    baseA: {
      ...routing.baseA,
      gate: gateColor(toNum(routing?.baseA?.n, NaN), cfg.minBaseAN),
    },
    groups: gatedGroups,
  };
}

function calcRoutingDaily(rows, aMask, bMask, cMask, cfg) {
  const byDate = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const d = String(rows[i]?.date ?? '');
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(i);
  }
  const dates = [...byDate.keys()].sort();
  const days = [];
  for (const date of dates) {
    const idx = byDate.get(date) || [];
    if (idx.length === 0) continue;
    const dayRows = idx.map((i) => rows[i]);
    const dayAMask = idx.map((i) => aMask[i] === true);
    const dayBMask = idx.map((i) => bMask[i] === true);
    const dayCMask = idx.map((i) => cMask[i] === true);
    const dayRouting = withRoutingGate(calcRoutingMetrics(dayRows, dayAMask, dayBMask, dayCMask, cfg), cfg);
    days.push({ date, ...dayRouting });
  }
  return days;
}

function stableSignRatio(vals, pred) {
  const xs = (vals || []).filter(Number.isFinite);
  if (xs.length === 0) return null;
  return xs.filter((v) => pred(v)).length / xs.length;
}

function calcRoutingStabilityByDay(dailyRows) {
  const getGroup = (d, name) => (d?.groups || []).find((g) => g?.name === name) || null;
  const gated = dailyRows.filter((d) => d?.baseA?.gate === 'GREEN');
  const gatedB = gated.map((d) => getGroup(d, 'B_only')).filter((g) => g?.gate === 'GREEN');
  const gatedC = gated.map((d) => getGroup(d, 'C_only')).filter((g) => g?.gate === 'GREEN');

  return {
    gatedDays: gated.length,
    bOnlyDays: gatedB.length,
    cOnlyDays: gatedC.length,
    bOnly: {
      upliftUpPositiveRatio: stableSignRatio(gatedB.map((g) => toNum(g?.upliftUpVsA, NaN)), (v) => v > 0),
      upliftDownNegativeRatio: stableSignRatio(gatedB.map((g) => toNum(g?.upliftDownVsA, NaN)), (v) => v < 0),
    },
    cOnly: {
      upliftDownPositiveRatio: stableSignRatio(gatedC.map((g) => toNum(g?.upliftDownVsA, NaN)), (v) => v > 0),
      upliftUpNegativeRatio: stableSignRatio(gatedC.map((g) => toNum(g?.upliftUpVsA, NaN)), (v) => v < 0),
    },
  };
}

function calcAntisymmetry(routing) {
  if (!routing) return null;
  const baseOk = routing?.baseA?.gate === 'GREEN';
  const b = (routing.groups || []).find((g) => g?.name === 'B_only') || null;
  const c = (routing.groups || []).find((g) => g?.name === 'C_only') || null;
  const bOk = b?.gate === 'GREEN';
  const cOk = c?.gate === 'GREEN';

  const bPass = bOk
    && Number.isFinite(toNum(b?.upliftUpVsA, NaN))
    && Number.isFinite(toNum(b?.upliftDownVsA, NaN))
    && toNum(b?.upliftUpVsA, NaN) > 0
    && toNum(b?.upliftDownVsA, NaN) < 0;
  const cPass = cOk
    && Number.isFinite(toNum(c?.upliftUpVsA, NaN))
    && Number.isFinite(toNum(c?.upliftDownVsA, NaN))
    && toNum(c?.upliftDownVsA, NaN) > 0
    && toNum(c?.upliftUpVsA, NaN) < 0;

  const pass = baseOk && bPass && cPass;
  return {
    pass,
    gate: pass ? 'GREEN' : 'GRAY',
    baseGate: routing?.baseA?.gate || 'GRAY',
    bOnlyGate: b?.gate || 'GRAY',
    cOnlyGate: c?.gate || 'GRAY',
    bOnlyPass: bPass,
    cOnlyPass: cPass,
  };
}

function groupByDate(rows) {
  const m = new Map();
  for (const r of rows) {
    const d = String(r.date);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  const keys = [...m.keys()].sort();
  return { keys, map: m };
}

function walkForward(rows, conds, cfg) {
  const { keys: dates, map } = groupByDate(rows);
  const out = [];
  let fold = 0;
  for (let i = 0; i + cfg.trainDays + cfg.testDays <= dates.length; i += cfg.testDays) {
    const trainDays = dates.slice(i, i + cfg.trainDays);
    const testDays = dates.slice(i + cfg.trainDays, i + cfg.trainDays + cfg.testDays);
    const trainRows = trainDays.flatMap((d) => map.get(d) || []);
    const testRows = testDays.flatMap((d) => map.get(d) || []);
    if (trainRows.length === 0 || testRows.length === 0) continue;

    let thresholds;
    try {
      thresholds = fitThresholds(trainRows, conds);
    } catch {
      continue;
    }
    const xmask = buildXMask(testRows, conds, thresholds);
    const metrics = calcMetrics(testRows, xmask, cfg);

    out.push({
      fold,
      trainStart: trainDays[0],
      trainEnd: trainDays[trainDays.length - 1],
      testStart: testDays[0],
      testEnd: testDays[testDays.length - 1],
      ...Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [`th_${k}`, v])),
      ...metrics,
    });
    fold += 1;
  }
  return out;
}

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [keys.join(',')];
  for (const r of rows) lines.push(keys.map((k) => esc(r[k])).join(','));
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const rawTargets = pickRawTargets(args);
  if (rawTargets.length === 0) {
    console.error('[ws_state_edge_eval] no raw files found');
    process.exit(1);
  }

  const conds = parseXSpec(args.xSpec);
  const bConds = parseOptionalSpec(args.bSpec);
  const cConds = parseOptionalSpec(args.cSpec);
  const outDirAbs = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const allRows = [];
  for (const rawPath of rawTargets) {
    if (!fs.existsSync(rawPath)) continue;
    const rows = await buildRowsForRaw(rawPath, args);
    for (const r of rows) allRows.push(r);
  }

  if (allRows.length === 0) {
    console.error('[ws_state_edge_eval] no usable samples');
    process.exit(1);
  }

  allRows.sort((a, b) => a.ts - b.ts);

  const thresholdsAll = fitThresholds(allRows, conds);
  const xmaskAll = buildXMask(allRows, conds, thresholdsAll);
  const inSample = calcMetrics(allRows, xmaskAll, args);
  const wf = walkForward(allRows, conds, args);

  let routing = null;
  if (bConds.length > 0 || cConds.length > 0) {
    const aRows = allRows.filter((_, i) => xmaskAll[i] === true);
    let bThresholds = {};
    let cThresholds = {};
    try {
      if (bConds.length > 0) bThresholds = fitThresholds(aRows, bConds, 5);
      if (cConds.length > 0) cThresholds = fitThresholds(aRows, cConds, 5);
    } catch {
      bThresholds = {};
      cThresholds = {};
    }
    const bmaskAll = bConds.length > 0 ? buildXMask(allRows, bConds, bThresholds) : new Array(allRows.length).fill(false);
    const cmaskAll = cConds.length > 0 ? buildXMask(allRows, cConds, cThresholds) : new Array(allRows.length).fill(false);
    const routingRaw = {
      bSpec: args.bSpec,
      cSpec: args.cSpec,
      thresholds: {
        b: Object.fromEntries(Object.entries(bThresholds).map(([k, v]) => [k, round(v, 6)])),
        c: Object.fromEntries(Object.entries(cThresholds).map(([k, v]) => [k, round(v, 6)])),
      },
      ...calcRoutingMetrics(allRows, xmaskAll, bmaskAll, cmaskAll, args),
    };
    const routed = withRoutingGate(routingRaw, args);
    const daily = calcRoutingDaily(allRows, xmaskAll, bmaskAll, cmaskAll, args);
    routing = {
      ...routed,
      minGate: {
        minBaseAN: args.minBaseAN,
        minGroupN: args.minGroupN,
      },
      pnlExecution: calcRoutingPnl(allRows, xmaskAll, bmaskAll, cmaskAll, args),
      antisymmetry: calcAntisymmetry(routed),
      daily,
      stability: calcRoutingStabilityByDay(daily),
    };
  }

  const wfWeighted = (() => {
    if (wf.length === 0) return null;
    const totalSignals = wf.reduce((s, x) => s + Math.max(0, toNum(x.nx, 0)), 0);
    const weightedPyx = totalSignals > 0
      ? wf.reduce((s, x) => s + (toNum(x.pyx, 0) * Math.max(0, toNum(x.nx, 0))), 0) / totalSignals
      : null;
    const weightedUplift = totalSignals > 0
      ? wf.reduce((s, x) => s + (toNum(x.uplift, 0) * Math.max(0, toNum(x.nx, 0))), 0) / totalSignals
      : null;
    const posRatio = wf.length > 0
      ? wf.filter((x) => toNum(x.uplift, -Infinity) > 0).length / wf.length
      : null;
    return {
      folds: wf.length,
      weightedPyx,
      weightedUplift,
      positiveUpliftFoldRatio: posRatio,
      avgCoverage: mean(wf.map((x) => toNum(x.coverage, NaN)).filter(Number.isFinite)),
    };
  })();

  const eventsRows = allRows.map((r, i) => ({
    date: r.date,
    ts: r.ts,
    retBps: round(r.retBps, 6),
    netRetBps: round(r.netRetBps, 6),
    postRetBps: round(toNum(r.postRetBps, NaN), 6),
    postNetRetBps: round(toNum(r.postNetRetBps, NaN), 6),
    yHit: yHit(r.retBps, args.direction, args.moveBps) ? 1 : 0,
    xHit: xmaskAll[i] ? 1 : 0,
    ofi: round(r.ofi, 6),
    flowAccel: round(r.flowAccel, 6),
    flipRate: round(r.flipRate, 6),
    tradeRate: round(r.tradeRate, 6),
    avgSpreadBps: round(r.avgSpreadBps, 6),
    avgMicropriceDevBps: round(r.avgMicropriceDevBps, 6),
    microDriftBps: round(r.microDriftBps, 6),
    avgDepthImbalance: round(r.avgDepthImbalance, 6),
    wallImbalance: round(r.wallImbalance, 6),
    wallBidDominanceRate: round(r.wallBidDominanceRate, 6),
    wallAskDominanceRate: round(r.wallAskDominanceRate, 6),
    wallDominanceFlipRate: round(r.wallDominanceFlipRate, 6),
    wallStrengthP90: round(r.wallStrengthP90, 6),
    buyRunShare: round(r.buyRunShare, 6),
    sellRunShare: round(r.sellRunShare, 6),
  }));

  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      raw: args.raw,
      logsDir: args.logsDir,
      leadWindowSec: args.leadWindowSec,
      horizonSec: args.horizonSec,
      sampleSec: args.sampleSec,
      moveBps: args.moveBps,
      postWindowSec: args.postWindowSec,
      direction: args.direction,
      trainDays: args.trainDays,
      testDays: args.testDays,
      xSpec: args.xSpec,
      bSpec: args.bSpec,
      cSpec: args.cSpec,
      minBaseAN: args.minBaseAN,
      minGroupN: args.minGroupN,
      feeBps: args.feeBps,
      slippageBps: args.slippageBps,
      maxSamplesPerDay: args.maxSamplesPerDay,
    },
    sample: {
      rawFiles: rawTargets.length,
      rows: allRows.length,
      dates: [...new Set(allRows.map((r) => r.date))],
    },
    inSample: {
      thresholds: Object.fromEntries(Object.entries(thresholdsAll).map(([k, v]) => [k, round(v, 6)])),
      ...inSample,
    },
    routing,
    oosWalkForward: wfWeighted,
    notes: [
      'Edge definition: P(Y|X) versus P(Y), where Y is future move event.',
      'X thresholds are quantile-fitted on train split in walk-forward.',
      'netRetBps subtracts feeBps + slippageBps from forward return.',
      'Research-only output; no live trading logic is changed.',
    ],
  };

  fs.writeFileSync(path.join(outDirAbs, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'events_all.csv'), toCsv(eventsRows), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'walkforward.csv'), toCsv(wf.map((x) => ({
    ...x,
    py: round(toNum(x.py, NaN), 6),
    pyx: round(toNum(x.pyx, NaN), 6),
    uplift: round(toNum(x.uplift, NaN), 6),
    ratio: round(toNum(x.ratio, NaN), 6),
    coverage: round(toNum(x.coverage, NaN), 6),
    upliftCi95Low: round(toNum(x.upliftCi95Low, NaN), 6),
    upliftCi95High: round(toNum(x.upliftCi95High, NaN), 6),
    baselineDistribution: x.distribution?.baseline ?? null,
    conditionedDistribution: x.distribution?.conditionedX ?? null,
    conditionedYDistribution: x.distribution?.conditionedXY ?? null,
  }))), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    rows: summary.sample.rows,
    dates: summary.sample.dates.length,
    inSample: {
      py: round(toNum(summary.inSample.py, NaN), 6),
      pyx: round(toNum(summary.inSample.pyx, NaN), 6),
      uplift: round(toNum(summary.inSample.uplift, NaN), 6),
      ratio: round(toNum(summary.inSample.ratio, NaN), 6),
      coverage: round(toNum(summary.inSample.coverage, NaN), 6),
    },
    oosWalkForward: summary.oosWalkForward,
  }, null, 2));
}

main().catch((err) => {
  console.error('[ws_state_edge_eval] failed', err?.stack || err?.message || String(err));
  process.exit(1);
});
