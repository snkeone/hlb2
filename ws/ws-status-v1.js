#!/usr/bin/env node
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:8788';
const SEND_INTERVAL_MS = 1000;
let ws = null;

function connect() {
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('[ws-status-v1] Connected');
    sendStatus();
  });
  
  ws.on('error', err => {
    console.error('[ws-status-v1] Error:', err.message);
  });
  
  ws.on('close', () => {
    console.log('[ws-status-v1] Disconnected, retrying...');
    setTimeout(connect, 1000);
  });
}

function sendStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  const payload = {
    type: 'ws-status-v1',
    state: 'NO_FEED',      // Phase 1: 固定（bin/hlb OK_STATES 適合）
    severity: 'INFO',      // Phase 1: 固定
    stoppedAt: null,
    hint: 'ws-status-v1 active',
    dataState: null,
    stopReason: null,
    dataHint: null,
    mode: process.env.MODE ?? 'dry',
    hlEnabled: process.env.HL_ENABLE === '1',
    cores: [],
  };
  
  ws.send(JSON.stringify(payload));
}

setInterval(sendStatus, SEND_INTERVAL_MS);

console.log('[ws-status-v1] Starting...');
connect();
