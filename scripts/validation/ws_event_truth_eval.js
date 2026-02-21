#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import minimist from 'minimist';
import { Worker } from 'worker_threads';

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
  if (!Array.isArray(levels) || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) return null;
  return { bids: levels[0], asks: levels[1] };
}

function levelToUsd(level) {
  const px = toNum(level?.px ?? level?.[0]);
  const sz = toNum(level?.sz ?? level?.[1]);
  if (!Number.isFinite(px) || !Number.isFinite(sz) || px <= 0 || sz <= 0) return null;
  return { px, sz, usd: px * sz };
}

function calcSidePressure(levels, mid, side, maxDistanceUsd) {
  let total = 0;
  let near = 0;
  let strongestUsd = 0;
  let strongestDist = null;
  let strongestPx = null;
  for (const lv of levels) {
    const p = levelToUsd(lv);
    if (!p) continue;
    const dist = side === 'bid' ? (mid - p.px) : (p.px - mid);
    if (!Number.isFinite(dist) || dist < 0 || dist > maxDistanceUsd) continue;
    total += p.usd;
    if (dist <= 10) near += p.usd;
    if (p.usd > strongestUsd) {
      strongestUsd = p.usd;
      strongestDist = dist;
      strongestPx = p.px;
    }
  }
  return { total, near, strongestUsd, strongestDist, strongestPx };
}

function updateWalls(levels, ts, minWallUsd, map) {
  const currentPx = new Set();
  for (const lv of levels) {
    const p = levelToUsd(lv);
    if (!p) continue;
    currentPx.add(p.px);

    let w = map.get(p.px);
    if (!w && p.usd >= minWallUsd) {
      w = { appearTs: ts, maxUsd: p.usd, halfLifeMs: null };
      map.set(p.px, w);
    } else if (w) {
      if (p.usd > w.maxUsd) w.maxUsd = p.usd;
      if (w.halfLifeMs === null && p.usd <= w.maxUsd * 0.5) {
        w.halfLifeMs = ts - w.appearTs;
      }
    }
  }

  for (const [px, w] of map.entries()) {
    if (!currentPx.has(px)) {
      if (w.halfLifeMs === null) {
        w.halfLifeMs = ts - w.appearTs;
      }
      if (ts - w.appearTs > 300000) {
        map.delete(px);
      }
    }
  }
}

function getWallHalfLife(px, ts, map) {
  if (!px) return 0;
  const w = map.get(px);
  if (!w) return 0;
  return w.halfLifeMs !== null ? w.halfLifeMs : (ts - w.appearTs);
}

function binarySearchFirstTs(arr, ts) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts >= ts) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function forwardLabel(midSeries, idx, horizonMs, side) {
  const entry = midSeries[idx];
  const targetTs = entry.ts + horizonMs;
  const j = binarySearchFirstTs(midSeries, targetTs);
  if (j >= midSeries.length) return null;
  const future = midSeries[j];
  const rawMove = future.mid - entry.mid;
  const move = side === 'SHORT' ? -rawMove : rawMove;
  return { rawMove, move, futureTs: future.ts };
}

function calcMfeMae(midSeries, idx, horizonMs, side) {
  const entry = midSeries[idx];
  const endTs = entry.ts + horizonMs;
  const endIdx = binarySearchFirstTs(midSeries, endTs);
  if (endIdx >= midSeries.length) return null;

  let best = -Infinity;
  let worst = Infinity;
  for (let i = idx; i <= endIdx; i += 1) {
    const v = midSeries[i].mid;
    if (v > best) best = v;
    if (v < worst) worst = v;
  }
  if (side === 'SHORT') {
    return {
      mfe: entry.mid - worst,
      mae: best - entry.mid
    };
  }
  return {
    mfe: best - entry.mid,
    mae: entry.mid - worst
  };
}

function netUsdFromMove(moveUsd, entryMid, notionalUsd, takerBps) {
  if (!Number.isFinite(moveUsd) || !Number.isFinite(entryMid) || entryMid <= 0) return null;
  const qty = notionalUsd / entryMid;
  const gross = moveUsd * qty;
  const fee = notionalUsd * (2 * takerBps / 10000);
  return gross - fee;
}

function calcDynamicSlipBps(spreadBps, pressureImb, burstUsd1s) {
  const s = Number.isFinite(spreadBps) ? spreadBps : 0;
  const imbAbs = Number.isFinite(pressureImb) ? Math.abs(pressureImb) : 0;
  const burst = Number.isFinite(burstUsd1s) ? burstUsd1s : 0;
  // slip_bps = 1.5 + (1.0 * spread_bps) + (0.5 * |pressureImb|) + (0.1 * (burst_usd_1s / 100000))
  return 1.5 + (1.0 * s) + (0.5 * imbAbs) + (0.1 * (burst / 100000));
}

function applyDynamicSlipToMove(moveUsd, entryMid, dynSlipBps) {
  if (!Number.isFinite(moveUsd) || !Number.isFinite(entryMid) || entryMid <= 0 || !Number.isFinite(dynSlipBps)) return null;
  const slipMoveUsd = entryMid * (dynSlipBps / 10000);
  return moveUsd - slipMoveUsd;
}

function classify3(net, feeRoundtripUsd) {
  if (!Number.isFinite(net)) return 'unknown';
  if (net >= feeRoundtripUsd * 1.5) return 'up';
  if (net <= -feeRoundtripUsd) return 'down';
  return 'flat';
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function secBucket(ts) {
  return Math.floor(ts / 1000) * 1000;
}

function rangeSumFromPrefix(prefix, leftIdx, rightIdxExclusive) {
  if (rightIdxExclusive <= leftIdx) return 0;
  return prefix[rightIdxExclusive] - prefix[leftIdx];
}

function lowerBoundTs(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sumBurstUsd1sAt(trades, tradeCumUsd, eventTs) {
  const l = lowerBoundTs(trades, eventTs - 1000);
  const r = lowerBoundTs(trades, eventTs + 1);
  return rangeSumFromPrefix(tradeCumUsd, l, r);
}

function checkMakerFill({ midSeries, trades, entryTs, entryMid, side }) {
  if (!Number.isFinite(entryTs) || !Number.isFinite(entryMid) || entryMid <= 0) {
    return { makerFilled: 0, makerPrice: null, penetrationDepthUsd: null, penetrated: 0, held: 0, fillUsd: 0 };
  }

  const holdWindowMs = 1000;
  const tradeWindowMs = 5000;
  const minFillUsd = 20000;
  const penetrationTicksUsd = 0.2;
  const penetrationBpsDepthUsd = entryMid * (0.5 / 10000); // 0.5 bps
  const penetrationDepthUsd = Math.max(penetrationTicksUsd, penetrationBpsDepthUsd);
  const makerPrice = side === 'SHORT'
    ? entryMid + penetrationDepthUsd
    : entryMid - penetrationDepthUsd;

  const midStart = lowerBoundTs(midSeries, entryTs);
  const midEnd = lowerBoundTs(midSeries, entryTs + holdWindowMs + 1);
  if (midStart >= midSeries.length || midEnd <= midStart) {
    return { makerFilled: 0, makerPrice, penetrationDepthUsd, penetrated: 0, held: 0, fillUsd: 0 };
  }

  let firstPenetration = -1;
  for (let i = midStart; i < midEnd; i += 1) {
    const m = midSeries[i].mid;
    const ok = side === 'SHORT' ? (m >= makerPrice) : (m <= makerPrice);
    if (ok) {
      firstPenetration = i;
      break;
    }
  }
  if (firstPenetration < 0) {
    return { makerFilled: 0, makerPrice, penetrationDepthUsd, penetrated: 0, held: 0, fillUsd: 0 };
  }

  // Condition 2: stay in penetrated zone until hold window end.
  let held = 1;
  for (let i = firstPenetration; i < midEnd; i += 1) {
    const m = midSeries[i].mid;
    const stay = side === 'SHORT' ? (m >= makerPrice) : (m <= makerPrice);
    if (!stay) {
      held = 0;
      break;
    }
  }
  if (!held) {
    return { makerFilled: 0, makerPrice, penetrationDepthUsd, penetrated: 1, held: 0, fillUsd: 0 };
  }

  // Condition 3: traded volume at entry price or better within 5s.
  const tradeStart = lowerBoundTs(trades, entryTs);
  const tradeEnd = lowerBoundTs(trades, entryTs + tradeWindowMs + 1);
  let fillUsd = 0;
  for (let i = tradeStart; i < tradeEnd; i += 1) {
    const tr = trades[i];
    const favorablePx = side === 'SHORT' ? (tr.px >= entryMid) : (tr.px <= entryMid);
    if (favorablePx) fillUsd += tr.usd;
  }

  const makerFilled = fillUsd >= minFillUsd ? 1 : 0;
  return { makerFilled, makerPrice, penetrationDepthUsd, penetrated: 1, held: 1, fillUsd };
}

function toCsvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeCsv(filePath, headers, rows) {
  const out = [headers.join(',')];
  for (const row of rows) {
    out.push(headers.map((h) => toCsvCell(row[h])).join(','));
  }
  fs.writeFileSync(filePath, `${out.join('\n')}\n`, 'utf8');
}

function computePessimisticBatchSync({ jobs, midSeries, trades, tradeCumUsd, notionalUsd, takerBps }) {
  return jobs.map((j) => {
    const burstUsd1s = sumBurstUsd1sAt(trades, tradeCumUsd, j.entryTs);
    const dynSlipBps = calcDynamicSlipBps(j.spreadBps, j.pressureImb, burstUsd1s);
    const move30Pes = applyDynamicSlipToMove(j.move30, j.entryMid, dynSlipBps);
    const net30Pes = netUsdFromMove(move30Pes, j.entryMid, notionalUsd, takerBps);
    const maker = checkMakerFill({
      midSeries,
      trades,
      entryTs: j.entryTs,
      entryMid: j.entryMid,
      side: j.side
    });
    return {
      index: j.index,
      burstUsd1s,
      dynSlipBps,
      net30Pes,
      makerFilled: maker.makerFilled
    };
  });
}

async function runWorkerPessimisticBatch({
  jobs,
  midSeries,
  trades,
  tradeCumUsd,
  notionalUsd,
  takerBps
}) {
  const workerPath = new URL('./eval_feature_worker.js', import.meta.url);
  const worker = new Worker(workerPath, {
    workerData: { midSeries, trades, tradeCumUsd, notionalUsd, takerBps }
  });
  try {
    return await new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg?.type === 'ok') resolve(msg.results || []);
        else reject(new Error(msg?.error || 'worker_failed'));
      };
      worker.once('message', onMessage);
      worker.once('error', reject);
      worker.postMessage({ type: 'compute', jobs });
    });
  } finally {
    await worker.terminate();
  }
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['input', 'out-dir'],
    default: {
      input: '/home/hlws/hlws-bot/logs/raw-20260221.jsonl.gz',
      'out-dir': '/home/hlws/hlb2/data/validation/run-latest',
      'max-lines': 0,
      'sample-ms': 250,
      'max-distance-usd': 200,
      'wall-appear-usd': 250000,
      'wall-disappear-drop-ratio': 0.6,
      'min-wall-usd': 150000,
      'imb-jump-threshold': 0.2,
      'burst-usd-1s': 120000,
      'spread-jump-bps': 0.25,
      'cluster-ms': 1000,
      'notional-usd': 1000,
      'taker-bps': 4.5,
      'eval-worker': 0,
      seed: 42
    }
  });

  const inputPath = path.resolve(String(argv.input));
  const outDir = path.resolve(String(argv['out-dir']));
  const maxLines = Number(argv['max-lines']);
  const sampleMs = Number(argv['sample-ms']);
  const maxDistanceUsd = Number(argv['max-distance-usd']);
  const wallAppearUsd = Number(argv['wall-appear-usd']);
  const wallDisappearDropRatio = Number(argv['wall-disappear-drop-ratio']);
  const minWallUsd = Number(argv['min-wall-usd']);
  const imbJumpThreshold = Number(argv['imb-jump-threshold']);
  const burstUsd1s = Number(argv['burst-usd-1s']);
  const spreadJumpBps = Number(argv['spread-jump-bps']);
  const clusterMs = Number(argv['cluster-ms']);
  const notionalUsd = Number(argv['notional-usd']);
  const takerBps = Number(argv['taker-bps']);
  const evalWorker = Number(argv['eval-worker']) === 1;
  const seed = Number(argv.seed);

  ensureDir(outDir);

  const rl = openLineReader(inputPath);
  const midSeries = [];
  const trades = [];
  const tradeSec = new Map();
  const rawEvents = [];
  const bidWallMap = new Map();
  const askWallMap = new Map();

  let lineCount = 0;
  let malformed = 0;
  let orderbookEvents = 0;
  let tradeEvents = 0;
  let lastSampleTs = 0;
  let prevFrame = null;

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
        const ts = toNum(tr?.time ?? obj.ts);
        const px = toNum(tr?.px);
        const sz = toNum(tr?.sz);
        const side = tr?.side;
        if (!Number.isFinite(ts) || !Number.isFinite(px) || !Number.isFinite(sz) || (side !== 'B' && side !== 'A')) continue;
        const usd = px * sz;
        trades.push({ ts, side, usd, px });
        const b = secBucket(ts);
        const t = tradeSec.get(b) || { buyUsd: 0, sellUsd: 0, volume: 0 };
        if (side === 'B') t.buyUsd += usd;
        else t.sellUsd += usd;
        t.volume += sz;
        tradeSec.set(b, t);
      }
      continue;
    }

    if (!(obj.channel === 'orderbook' && obj?.data?.channel === 'l2Book')) continue;
    orderbookEvents += 1;

    const ts = toNum(obj?.data?.data?.time ?? obj.ts);
    if (!Number.isFinite(ts)) continue;
    if ((ts - lastSampleTs) < sampleMs) continue;
    lastSampleTs = ts;

    const parsed = parseLevels(obj);
    if (!parsed) continue;
    const bestBid = levelToUsd(parsed.bids[0]);
    const bestAsk = levelToUsd(parsed.asks[0]);
    if (!bestBid || !bestAsk || bestBid.px >= bestAsk.px) continue;

    const mid = (bestBid.px + bestAsk.px) / 2;
    const spreadBps = ((bestAsk.px - bestBid.px) / mid) * 10000;

    const bid = calcSidePressure(parsed.bids, mid, 'bid', maxDistanceUsd);
    const ask = calcSidePressure(parsed.asks, mid, 'ask', maxDistanceUsd);
    const total = bid.total + ask.total;
    const imb = total > 0 ? (bid.total - ask.total) / total : 0;

    updateWalls(parsed.bids, ts, minWallUsd, bidWallMap);
    updateWalls(parsed.asks, ts, minWallUsd, askWallMap);

    midSeries.push({ ts, mid, spreadBps, bidNearUsd: bid.near, askNearUsd: ask.near });

    const oneSecFrom = ts - 1000;
    let buy1s = 0;
    let sell1s = 0;
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      if (trades[i].ts < oneSecFrom) break;
      if (trades[i].side === 'B') buy1s += trades[i].usd;
      else sell1s += trades[i].usd;
    }
    const burstTotal = buy1s + sell1s;
    const burstImb = burstTotal > 0 ? (buy1s - sell1s) / burstTotal : 0;

    if (prevFrame) {
      const imbJump = imb - prevFrame.imb;
      if (Math.abs(imbJump) >= imbJumpThreshold) {
        rawEvents.push({
          ts,
          type: 'imbalance_jump',
          side: imb > 0 ? 'LONG' : 'SHORT',
          score: Math.abs(imbJump),
          mid,
          spreadBps,
          pressureImb: imb,
          extra: { imbJump }
        });
      }

      const bidWallAppear = bid.strongestUsd >= wallAppearUsd && bid.strongestUsd > prevFrame.bidStrongestUsd;
      if (bidWallAppear) {
        rawEvents.push({ ts, type: 'wall_appear', side: 'LONG', score: bid.strongestUsd, mid, spreadBps, pressureImb: imb, extra: { wallUsd: bid.strongestUsd, dist: bid.strongestDist, halfLifeMs: getWallHalfLife(bid.strongestPx, ts, bidWallMap) } });
      }
      const askWallAppear = ask.strongestUsd >= wallAppearUsd && ask.strongestUsd > prevFrame.askStrongestUsd;
      if (askWallAppear) {
        rawEvents.push({ ts, type: 'wall_appear', side: 'SHORT', score: ask.strongestUsd, mid, spreadBps, pressureImb: imb, extra: { wallUsd: ask.strongestUsd, dist: ask.strongestDist, halfLifeMs: getWallHalfLife(ask.strongestPx, ts, askWallMap) } });
      }

      if (prevFrame.bidStrongestUsd > 0) {
        const drop = (prevFrame.bidStrongestUsd - bid.strongestUsd) / prevFrame.bidStrongestUsd;
        if (drop >= wallDisappearDropRatio) {
          rawEvents.push({ ts, type: 'wall_disappear', side: 'SHORT', score: drop, mid, spreadBps, pressureImb: imb, extra: { drop, halfLifeMs: getWallHalfLife(prevFrame.bidStrongestPx, ts, bidWallMap) } });
        }
      }
      if (prevFrame.askStrongestUsd > 0) {
        const drop = (prevFrame.askStrongestUsd - ask.strongestUsd) / prevFrame.askStrongestUsd;
        if (drop >= wallDisappearDropRatio) {
          rawEvents.push({ ts, type: 'wall_disappear', side: 'LONG', score: drop, mid, spreadBps, pressureImb: imb, extra: { drop, halfLifeMs: getWallHalfLife(prevFrame.askStrongestPx, ts, askWallMap) } });
        }
      }

      const spreadJump = spreadBps - prevFrame.spreadBps;
      if (spreadJump >= spreadJumpBps) {
        const side = bid.near < ask.near ? 'SHORT' : 'LONG';
        rawEvents.push({ ts, type: 'spread_jump', side, score: spreadJump, mid, spreadBps, pressureImb: imb, extra: { spreadJump } });
      }
    }

    if (burstTotal >= burstUsd1s) {
      rawEvents.push({
        ts,
        type: 'trade_burst',
        side: burstImb >= 0 ? 'LONG' : 'SHORT',
        score: burstTotal,
        mid,
        spreadBps,
        pressureImb: imb,
        extra: { burstTotal, burstImb }
      });
    }

    prevFrame = {
      ts,
      spreadBps,
      imb,
      bidStrongestUsd: bid.strongestUsd,
      askStrongestUsd: ask.strongestUsd,
      bidStrongestPx: bid.strongestPx,
      askStrongestPx: ask.strongestPx
    };
  }

  // Cluster events: within clusterMs, same type+side keep highest score
  rawEvents.sort((a, b) => a.ts - b.ts);
  const events = [];
  for (const e of rawEvents) {
    const last = events.length > 0 ? events[events.length - 1] : null;
    if (last && e.type === last.type && e.side === last.side && (e.ts - last.ts) <= clusterMs) {
      if (e.score > last.score) events[events.length - 1] = e;
    } else {
      events.push(e);
    }
  }

  // label real events
  const feeRoundtrip = notionalUsd * (2 * takerBps / 10000);
  trades.sort((a, b) => a.ts - b.ts);
  const tradeCumUsd = [0];
  for (let i = 0; i < trades.length; i += 1) {
    tradeCumUsd.push(tradeCumUsd[i] + trades[i].usd);
  }
  const labeled = [];
  const pessimisticJobs = [];
  for (const e of events) {
    const idx = binarySearchFirstTs(midSeries, e.ts);
    if (idx >= midSeries.length) continue;

    const l5 = forwardLabel(midSeries, idx, 5000, e.side);
    const l15 = forwardLabel(midSeries, idx, 15000, e.side);
    const l30 = forwardLabel(midSeries, idx, 30000, e.side);
    const l60 = forwardLabel(midSeries, idx, 60000, e.side);
    const mf = calcMfeMae(midSeries, idx, 60000, e.side);
    if (!l30 || !l60 || !mf) continue;

    const net30 = netUsdFromMove(l30.move, midSeries[idx].mid, notionalUsd, takerBps);
    const net60 = netUsdFromMove(l60.move, midSeries[idx].mid, notionalUsd, takerBps);
    const rowIndex = labeled.length;
    pessimisticJobs.push({
      index: rowIndex,
      entryTs: e.ts,
      entryMid: midSeries[idx].mid,
      side: e.side,
      spreadBps: e.spreadBps,
      pressureImb: e.pressureImb,
      move30: l30.move
    });

    labeled.push({
      cohort: 'real',
      type: e.type,
      side: e.side,
      ts: e.ts,
      mid: midSeries[idx].mid,
      spreadBps: e.spreadBps,
      pressureImb: e.pressureImb,
      score: e.score,
      halfLifeMs: e.extra?.halfLifeMs ?? null,
      move5: l5 ? l5.move : null,
      move15: l15 ? l15.move : null,
      move30: l30.move,
      move60: l60.move,
      mfe60: mf.mfe,
      mae60: mf.mae,
      hit3_30: l30.move >= 3 ? 1 : 0,
      hit5_60: l60.move >= 5 ? 1 : 0,
      burstUsd1s: null,
      dynSlipBps: null,
      net30,
      net30Pes: null,
      net60,
      makerFilled: null,
      cls30: classify3(net30, feeRoundtrip),
      cls60: classify3(net60, feeRoundtrip)
    });
  }

  const realPessimistic = evalWorker
    ? await runWorkerPessimisticBatch({ jobs: pessimisticJobs, midSeries, trades, tradeCumUsd, notionalUsd, takerBps })
    : computePessimisticBatchSync({ jobs: pessimisticJobs, midSeries, trades, tradeCumUsd, notionalUsd, takerBps });
  for (const m of realPessimistic) {
    const row = labeled[m.index];
    if (!row) continue;
    row.burstUsd1s = m.burstUsd1s;
    row.dynSlipBps = m.dynSlipBps;
    row.net30Pes = m.net30Pes;
    row.makerFilled = m.makerFilled;
  }

  // placebo events (same count)
  const rand = mulberry32(seed);
  const placeboCount = labeled.length;
  const placeboLabeled = [];
  const placeboJobs = [];
  let guard = 0;
  while (placeboLabeled.length < placeboCount && guard < placeboCount * 50 && midSeries.length > 0) {
    guard += 1;
    const idx = Math.floor(rand() * midSeries.length);
    const base = midSeries[idx];

    const side = rand() >= 0.5 ? 'LONG' : 'SHORT';
    const l30 = forwardLabel(midSeries, idx, 30000, side);
    const l60 = forwardLabel(midSeries, idx, 60000, side);
    const l5 = forwardLabel(midSeries, idx, 5000, side);
    const l15 = forwardLabel(midSeries, idx, 15000, side);
    const mf = calcMfeMae(midSeries, idx, 60000, side);
    if (!l30 || !l60 || !mf) continue;

    const net30 = netUsdFromMove(l30.move, base.mid, notionalUsd, takerBps);
    const net60 = netUsdFromMove(l60.move, base.mid, notionalUsd, takerBps);
    const rowIndex = placeboLabeled.length;
    placeboJobs.push({
      index: rowIndex,
      entryTs: base.ts,
      entryMid: base.mid,
      side,
      spreadBps: base.spreadBps,
      pressureImb: 0,
      move30: l30.move
    });

    placeboLabeled.push({
      cohort: 'placebo',
      type: 'placebo_random',
      side,
      ts: base.ts,
      mid: base.mid,
      spreadBps: base.spreadBps,
      pressureImb: 0,
      score: 0,
      halfLifeMs: null,
      move5: l5 ? l5.move : null,
      move15: l15 ? l15.move : null,
      move30: l30.move,
      move60: l60.move,
      mfe60: mf.mfe,
      mae60: mf.mae,
      hit3_30: l30.move >= 3 ? 1 : 0,
      hit5_60: l60.move >= 5 ? 1 : 0,
      burstUsd1s: null,
      dynSlipBps: null,
      net30,
      net30Pes: null,
      net60,
      makerFilled: null,
      cls30: classify3(net30, feeRoundtrip),
      cls60: classify3(net60, feeRoundtrip)
    });
  }

  const placeboPessimistic = evalWorker
    ? await runWorkerPessimisticBatch({ jobs: placeboJobs, midSeries, trades, tradeCumUsd, notionalUsd, takerBps })
    : computePessimisticBatchSync({ jobs: placeboJobs, midSeries, trades, tradeCumUsd, notionalUsd, takerBps });
  for (const m of placeboPessimistic) {
    const row = placeboLabeled[m.index];
    if (!row) continue;
    row.burstUsd1s = m.burstUsd1s;
    row.dynSlipBps = m.dynSlipBps;
    row.net30Pes = m.net30Pes;
    row.makerFilled = m.makerFilled;
  }

  const allLabeled = labeled.concat(placeboLabeled);

  // stats by cohort+type+side
  const agg = new Map();
  function accKey(r) { return `${r.cohort}|${r.type}|${r.side}`; }
  for (const r of allLabeled) {
    const k = accKey(r);
    const a = agg.get(k) || {
      cohort: r.cohort,
      type: r.type,
      side: r.side,
      count: 0,
      sumMove30: 0,
      sumMove60: 0,
      sumNet30: 0,
      sumNet30Pes: 0,
      sumNet60: 0,
      sumDynSlipBps: 0,
      makerFillCount: 0,
      hit3_30: 0,
      hit5_60: 0,
      sumMfe60: 0,
      sumMae60: 0,
      net30Pos: 0
    };
    a.count += 1;
    a.sumMove30 += r.move30;
    a.sumMove60 += r.move60;
    a.sumNet30 += r.net30;
    a.sumNet30Pes += r.net30Pes;
    a.sumNet60 += r.net60;
    a.sumDynSlipBps += r.dynSlipBps;
    a.makerFillCount += (r.makerFilled === 1 ? 1 : 0);
    a.hit3_30 += r.hit3_30;
    a.hit5_60 += r.hit5_60;
    a.sumMfe60 += r.mfe60;
    a.sumMae60 += r.mae60;
    if (r.net30 > 0) a.net30Pos += 1;
    agg.set(k, a);
  }

  const stats = [...agg.values()].map((a) => ({
    cohort: a.cohort,
    type: a.type,
    side: a.side,
    count: a.count,
    avg_move30: a.sumMove30 / a.count,
    avg_move60: a.sumMove60 / a.count,
    avg_dyn_slip_bps: a.sumDynSlipBps / a.count,
    avg_net30: a.sumNet30 / a.count,
    avg_net30_pes: a.sumNet30Pes / a.count,
    avg_net60: a.sumNet60 / a.count,
    maker_fill_count: a.makerFillCount,
    maker_fill_rate: a.makerFillCount / a.count,
    hit3_30_rate: a.hit3_30 / a.count,
    hit5_60_rate: a.hit5_60 / a.count,
    avg_mfe60: a.sumMfe60 / a.count,
    avg_mae60: a.sumMae60 / a.count,
    p_net30_pos: a.net30Pos / a.count
  })).sort((x, y) => y.count - x.count);

  // candles 1s from mid + trade volume
  const candleMap = new Map();
  for (const m of midSeries) {
    const b = secBucket(m.ts);
    const c = candleMap.get(b) || { ts: b, open: m.mid, high: m.mid, low: m.mid, close: m.mid, volume: 0, buyUsd: 0, sellUsd: 0 };
    if (m.mid > c.high) c.high = m.mid;
    if (m.mid < c.low) c.low = m.mid;
    c.close = m.mid;
    candleMap.set(b, c);
  }
  for (const [b, t] of tradeSec.entries()) {
    const c = candleMap.get(b) || { ts: b, open: null, high: null, low: null, close: null, volume: 0, buyUsd: 0, sellUsd: 0 };
    c.volume += t.volume;
    c.buyUsd += t.buyUsd;
    c.sellUsd += t.sellUsd;
    candleMap.set(b, c);
  }
  const candles = [...candleMap.values()].sort((a, b) => a.ts - b.ts);

  const eventsHeaders = [
    'cohort', 'type', 'side', 'ts', 'mid', 'spreadBps', 'pressureImb', 'score', 'halfLifeMs',
    'move5', 'move15', 'move30', 'move60', 'mfe60', 'mae60',
    'hit3_30', 'hit5_60', 'burstUsd1s', 'dynSlipBps', 'net30', 'net30Pes', 'net60', 'makerFilled', 'cls30', 'cls60'
  ];
  const statsHeaders = [
    'cohort', 'type', 'side', 'count', 'avg_move30', 'avg_move60', 'avg_dyn_slip_bps', 'avg_net30', 'avg_net30_pes', 'avg_net60', 'maker_fill_count', 'maker_fill_rate',
    'hit3_30_rate', 'hit5_60_rate', 'avg_mfe60', 'avg_mae60', 'p_net30_pos'
  ];
  const candleHeaders = ['ts', 'open', 'high', 'low', 'close', 'volume', 'buyUsd', 'sellUsd'];

  writeCsv(path.join(outDir, 'events_labeled.csv'), eventsHeaders, allLabeled);
  writeCsv(path.join(outDir, 'event_stats.csv'), statsHeaders, stats);
  writeCsv(path.join(outDir, 'candles_1s.csv'), candleHeaders, candles);

  const summary = {
    input: inputPath,
    outDir,
    params: {
      maxLines,
      sampleMs,
      maxDistanceUsd,
      wallAppearUsd,
      wallDisappearDropRatio,
      minWallUsd,
      imbJumpThreshold,
      burstUsd1s,
      spreadJumpBps,
      clusterMs,
      notionalUsd,
      takerBps,
      evalWorker,
      seed
    },
    counts: {
      lineCount,
      malformed,
      orderbookEvents,
      tradeEvents,
      midSamples: midSeries.length,
      rawEvents: rawEvents.length,
      clusteredEvents: events.length,
      labeledReal: labeled.length,
      labeledPlacebo: placeboLabeled.length,
      candles1s: candles.length
    }
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[ERR] ws_event_truth_eval failed', err);
  process.exit(1);
});
