import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

let cachedBaseEquityLiveUsd = null;
let loaded = false;
let warned = false;

function parseEquityJson(raw) {
  try {
    const data = JSON.parse(raw);
    const value = Number(data?.baseEquityLiveUsd);
    if (Number.isFinite(value) && value > 0) return value;
  } catch (err) {
    console.error('[equity] parseEquityJson failed', err);
  }
  return null;
}

export function loadBaseEquityLiveFromFile() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const filePath = path.join(__dirname, 'equity.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    cachedBaseEquityLiveUsd = parseEquityJson(raw);
    loaded = true;
    if (cachedBaseEquityLiveUsd === null && !warned) {
      warned = true;
      console.warn(`[equity] invalid baseEquityLiveUsd in ${filePath}`);
    }
  } catch (err) {
    console.error('[equity] loadBaseEquityLiveFromFile failed', err);
    cachedBaseEquityLiveUsd = null;
    loaded = true;
    if (!warned) {
      warned = true;
      console.warn(`[equity] missing ${filePath}`);
    }
  }
  return cachedBaseEquityLiveUsd;
}

export function setBaseEquityLiveUsd(value) {
  const num = Number(value);
  cachedBaseEquityLiveUsd = Number.isFinite(num) && num > 0 ? num : null;
  loaded = true;
  return cachedBaseEquityLiveUsd;
}

export function getBaseEquityLiveUsd() {
  if (!loaded) return loadBaseEquityLiveFromFile();
  return cachedBaseEquityLiveUsd;
}

// Fallback helper for callers that need a safe numeric value (or null)
export function getFallbackEquityUsd() {
  const val = getBaseEquityLiveUsd();
  return Number.isFinite(val) ? Number(val) : null;
}
