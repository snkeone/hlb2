import { toNumberSafe, normalizeSide, buildCommonHeader } from './common.js';

function firstFinite(...values) {
  for (const v of values) {
    const n = toNumberSafe(v);
    if (n !== null) return n;
  }
  return null;
}

function normalizeOne(item, header) {
  if (!item || typeof item !== 'object') return null;

  const px = firstFinite(item.px, item.price);
  const sz = firstFinite(item.sz, item.size);
  const side = normalizeSide(item.side ?? item.dir ?? item.direction);
  const usd = firstFinite(item.usd, item.notional, item.notionalUsd, item.value);
  const ts = firstFinite(item.time, item.ts, header.ts) ?? header.ts;

  return {
    channel: 'liquidations',
    coin: String(item.coin ?? header.coin),
    ts,
    source: header.source,
    liqPx: px,
    liqSz: sz,
    liqSide: side,
    liqUsd: usd
  };
}

export function normalizeLiquidations(raw) {
  const header = buildCommonHeader(raw);
  if (!header) return null;

  const payload = raw?.data?.data;
  if (Array.isArray(payload)) {
    const rows = payload
      .map((item) => normalizeOne(item, header))
      .filter((row) => row !== null);
    return rows.length > 0 ? rows : null;
  }

  if (payload && typeof payload === 'object') {
    return normalizeOne(payload, header);
  }

  return null;
}
