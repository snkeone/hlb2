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

function parseListNums(s) {
  return String(s || '')
    .split(',')
    .map((x) => Math.floor(toNum(x, NaN)))
    .filter((x) => Number.isFinite(x) && x > 0);
}

function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function parseArgs(argv) {
  const out = {
    logsDir: 'logs',
    raw: '',
    outDir: 'logs/ops/ws_liq_monitor/latest',
    maxDays: 3,
    windowSec: 10,
    burstUsd: 100000,
    horizonsSec: [30, 60, 180],
    cooldownSec: 20,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--logs-dir') out.logsDir = String(argv[++i] ?? out.logsDir);
    else if (a === '--raw') out.raw = String(argv[++i] ?? out.raw);
    else if (a === '--out-dir') out.outDir = String(argv[++i] ?? out.outDir);
    else if (a === '--max-days') out.maxDays = Math.max(1, Math.floor(toNum(argv[++i], out.maxDays)));
    else if (a === '--window-sec') out.windowSec = Math.max(1, Math.floor(toNum(argv[++i], out.windowSec)));
    else if (a === '--burst-usd') out.burstUsd = Math.max(1, toNum(argv[++i], out.burstUsd));
    else if (a === '--horizons-sec') {
      const hs = parseListNums(argv[++i]);
      if (hs.length > 0) out.horizonsSec = hs;
    } else if (a === '--cooldown-sec') out.cooldownSec = Math.max(0, Math.floor(toNum(argv[++i], out.cooldownSec)));
  }
  out.horizonsSec = [...new Set(out.horizonsSec)].sort((a, b) => a - b);
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
  if (args.raw) return [path.resolve(process.cwd(), args.raw)];
  const xs = listRawFiles(args.logsDir);
  if (xs.length <= args.maxDays) return xs;
  return xs.slice(xs.length - args.maxDays);
}

function extractTrades(row) {
  const out = [];
  const arr = row?.data?.data;
  if (!Array.isArray(arr)) return out;
  for (const t of arr) {
    const ts = toNum(t?.time, toNum(t?.ts, toNum(row?.ts, NaN)));
    const px = toNum(t?.px, toNum(t?.price, NaN));
    if (!Number.isFinite(ts) || !Number.isFinite(px) || px <= 0) continue;
    out.push({ ts, px });
  }
  return out;
}

function normalizeSide(rawSide) {
  const s = String(rawSide ?? '').trim().toUpperCase();
  if (s === 'B' || s === 'BUY' || s === 'LONG') return 'buy';
  if (s === 'A' || s === 'S' || s === 'SELL' || s === 'ASK' || s === 'SHORT') return 'sell';
  return 'unknown';
}

function extractLiquidations(row) {
  const out = [];
  const payload = row?.data?.data;
  const arr = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' ? [payload] : []);
  for (const x of arr) {
    const ts = toNum(x?.time, toNum(x?.ts, toNum(row?.ts, NaN)));
    if (!Number.isFinite(ts)) continue;
    const px = toNum(x?.px, toNum(x?.price, NaN));
    const sz = toNum(x?.sz, toNum(x?.size, NaN));
    const usdDirect = toNum(x?.usd, toNum(x?.notional, toNum(x?.notionalUsd, toNum(x?.value, NaN))));
    const usd = Number.isFinite(usdDirect) ? usdDirect : (Number.isFinite(px) && Number.isFinite(sz) ? px * sz : NaN);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    out.push({ ts, usd, side: normalizeSide(x?.side ?? x?.dir ?? x?.direction) });
  }
  return out;
}

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].sec < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function priceAtOrBefore(priceSecs, sec) {
  const pos = lowerBound(priceSecs, sec + 1) - 1;
  if (pos < 0 || pos >= priceSecs.length) return null;
  return priceSecs[pos].px;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return `${[keys.join(',')].concat(rows.map((r) => keys.map((k) => esc(r[k])).join(','))).join('\n')}\n`;
}

async function processRaw(rawPath, priceBySec, liqBySec) {
  const rl = readline.createInterface({
    input: fs.createReadStream(rawPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ch = String(row?.channel ?? '').toLowerCase();
    if (ch === 'trades') {
      const trades = extractTrades(row);
      for (const t of trades) priceBySec.set(Math.floor(t.ts / 1000), t.px);
      continue;
    }
    if (ch === 'liquidations' || ch === 'liquidation') {
      const liqs = extractLiquidations(row);
      for (const x of liqs) {
        const sec = Math.floor(x.ts / 1000);
        const cur = liqBySec.get(sec) || { buyUsd: 0, sellUsd: 0, count: 0 };
        if (x.side === 'buy') cur.buyUsd += x.usd;
        else if (x.side === 'sell') cur.sellUsd += x.usd;
        cur.count += 1;
        liqBySec.set(sec, cur);
      }
    }
  }
}

function buildEvents(priceSecs, liqBySec, cfg) {
  const liqSecs = [...liqBySec.keys()].sort((a, b) => a - b);
  if (liqSecs.length === 0) return [];
  const minSec = liqSecs[0];
  const maxSec = liqSecs[liqSecs.length - 1];
  const queue = [];
  let sumBuy = 0;
  let sumSell = 0;
  let sumCnt = 0;
  let lastEventSec = -Infinity;
  let prevAbove = false;
  const events = [];

  for (let sec = minSec; sec <= maxSec; sec += 1) {
    const cur = liqBySec.get(sec) || { buyUsd: 0, sellUsd: 0, count: 0 };
    queue.push({ sec, buyUsd: cur.buyUsd, sellUsd: cur.sellUsd, count: cur.count });
    sumBuy += cur.buyUsd;
    sumSell += cur.sellUsd;
    sumCnt += cur.count;
    while (queue.length > 0 && queue[0].sec < sec - cfg.windowSec + 1) {
      const old = queue.shift();
      sumBuy -= old.buyUsd;
      sumSell -= old.sellUsd;
      sumCnt -= old.count;
    }

    const total = sumBuy + sumSell;
    const above = total >= cfg.burstUsd;
    const crossed = above && !prevAbove;
    prevAbove = above;
    if (!crossed) continue;
    if (sec - lastEventSec < cfg.cooldownSec) continue;

    const p0 = priceAtOrBefore(priceSecs, sec);
    if (!Number.isFinite(p0) || p0 <= 0) continue;
    const imbalance = total > 0 ? ((sumBuy - sumSell) / total) : 0;
    const side = imbalance >= 0 ? 'buy' : 'sell';
    const row = {
      eventId: `liq_${sec}`,
      tsSec: sec,
      tsIso: new Date(sec * 1000).toISOString(),
      windowSec: cfg.windowSec,
      liqUsd_10s: round(total, 3),
      liqCount_10s: sumCnt,
      liqBuyUsd_10s: round(sumBuy, 3),
      liqSellUsd_10s: round(sumSell, 3),
      liqImbalance_10s: round(imbalance, 6),
      burstSide: side,
      price_before: round(priceAtOrBefore(priceSecs, sec - cfg.windowSec), 6),
      price_t0: round(p0, 6),
    };
    for (const h of cfg.horizonsSec) {
      const ph = priceAtOrBefore(priceSecs, sec + h);
      const ret = Number.isFinite(ph) ? ((ph - p0) / p0) * 10000 : NaN;
      row[`price_after_${h}s`] = Number.isFinite(ph) ? round(ph, 6) : null;
      row[`ret_${h}s_bps`] = Number.isFinite(ret) ? round(ret, 6) : null;
    }
    events.push(row);
    lastEventSec = sec;
  }
  return events;
}

function buildSummary(events, cfg, rawFiles) {
  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    rawFiles,
    params: {
      windowSec: cfg.windowSec,
      burstUsd: cfg.burstUsd,
      horizonsSec: cfg.horizonsSec,
      cooldownSec: cfg.cooldownSec,
    },
    nEvents: events.length,
    bySide: {},
    horizons: {},
  };
  const sides = ['buy', 'sell'];
  for (const s of sides) {
    const xs = events.filter((e) => e.burstSide === s);
    out.bySide[s] = { n: xs.length };
    for (const h of cfg.horizonsSec) {
      const rs = xs.map((e) => toNum(e[`ret_${h}s_bps`], NaN)).filter(Number.isFinite);
      out.bySide[s][`meanRet_${h}s_bps`] = round(mean(rs), 6);
    }
  }
  for (const h of cfg.horizonsSec) {
    const rs = events.map((e) => toNum(e[`ret_${h}s_bps`], NaN)).filter(Number.isFinite);
    out.horizons[`${h}s`] = {
      n: rs.length,
      meanRetBps: round(mean(rs), 6),
      positiveRatio: rs.length > 0 ? round(rs.filter((x) => x > 0).length / rs.length, 6) : null,
    };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const raws = pickRawTargets(args).filter((p) => fs.existsSync(p));
  if (raws.length === 0) {
    throw new Error('no raw files found');
  }

  const priceBySec = new Map();
  const liqBySec = new Map();
  for (const raw of raws) {
    await processRaw(raw, priceBySec, liqBySec);
  }

  const priceSecs = [...priceBySec.entries()]
    .map(([sec, px]) => ({ sec, px }))
    .sort((a, b) => a.sec - b.sec);
  const events = buildEvents(priceSecs, liqBySec, args);
  const summary = buildSummary(events, args, raws);

  const outDirAbs = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDirAbs, { recursive: true });
  fs.writeFileSync(path.join(outDirAbs, 'liq_events.csv'), toCsv(events), 'utf8');
  fs.writeFileSync(path.join(outDirAbs, 'liq_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: outDirAbs,
    nEvents: events.length,
    rawFiles: raws,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[ws_liq_monitor] ${err?.message || err}`);
  process.exit(1);
});
