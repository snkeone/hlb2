// ws/status/evaluator.js
// lastSeenからstate/severity/lastOkLayer/stoppedAt/since/hint/changesを判定
import { LAYERS, STATES, SEVERITIES, TIMEOUTS, DATA_STATES, STOP_REASONS } from './model.js';
import { getLastSeen } from './tracker.js';

function getNow() { return Date.now(); }

export function evaluateStatus() {
  const now = getNow();
  const lastSeen = getLastSeen();
  let state = STATES.BOOTING;
  let severity = SEVERITIES.INFO;
  let lastOkLayer = null;
  let stoppedAt = null;
  let since = null;
  let hint = 'OK';
  let changes = [];

  // WS
  if (lastSeen.WS && now - lastSeen.WS <= TIMEOUTS.WS.connected) {
    state = STATES.CONNECTED;
    lastOkLayer = 'WS';
    hint = 'WS RECEIVED';
  } else if (lastSeen.WS && now - lastSeen.WS <= TIMEOUTS.WS.dead) {
    state = STATES.BOOTING;
    lastOkLayer = null;
    hint = 'WS MISSING';
  } else {
    state = STATES.DEAD;
    severity = SEVERITIES.FATAL;
    lastOkLayer = null;
    stoppedAt = lastSeen.WS;
    since = lastSeen.WS ? now - lastSeen.WS : null;
    hint = 'WS MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  }

  // Normalize
  if (lastSeen.NORMALIZE && now - lastSeen.NORMALIZE <= TIMEOUTS.NORMALIZE.degraded) {
    state = STATES.ACTIVE;
    lastOkLayer = 'NORMALIZE';
    hint = 'NORMALIZE CALLED';
  } else if (lastSeen.NORMALIZE && now - lastSeen.NORMALIZE <= TIMEOUTS.NORMALIZE.dead) {
    state = STATES.DEGRADED;
    severity = SEVERITIES.WARN;
    lastOkLayer = 'WS';
    stoppedAt = lastSeen.NORMALIZE;
    since = now - lastSeen.NORMALIZE;
    hint = 'NORMALIZE MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  } else {
    state = STATES.DEAD;
    severity = SEVERITIES.FATAL;
    lastOkLayer = 'WS';
    stoppedAt = lastSeen.NORMALIZE;
    since = lastSeen.NORMALIZE ? now - lastSeen.NORMALIZE : null;
    hint = 'NORMALIZE MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  }

  // IO
  if (lastSeen.IO && now - lastSeen.IO <= TIMEOUTS.IO.degraded) {
    state = STATES.ACTIVE;
    lastOkLayer = 'IO';
    hint = 'IO DISPATCHED';
  } else if (lastSeen.IO && now - lastSeen.IO <= TIMEOUTS.IO.dead) {
    state = STATES.DEGRADED;
    severity = SEVERITIES.WARN;
    lastOkLayer = 'NORMALIZE';
    stoppedAt = lastSeen.IO;
    since = now - lastSeen.IO;
    hint = 'IO MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  } else {
    state = STATES.DEAD;
    severity = SEVERITIES.FATAL;
    lastOkLayer = 'NORMALIZE';
    stoppedAt = lastSeen.IO;
    since = lastSeen.IO ? now - lastSeen.IO : null;
    hint = 'IO MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  }

  // Logic
  if (lastSeen.LOGIC && now - lastSeen.LOGIC <= TIMEOUTS.LOGIC.degraded) {
    state = STATES.ACTIVE;
    lastOkLayer = 'LOGIC';
    hint = 'LOGIC CALLED';
  } else if (lastSeen.LOGIC && now - lastSeen.LOGIC <= TIMEOUTS.LOGIC.dead) {
    state = STATES.DEGRADED;
    severity = SEVERITIES.WARN;
    lastOkLayer = 'IO';
    stoppedAt = lastSeen.LOGIC;
    since = now - lastSeen.LOGIC;
    hint = 'LOGIC MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  } else {
    state = STATES.DEAD;
    severity = SEVERITIES.FATAL;
    lastOkLayer = 'IO';
    stoppedAt = lastSeen.LOGIC;
    since = lastSeen.LOGIC ? now - lastSeen.LOGIC : null;
    hint = 'LOGIC MISSING';
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  }

  // UI (optional): do not treat "no UI" as fatal unless UI has ever been seen
  if (lastSeen.UI) {
    state = STATES.ACTIVE;
    lastOkLayer = 'UI';
    hint = 'UI UPDATED';
  } else {
    return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
  }

  return { state, severity, lastOkLayer, stoppedAt, since, hint, changes };
}

export function evaluateDataState({ c, ioMetrics, now = getNow() } = {}) {
  const lastSeen = getLastSeen();
  
  // Priority 1: Check data freshness from decision_trace diagnostics
  const dataFreshness = ioMetrics?.dataFreshness;
  const freshnessHint = ioMetrics?.freshnessHint;
  const bar1hReady = ioMetrics?.bar1hState?.ready ?? false;
  
  if (dataFreshness === 'STALE') {
    return { 
      dataState: DATA_STATES.DATA_STALE, 
      stopReason: STOP_REASONS.DATA_STALE, 
      dataHint: freshnessHint ?? 'Data stale' 
    };
  }
  
  // Priority 2: Check WS/TRADES/ORDERBOOK timeouts
  if (!lastSeen.TRADES || now - lastSeen.TRADES > TIMEOUTS.TRADES.wait) {
    return { dataState: DATA_STATES.WAIT_TRADES, stopReason: STOP_REASONS.WAIT_TRADES, dataHint: 'Waiting trades' };
  }
  if (!lastSeen.ORDERBOOK || now - lastSeen.ORDERBOOK > TIMEOUTS.ORDERBOOK.wait) {
    return { dataState: DATA_STATES.WAIT_ORDERBOOK, stopReason: STOP_REASONS.WAIT_ORDERBOOK, dataHint: 'Waiting orderbook' };
  }
  if (c === null || c === undefined || !Number.isFinite(Number(c))) {
    return { dataState: DATA_STATES.OK, stopReason: STOP_REASONS.SKIP_NO_C, dataHint: 'No c' };
  }
  if (!lastSeen.WS || now - lastSeen.WS > TIMEOUTS.WS.connected) {
    return { dataState: DATA_STATES.WAIT_WS, stopReason: STOP_REASONS.WAIT_WS, dataHint: 'Waiting ws' };
  }
  
  // Return OK with warmup hint if bar1h not ready
  if (freshnessHint === 'WARMUP_BAR1H') {
    return { dataState: DATA_STATES.OK, stopReason: null, dataHint: 'Warmup (bar1h not ready)' };
  }
  
  return { dataState: DATA_STATES.OK, stopReason: null, dataHint: 'OK' };
}
