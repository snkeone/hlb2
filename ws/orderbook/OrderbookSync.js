import axios from 'axios';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRawLevels(rawData) {
  const levels = rawData?.data?.levels;
  if (!Array.isArray(levels) || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) return null;
  const bids = levels[0]
    .map((lv) => ({ px: toNum(lv?.px), sz: toNum(lv?.sz) }))
    .filter((lv) => Number.isFinite(lv.px) && Number.isFinite(lv.sz) && lv.sz > 0);
  const asks = levels[1]
    .map((lv) => ({ px: toNum(lv?.px), sz: toNum(lv?.sz) }))
    .filter((lv) => Number.isFinite(lv.px) && Number.isFinite(lv.sz) && lv.sz > 0);
  if (bids.length === 0 || asks.length === 0) return null;
  return { bids, asks };
}

function topN(levels, n) {
  return levels.slice(0, Math.max(1, n));
}

function calcTopVolumeUsd(levels) {
  return levels.reduce((sum, lv) => sum + (lv.px * lv.sz), 0);
}

function calcTopDeltaRatio(localLevels, restLevels) {
  const localUsd = calcTopVolumeUsd(localLevels);
  const restUsd = calcTopVolumeUsd(restLevels);
  if (restUsd <= 0 || !Number.isFinite(restUsd)) return 0;
  return Math.abs(localUsd - restUsd) / restUsd;
}

function cloneBook(book) {
  return {
    bids: book.bids.map((x) => ({ px: x.px, sz: x.sz })),
    asks: book.asks.map((x) => ({ px: x.px, sz: x.sz })),
    ts: book.ts
  };
}

export function createOrderbookSync({
  coin = 'BTC',
  restUrl = 'https://api.hyperliquid.xyz/info',
  restIntervalMs = 60000,
  driftThresholdRatio = 0.01,
  compareTopLevels = 5,
  logger = () => {},
  onResynced = null
} = {}) {
  const state = {
    localBook: null,
    restBook: null,
    timer: null,
    inFlight: false,
    lastSyncTs: 0,
    driftCount: 0,
    resyncCount: 0,
    lastDrift: null
  };

  function setResyncState(active, reason = null) {
    globalThis.__oobResyncState = {
      active: active === true,
      reason: reason || null,
      ts: Date.now()
    };
    log({
      channel: 'orderbook_sync',
      type: active ? 'OOB_RESYNC_START' : 'OOB_RESYNC_END',
      reason: reason || null
    });
  }

  function log(event) {
    try {
      logger({ ts: Date.now(), ...event });
    } catch (_) {}
  }

  async function fetchRestBook() {
    const payload = { type: 'l2Book', coin };
    const res = await axios.post(restUrl, payload, { timeout: 5000 });
    const levels = parseRawLevels({ data: res?.data });
    if (!levels) return null;
    return { ...levels, ts: Date.now() };
  }

  function replaceLocalBook(book, reason = 'resync') {
    if (!book) return;
    state.localBook = cloneBook(book);
    log({ channel: 'orderbook_sync', type: 'local_replaced', reason });
  }

  function calcDrift(localBook, restBook) {
    if (!localBook || !restBook) return null;
    const n = Math.max(1, compareTopLevels);
    const bidDelta = calcTopDeltaRatio(topN(localBook.bids, n), topN(restBook.bids, n));
    const askDelta = calcTopDeltaRatio(topN(localBook.asks, n), topN(restBook.asks, n));
    return { bidDelta, askDelta, maxDelta: Math.max(bidDelta, askDelta) };
  }

  async function resync(reason = 'manual') {
    if (state.inFlight) return false;
    state.inFlight = true;
    setResyncState(true, reason);
    let snapshotForCallback = null;
    try {
      const restBook = await fetchRestBook();
      if (!restBook) {
        log({ channel: 'orderbook_sync', type: 'resync_failed', reason, detail: 'empty_rest_snapshot' });
        return false;
      }
      state.restBook = restBook;
      replaceLocalBook(restBook, reason);
      state.lastSyncTs = Date.now();
      state.resyncCount += 1;
      snapshotForCallback = cloneBook(restBook);
      log({ channel: 'orderbook_sync', type: 'resynced', reason, resyncCount: state.resyncCount });
      return true;
    } catch (err) {
      log({ channel: 'orderbook_sync', type: 'resync_failed', reason, detail: err?.message || String(err) });
      return false;
    } finally {
      setResyncState(false, reason);
      state.inFlight = false;
      if (snapshotForCallback && typeof onResynced === 'function') {
        try {
          onResynced({ coin, reason, snapshot: snapshotForCallback });
        } catch (err) {
          log({ channel: 'orderbook_sync', type: 'resync_callback_failed', reason, detail: err?.message || String(err) });
        }
      }
    }
  }

  function onWsOrderbook(rawData, ts = Date.now()) {
    const parsed = parseRawLevels(rawData);
    if (!parsed) return;
    state.localBook = { ...parsed, ts };
    if (!state.restBook) return;
    const drift = calcDrift(state.localBook, state.restBook);
    if (!drift) return;
    if (drift.maxDelta >= driftThresholdRatio) {
      state.driftCount += 1;
      state.lastDrift = { ...drift, ts };
      log({
        channel: 'orderbook_sync',
        type: 'drift_detected',
        driftCount: state.driftCount,
        bidDelta: drift.bidDelta,
        askDelta: drift.askDelta,
        maxDelta: drift.maxDelta
      });
      // Immediate resync on drift detection
      void resync('drift_detected');
    }
  }

  function start() {
    if (state.timer) return;
    void resync('startup');
    state.timer = setInterval(() => {
      void resync('periodic_60s');
    }, Math.max(1000, restIntervalMs));
    log({ channel: 'orderbook_sync', type: 'started', restIntervalMs, driftThresholdRatio, compareTopLevels });
  }

  function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    log({ channel: 'orderbook_sync', type: 'stopped' });
  }

  function getState() {
    return {
      hasLocalBook: !!state.localBook,
      hasRestBook: !!state.restBook,
      lastSyncTs: state.lastSyncTs,
      driftCount: state.driftCount,
      resyncCount: state.resyncCount,
      lastDrift: state.lastDrift
    };
  }

  return {
    start,
    stop,
    resync,
    onWsOrderbook,
    getState
  };
}
