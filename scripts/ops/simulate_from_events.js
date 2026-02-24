#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parseArgs(argv) {
  const out = {
    runDir: path.resolve(process.cwd(), 'data/validation/run-latest'),
    minScore: 0,
    minSpreadBps: 0,
    maxSpreadBps: 5,
    holdMs: 30000,
    cooldownMs: 3000,
    includeTypes: []
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (a === '--run-dir') {
      out.runDir = path.resolve(process.cwd(), String(argv[++i] || out.runDir));
    } else if (a === '--min-score') {
      out.minScore = toNum(argv[++i], out.minScore);
    } else if (a === '--min-spread-bps') {
      out.minSpreadBps = toNum(argv[++i], out.minSpreadBps);
    } else if (a === '--max-spread-bps') {
      out.maxSpreadBps = toNum(argv[++i], out.maxSpreadBps);
    } else if (a === '--hold-ms') {
      out.holdMs = Math.max(1000, Math.floor(toNum(argv[++i], out.holdMs)));
    } else if (a === '--cooldown-ms') {
      out.cooldownMs = Math.max(0, Math.floor(toNum(argv[++i], out.cooldownMs)));
    } else if (a === '--include-types') {
      out.includeTypes = String(argv[++i] || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return out;
}

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw) continue;
    const cols = raw.split(',');
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = cols[j] ?? '';
    rows.push(row);
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return `${[keys.join(',')].concat(rows.map((r) => keys.map((k) => esc(r[k])).join(','))).join('\n')}\n`;
}

function sideToSign(side) {
  const s = String(side || '').toUpperCase();
  if (s === 'LONG') return 1;
  if (s === 'SHORT') return -1;
  return 0;
}

function simulate(rows, cfg) {
  const src = rows
    .filter((r) => String(r.cohort || '').toLowerCase() === 'real')
    .map((r) => ({
      type: String(r.type || '').toLowerCase(),
      side: String(r.side || '').toUpperCase(),
      ts: Math.floor(toNum(r.ts, NaN)),
      score: toNum(r.score, 0),
      spreadBps: toNum(r.spreadBps, NaN),
      net30Pes: toNum(r.net30Pes, NaN),
      net30: toNum(r.net30, NaN),
      mid: toNum(r.mid, NaN)
    }))
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.net30Pes) && sideToSign(r.side) !== 0)
    .sort((a, b) => a.ts - b.ts);

  const trades = [];
  let nextAllowedTs = -Infinity;
  for (const r of src) {
    if (r.ts < nextAllowedTs) continue;
    if (!Number.isFinite(r.spreadBps)) continue;
    if (r.spreadBps < cfg.minSpreadBps || r.spreadBps > cfg.maxSpreadBps) continue;
    if (r.score < cfg.minScore) continue;
    if (cfg.includeTypes.length > 0 && !cfg.includeTypes.includes(r.type)) continue;

    trades.push({
      entryTs: r.ts,
      exitTs: r.ts + cfg.holdMs,
      holdMs: cfg.holdMs,
      type: r.type,
      side: r.side,
      score: r.score,
      spreadBps: r.spreadBps,
      mid: r.mid,
      pnlNetUsd: r.net30Pes,
      pnlGrossUsd: r.net30,
      result: r.net30Pes > 0 ? 'WIN' : (r.net30Pes < 0 ? 'LOSS' : 'FLAT')
    });
    nextAllowedTs = r.ts + cfg.holdMs + cfg.cooldownMs;
  }
  return trades;
}

function summarize(trades, cfg, runDir) {
  const n = trades.length;
  const net = trades.reduce((a, t) => a + toNum(t.pnlNetUsd, 0), 0);
  const gross = trades.reduce((a, t) => a + toNum(t.pnlGrossUsd, 0), 0);
  const wins = trades.filter((t) => t.result === 'WIN').length;
  const losses = trades.filter((t) => t.result === 'LOSS').length;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    runDir,
    config: cfg,
    trades: n,
    wins,
    losses,
    winRate: n > 0 ? wins / n : 0,
    netUsd: net,
    grossUsd: gross,
    avgNetUsd: n > 0 ? net / n : 0
  };
}

function main() {
  const cfg = parseArgs(process.argv);
  const eventsPath = path.join(cfg.runDir, 'events_labeled.csv');
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`events_labeled.csv not found: ${eventsPath}`);
  }
  const rows = parseCsv(eventsPath);
  const trades = simulate(rows, cfg);
  const summary = summarize(trades, cfg, cfg.runDir);
  const outTrades = path.join(cfg.runDir, 'simulated_trades.csv');
  const outSummary = path.join(cfg.runDir, 'simulated_summary.json');
  fs.writeFileSync(outTrades, toCsv(trades), 'utf8');
  fs.writeFileSync(outSummary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (err) {
  console.error(`[simulate-from-events] ${err.message}`);
  process.exit(1);
}

