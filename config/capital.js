import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

let cachedInitialCapitalUsd = null;
let loaded = false;
let warned = false;

function parseCapitalJson(raw) {
  try {
    const data = JSON.parse(raw);
    const value = Number(data?.initialCapitalUsd);
    if (Number.isFinite(value) && value > 0) return value;
  } catch (err) {
    console.error('[capital] parseCapitalJson failed', err);
  }
  return null;
}

export function loadCapitalFromFile() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const filePath = path.join(__dirname, 'capital.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    cachedInitialCapitalUsd = parseCapitalJson(raw);
    loaded = true;
    if (cachedInitialCapitalUsd === null && !warned) {
      warned = true;
      console.warn(`[capital] invalid initialCapitalUsd in ${filePath}`);
    }
  } catch (err) {
    console.error('[capital] loadCapitalFromFile failed', err);
    cachedInitialCapitalUsd = null;
    loaded = true;
    if (!warned) {
      warned = true;
      console.warn(`[capital] missing ${filePath}`);
    }
  }
  return cachedInitialCapitalUsd;
}

export function setInitialCapitalUsd(value) {
  const num = Number(value);
  cachedInitialCapitalUsd = Number.isFinite(num) && num > 0 ? num : null;
  loaded = true;
  return cachedInitialCapitalUsd;
}

export function getInitialCapitalUsd() {
  if (!loaded) {
    loadCapitalFromFile();
  }
  return cachedInitialCapitalUsd;
}
