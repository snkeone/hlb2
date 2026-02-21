#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import minimist from 'minimist';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function openLineReader(filePath) {
  const src = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? src.pipe(zlib.createGunzip()) : src;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function parseLevels(raw) {
  const levels = raw?.data?.data?.levels;
  if (!Array.isArray(levels) || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) {
    return null;
  }
  return { bids: levels[0], asks: levels[1] };
}

function levelToUsd(level) {
  const px = toNum(level?.px ?? level?.[0]);
  const sz = toNum(level?.sz ?? level?.[1]);
  if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || sz <= 0) return null;
  return { px, sz, usd: px * sz };
}

function calcPressure(levels, mid, side, maxDistanceUsd, buckets) {
  const bucketSums = new Array(buckets.length).fill(0);
  let total = 0;
  let strongestUsd = 0;
  let strongestDistUsd = null;

  for (const lv of levels) {
    const p = levelToUsd(lv);
    if (!p) continue;
    const dist = side === 'bid' ? (mid - p.px) : (p.px - mid);
    if (!Number.isFinite(dist) || dist < 0 || dist > maxDistanceUsd) continue;

    total += p.usd;
    if (p.usd > strongestUsd) {
      strongestUsd = p.usd;
      strongestDistUsd = dist;
    }

    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      if (dist >= b.min && dist < b.max) {
        bucketSums[i] += p.usd;
        break;
      }
    }
  }

  return { total, strongestUsd, strongestDistUsd, bucketSums };
}

function calcSlopeBpsPerSec(points) {
  const n = points.length;
  if (n < 3) return null;

  const t0 = points[0].ts / 1000;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const p of points) {
    const x = (p.ts / 1000) - t0;
    const y = p.mid;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denom = (n * sumXX) - (sumX * sumX);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return null;

  const slopeUsdPerSec = ((n * sumXY) - (sumX * sumY)) / denom;
  const ref = sumY / n;
  if (!Number.isFinite(ref) || ref <= 0) return null;

  return (slopeUsdPerSec / ref) * 10000;
}

function calcTradeBurst(tradesWindow, nowTs, windowMs) {
  const fromTs = nowTs - windowMs;
  let buyUsd = 0;
  let sellUsd = 0;
  let count = 0;
  for (let i = tradesWindow.length - 1; i >= 0; i -= 1) {
    const t = tradesWindow[i];
    if (t.ts < fromTs) break;
    count += 1;
    if (t.side === 'B') buyUsd += t.usd;
    else sellUsd += t.usd;
  }
  const total = buyUsd + sellUsd;
  const imbalance = total > 0 ? (buyUsd - sellUsd) / total : 0;
  return { count, buyUsd, sellUsd, totalUsd: total, imbalance };
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['input', 'out-dir'],
    default: {
      input: '/home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz',
      'out-dir': '/home/hlws/hlb2/data/ws-visual',
      'sample-ms': 250,
      'max-lines': 0,
      'max-distance-usd': 200,
      'min-move-usd': 20,
      'min-pressure-usd': 250000,
      'imb-threshold': 0.12,
      'trend-window': 120,
      'burst-window-ms': 3000
    }
  });

  const inputPath = path.resolve(String(argv.input));
  const outDir = path.resolve(String(argv['out-dir']));
  const sampleMs = Number(argv['sample-ms']);
  const maxLines = Number(argv['max-lines']);
  const maxDistanceUsd = Number(argv['max-distance-usd']);
  const minMoveUsd = Number(argv['min-move-usd']);
  const minPressureUsd = Number(argv['min-pressure-usd']);
  const imbThreshold = Number(argv['imb-threshold']);
  const trendWindow = Number(argv['trend-window']);
  const burstWindowMs = Number(argv['burst-window-ms']);

  if (!fs.existsSync(inputPath)) {
    console.error(`[ERR] input not found: ${inputPath}`);
    process.exit(1);
  }

  ensureDir(outDir);
  const csvPath = path.join(outDir, 'feature_timeseries.csv');
  const summaryPath = path.join(outDir, 'summary.json');

  const buckets = [
    { name: '0_10', min: 0, max: 10 },
    { name: '10_25', min: 10, max: 25 },
    { name: '25_50', min: 25, max: 50 },
    { name: '50_100', min: 50, max: 100 },
    { name: '100_200', min: 100, max: 200 }
  ];

  const header = [
    'ts', 'mid', 'spread_bps', 'trend_bps_per_sec', 'trend_angle_deg',
    'bid_pressure_total_usd', 'ask_pressure_total_usd', 'pressure_imbalance',
    'strongest_bid_usd', 'strongest_bid_dist_usd', 'strongest_ask_usd', 'strongest_ask_dist_usd',
    'bid_p_0_10', 'bid_p_10_25', 'bid_p_25_50', 'bid_p_50_100', 'bid_p_100_200',
    'ask_p_0_10', 'ask_p_10_25', 'ask_p_25_50', 'ask_p_50_100', 'ask_p_100_200',
    'burst_count_3s', 'burst_buy_usd_3s', 'burst_sell_usd_3s', 'burst_imbalance_3s',
    'target_ok_long', 'target_ok_short', 'pressure_ok_long', 'pressure_ok_short',
    'in_long_hint', 'in_short_hint'
  ];
  fs.writeFileSync(csvPath, `${header.join(',')}\n`, 'utf8');

  const rl = openLineReader(inputPath);

  const midWindow = [];
  const tradesWindow = [];

  let lineCount = 0;
  let sampled = 0;
  let orderbookEvents = 0;
  let tradeEvents = 0;
  let malformed = 0;
  let lastSampleTs = 0;

  let longHintCount = 0;
  let shortHintCount = 0;
  let sumSpreadBps = 0;
  let sumAbsImbalance = 0;

  for await (const line of rl) {
    lineCount += 1;
    if (maxLines > 0 && lineCount > maxLines) break;
    if (!line || line[0] !== '{') continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }

    if (obj.channel === 'trades' && obj?.data?.channel === 'trades' && Array.isArray(obj?.data?.data)) {
      tradeEvents += 1;
      for (const tr of obj.data.data) {
        const px = toNum(tr?.px);
        const sz = toNum(tr?.sz);
        const ts = toNum(tr?.time ?? obj.ts);
        const side = tr?.side;
        if (!Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(ts) || (side !== 'B' && side !== 'A')) continue;
        const usd = px * sz;
        tradesWindow.push({ ts, side, usd });
      }
      const keepFrom = (obj.ts || Date.now()) - (burstWindowMs * 3);
      while (tradesWindow.length > 0 && tradesWindow[0].ts < keepFrom) tradesWindow.shift();
      continue;
    }

    if (!(obj.channel === 'orderbook' && obj?.data?.channel === 'l2Book')) continue;
    orderbookEvents += 1;

    const levels = parseLevels(obj);
    if (!levels) continue;

    const bestBid = levelToUsd(levels.bids[0]);
    const bestAsk = levelToUsd(levels.asks[0]);
    if (!bestBid || !bestAsk || bestBid.px >= bestAsk.px) continue;

    const ts = toNum(obj?.data?.data?.time ?? obj.ts);
    if (!Number.isFinite(ts)) continue;
    if (sampleMs > 0 && (ts - lastSampleTs) < sampleMs) continue;
    lastSampleTs = ts;

    const mid = (bestBid.px + bestAsk.px) / 2;
    const spreadBps = ((bestAsk.px - bestBid.px) / mid) * 10000;

    midWindow.push({ ts, mid });
    while (midWindow.length > trendWindow) midWindow.shift();

    const trendBpsPerSec = calcSlopeBpsPerSec(midWindow);
    const trendAngleDeg = Number.isFinite(trendBpsPerSec)
      ? Math.atan(trendBpsPerSec) * (180 / Math.PI)
      : null;

    const bid = calcPressure(levels.bids, mid, 'bid', maxDistanceUsd, buckets);
    const ask = calcPressure(levels.asks, mid, 'ask', maxDistanceUsd, buckets);

    const totalPressure = bid.total + ask.total;
    const pressureImb = totalPressure > 0 ? (bid.total - ask.total) / totalPressure : 0;

    const burst = calcTradeBurst(tradesWindow, ts, burstWindowMs);

    const targetOkLong = Number.isFinite(ask.strongestDistUsd) && ask.strongestDistUsd >= minMoveUsd ? 1 : 0;
    const targetOkShort = Number.isFinite(bid.strongestDistUsd) && bid.strongestDistUsd >= minMoveUsd ? 1 : 0;
    const pressureOkLong = bid.total >= minPressureUsd && pressureImb >= imbThreshold ? 1 : 0;
    const pressureOkShort = ask.total >= minPressureUsd && pressureImb <= -imbThreshold ? 1 : 0;

    const trendLong = !Number.isFinite(trendBpsPerSec) || trendBpsPerSec >= 0;
    const trendShort = !Number.isFinite(trendBpsPerSec) || trendBpsPerSec <= 0;

    const inLongHint = (targetOkLong && pressureOkLong && trendLong) ? 1 : 0;
    const inShortHint = (targetOkShort && pressureOkShort && trendShort) ? 1 : 0;

    if (inLongHint) longHintCount += 1;
    if (inShortHint) shortHintCount += 1;

    sampled += 1;
    sumSpreadBps += spreadBps;
    sumAbsImbalance += Math.abs(pressureImb);

    const row = [
      ts, mid.toFixed(2), spreadBps.toFixed(4),
      Number.isFinite(trendBpsPerSec) ? trendBpsPerSec.toFixed(6) : '',
      Number.isFinite(trendAngleDeg) ? trendAngleDeg.toFixed(4) : '',
      bid.total.toFixed(2), ask.total.toFixed(2), pressureImb.toFixed(6),
      bid.strongestUsd.toFixed(2), Number.isFinite(bid.strongestDistUsd) ? bid.strongestDistUsd.toFixed(2) : '',
      ask.strongestUsd.toFixed(2), Number.isFinite(ask.strongestDistUsd) ? ask.strongestDistUsd.toFixed(2) : '',
      ...bid.bucketSums.map(v => v.toFixed(2)),
      ...ask.bucketSums.map(v => v.toFixed(2)),
      burst.count, burst.buyUsd.toFixed(2), burst.sellUsd.toFixed(2), burst.imbalance.toFixed(6),
      targetOkLong, targetOkShort, pressureOkLong, pressureOkShort,
      inLongHint, inShortHint
    ];

    fs.appendFileSync(csvPath, `${row.join(',')}\n`, 'utf8');
  }

  const summary = {
    input: inputPath,
    output: {
      csv: csvPath,
      summary: summaryPath
    },
    params: {
      sampleMs,
      maxLines,
      maxDistanceUsd,
      minMoveUsd,
      minPressureUsd,
      imbThreshold,
      trendWindow,
      burstWindowMs
    },
    counts: {
      linesRead: lineCount,
      orderbookEvents,
      tradeEvents,
      malformed,
      sampledRows: sampled,
      longHints: longHintCount,
      shortHints: shortHintCount
    },
    averages: {
      spreadBps: sampled > 0 ? sumSpreadBps / sampled : 0,
      absPressureImbalance: sampled > 0 ? sumAbsImbalance / sampled : 0
    }
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[ERR] ws_pressure_visualize failed', err);
  process.exit(1);
});
