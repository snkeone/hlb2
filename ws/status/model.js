// ws/status/model.js
// 状態・レイヤー・致命度・時間条件の定数・定義のみ

export const LAYERS = [
  'WS',
  'NORMALIZE',
  'IO',
  'LOGIC',
  'UI'
];

export const STATES = {
  BOOTING: 'BOOTING',
  CONNECTED: 'CONNECTED',
  ACTIVE: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  DEAD: 'DEAD',
};

export const SEVERITIES = {
  INFO: 'INFO',
  WARN: 'WARN',
  FATAL: 'FATAL',
};

export const DATA_STATES = {
  OK: 'OK',
  WAIT_TRADES: 'WAIT_TRADES',
  WAIT_ORDERBOOK: 'WAIT_ORDERBOOK',
  WAIT_WS: 'WAIT_WS',
};

export { STOP_REASONS } from '../../core/stopReasons.js';

// 時間条件（ms）
export const TIMEOUTS = {
  WS: { connected: 10000, dead: 30000 },
  TRADES: { wait: 10000 },
  ORDERBOOK: { wait: 10000 },
  NORMALIZE: { degraded: 10000, dead: 30000 },
  IO: { degraded: 15000, dead: 60000 },
  LOGIC: { degraded: 30000, dead: 60000 },
  EMIT: { warn: 30000 },
};
