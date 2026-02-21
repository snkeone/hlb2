// ws/status/tracker.js
// lastSeenAtのみ管理、永続化禁止

const lastSeen = {
  WS: null,
  TRADES: null,
  ORDERBOOK: null,
  NORMALIZE: null,
  IO: null,
  LOGIC: null,
  UI: null,
};

export function markLayer(layer) {
  if (lastSeen.hasOwnProperty(layer)) {
    lastSeen[layer] = Date.now();
  }
}

export function getLastSeen() {
  return { ...lastSeen };
}
