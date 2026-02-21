import bridgeEmitter from '../core/bridgeEmitter.js';

const ENABLED = process.env.DEBUG_UI === '1';
const PAD = 12;

const state = {
  ws: {},
  normalize: {},
  io: {},
  logic: {},
  engine: {},
  error: null
};

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m'
};

const safeString = (v) => {
  if (v === undefined) return '-';
  if (v === null) return 'null';
  if (typeof v === 'number' && Number.isFinite(v)) return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

function color(str, c) {
  return c ? `${ANSI[c]}${str}${ANSI.reset}` : str;
}

function renderLine(label, value, colorKey) {
  return color(label.padEnd(PAD, ' ') + value, colorKey);
}

function onDebugPacket(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.ws) state.ws = { ...state.ws, ...payload.ws };
  if (payload.normalize) state.normalize = { ...state.normalize, ...payload.normalize };
  if (payload.io) state.io = { ...state.io, ...payload.io };
  if (payload.logic) state.logic = { ...state.logic, ...payload.logic };
  if (payload.engine) state.engine = { ...state.engine, ...payload.engine };

  // legacy single-layer payload support
  if (payload.layer) {
    const layer = payload.layer;
    if (layer === 'ws') state.ws = { ...state.ws, ...payload.data };
    if (layer === 'normalize') state.normalize = { ...state.normalize, ...payload.data };
    if (layer === 'io') state.io = { ...state.io, ...payload.data };
    if (layer === 'logic') state.logic = { ...state.logic, ...payload.data };
    if (layer === 'engine') state.engine = { ...state.engine, ...payload.data };
  }
}

function onDebugError(err) {
  if (!err) return;
  state.error = {
    msg: err.msg || err.message || 'unknown error',
    ts: err.ts || Date.now()
  };
}

function renderWs(ws) {
  const lines = ['WS'];
  lines.push(renderLine('recv/sec', safeString(ws.recvPerSec ?? '-')));
  const ch = ws.channels || {};
  lines.push(renderLine('orderbook', safeString(ch.orderbook ?? 'MISSING')));
  lines.push(renderLine('trades', safeString(ch.trades ?? 'MISSING')));
  lines.push(renderLine('mid', safeString(ch.mid ?? 'MISSING')));
  lines.push(renderLine('activeCtx', safeString(ch.activeCtx ?? 'MISSING')));
  return lines;
}

function renderNormalize(nz) {
  return [
    'Normalize',
    renderLine('mid', safeString(nz.mid)),
    renderLine('bid', safeString(nz.bid)),
    renderLine('ask', safeString(nz.ask)),
    renderLine('oi', safeString(nz.oi)),
    renderLine('ts', safeString(nz.ts))
  ];
}

function renderIo(io) {
  return [
    'I/O',
    renderLine('pass', safeString(io.pass)),
    renderLine('coin', safeString(io.coin)),
    renderLine('ts', safeString(io.ts)),
    renderLine('zone', safeString(io.zone)),
    renderLine('A', safeString(io.A)),
    renderLine('B', safeString(io.B))
  ];
}

function renderLogic(logic) {
  return [
    'Logic',
    renderLine('decision', safeString(logic.decision)),
    renderLine('firepower', logic.firepower === undefined ? '-' : `${logic.firepower}x`),
    renderLine('reason', safeString(logic.reason)),
    renderLine('zone', safeString(logic.zone))
  ];
}

function renderEngine(engine) {
  const open = engine.open ? `${engine.open.side} ${engine.open.price}` : 'none';
  const winRate = engine.winRate === undefined ? '-' : `${engine.winRate}%`;
  return [
    'Engine',
    renderLine('PnL', safeString(engine.pnl)),
    renderLine('APR', safeString(engine.apr)),
    renderLine('WinRate', winRate),
    renderLine('open', open),
    renderLine('history7d', engine.history7dCount === undefined ? '-' : `${engine.history7dCount} trades`)
  ];
}

function renderError(err) {
  const lines = ['Error'];
  if (!err) {
    lines.push(renderLine('msg', 'none'));
    return lines;
  }
  lines.push(renderLine('[ERROR]', err.msg, 'red'));
  return lines;
}

function render() {
  try {
    console.clear();
  } catch (err) {
    console.error('[DebugUI] console.clear failed', err);
  }

  const output = [];
  output.push('[ DebugUI ]');
  output.push('────────────────────────────────────');
  output.push('');
  [
    renderWs(state.ws),
    renderNormalize(state.normalize),
    renderIo(state.io),
    renderLogic(state.logic),
    renderEngine(state.engine),
    renderError(state.error)
  ].forEach(block => {
    output.push(block.shift());
    block.forEach(line => output.push(line));
    output.push('');
  });
  output.push('────────────────────────────────────');
  console.log(output.join('\n'));
}

function start() {
  if (!ENABLED) return;
  if (bridgeEmitter.__uiConsoleListener) return;
  bridgeEmitter.__uiConsoleListener = true;
  bridgeEmitter.setMaxListeners(Math.max(bridgeEmitter.getMaxListeners(), 50));

  bridgeEmitter.on('debug-packet', onDebugPacket);
  bridgeEmitter.on('debug-error', onDebugError);

  setInterval(render, 100);
  console.log('[DebugUI] Console renderer enabled (DEBUG_UI=1)');
}

start();

export {}; // ESM module
