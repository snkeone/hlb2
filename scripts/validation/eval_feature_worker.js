import { parentPort, workerData } from 'worker_threads';

const midSeries = Array.isArray(workerData?.midSeries) ? workerData.midSeries : [];
const trades = Array.isArray(workerData?.trades) ? workerData.trades : [];
const tradeCumUsd = Array.isArray(workerData?.tradeCumUsd) ? workerData.tradeCumUsd : [];
const notionalUsd = Number(workerData?.notionalUsd);
const takerBps = Number(workerData?.takerBps);

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

function rangeSumFromPrefix(prefix, leftIdx, rightIdxExclusive) {
  if (rightIdxExclusive <= leftIdx) return 0;
  return prefix[rightIdxExclusive] - prefix[leftIdx];
}

function sumBurstUsd1sAt(eventTs) {
  const l = lowerBoundTs(trades, eventTs - 1000);
  const r = lowerBoundTs(trades, eventTs + 1);
  return rangeSumFromPrefix(tradeCumUsd, l, r);
}

function calcDynamicSlipBps(spreadBps, pressureImb, burstUsd1s) {
  const s = Number.isFinite(spreadBps) ? spreadBps : 0;
  const imbAbs = Number.isFinite(pressureImb) ? Math.abs(pressureImb) : 0;
  const burst = Number.isFinite(burstUsd1s) ? burstUsd1s : 0;
  return 1.5 + (1.0 * s) + (0.5 * imbAbs) + (0.1 * (burst / 100000));
}

function applyDynamicSlipToMove(moveUsd, entryMid, dynSlipBps) {
  if (!Number.isFinite(moveUsd) || !Number.isFinite(entryMid) || entryMid <= 0 || !Number.isFinite(dynSlipBps)) return null;
  const slipMoveUsd = entryMid * (dynSlipBps / 10000);
  return moveUsd - slipMoveUsd;
}

function netUsdFromMove(moveUsd, entryMid) {
  if (!Number.isFinite(moveUsd) || !Number.isFinite(entryMid) || entryMid <= 0) return null;
  const qty = notionalUsd / entryMid;
  const gross = moveUsd * qty;
  const fee = notionalUsd * (2 * takerBps / 10000);
  return gross - fee;
}

function checkMakerFill(entryTs, entryMid, side) {
  if (!Number.isFinite(entryTs) || !Number.isFinite(entryMid) || entryMid <= 0) return 0;

  const holdWindowMs = 1000;
  const tradeWindowMs = 5000;
  const minFillUsd = 20000;
  const penetrationDepthUsd = Math.max(0.2, entryMid * (0.5 / 10000));
  const makerPrice = side === 'SHORT'
    ? entryMid + penetrationDepthUsd
    : entryMid - penetrationDepthUsd;

  const midStart = lowerBoundTs(midSeries, entryTs);
  const midEnd = lowerBoundTs(midSeries, entryTs + holdWindowMs + 1);
  if (midStart >= midSeries.length || midEnd <= midStart) return 0;

  let firstPenetration = -1;
  for (let i = midStart; i < midEnd; i += 1) {
    const m = midSeries[i].mid;
    const ok = side === 'SHORT' ? (m >= makerPrice) : (m <= makerPrice);
    if (ok) {
      firstPenetration = i;
      break;
    }
  }
  if (firstPenetration < 0) return 0;

  for (let i = firstPenetration; i < midEnd; i += 1) {
    const m = midSeries[i].mid;
    const stay = side === 'SHORT' ? (m >= makerPrice) : (m <= makerPrice);
    if (!stay) return 0;
  }

  const tradeStart = lowerBoundTs(trades, entryTs);
  const tradeEnd = lowerBoundTs(trades, entryTs + tradeWindowMs + 1);
  let fillUsd = 0;
  for (let i = tradeStart; i < tradeEnd; i += 1) {
    const tr = trades[i];
    const favorablePx = side === 'SHORT' ? (tr.px >= entryMid) : (tr.px <= entryMid);
    if (favorablePx) fillUsd += tr.usd;
  }
  return fillUsd >= minFillUsd ? 1 : 0;
}

function compute(jobs) {
  return jobs.map((j) => {
    const burstUsd1s = sumBurstUsd1sAt(j.entryTs);
    const dynSlipBps = calcDynamicSlipBps(j.spreadBps, j.pressureImb, burstUsd1s);
    const move30Pes = applyDynamicSlipToMove(j.move30, j.entryMid, dynSlipBps);
    const net30Pes = netUsdFromMove(move30Pes, j.entryMid);
    const makerFilled = checkMakerFill(j.entryTs, j.entryMid, j.side);
    return {
      index: j.index,
      burstUsd1s,
      dynSlipBps,
      net30Pes,
      makerFilled
    };
  });
}

parentPort.on('message', (msg) => {
  if (msg?.type !== 'compute' || !Array.isArray(msg?.jobs)) {
    parentPort.postMessage({ type: 'error', error: 'invalid_worker_message' });
    return;
  }
  try {
    const results = compute(msg.jobs);
    parentPort.postMessage({ type: 'ok', results });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err?.message || 'worker_compute_failed' });
  }
});

