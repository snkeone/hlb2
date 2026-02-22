#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { last: 12, tradesFile: 'logs/trades.jsonl', rawDir: 'logs' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (a === '--last') out.last = Math.max(1, Math.floor(Number(argv[++i] || 12)));
    else if (a === '--trades-file') out.tradesFile = String(argv[++i] || out.tradesFile);
    else if (a === '--raw-dir') out.rawDir = String(argv[++i] || out.rawDir);
  }
  return out;
}

function readJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return [];
    const rows = [];
    for (const line of raw.split('\n')) {
      const s = String(line || '').trim();
      if (!s) continue;
      try {
        rows.push(JSON.parse(s));
      } catch {
        // ignore malformed line
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function countBy(arr, keyFn) {
  const m = new Map();
  for (const row of arr) {
    const k = keyFn(row);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries(Array.from(m.entries()).sort((a, b) => b[1] - a[1]));
}

function avg(values) {
  const nums = values.filter(v => Number.isFinite(Number(v))).map(Number);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function scanOiTrapBlocks(rawDir) {
  try {
    const dir = path.resolve(process.cwd(), rawDir);
    const files = fs.readdirSync(dir)
      .filter(name => /^raw-.*\.jsonl$/.test(name))
      .map(name => path.join(dir, name));
    let count = 0;
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        const s = String(line || '');
        if (!s) continue;
        if (/oi-price trap/i.test(s)) count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const allTrades = readJsonl(path.resolve(process.cwd(), args.tradesFile));
  const trades = allTrades.slice(-args.last);
  const reasons = countBy(trades, t => String(t?.signal || t?.reason || 'unknown'));
  const burstHits = trades.filter(t => String(t?.signal || '') === 'burst_adverse_exit' || t?.burstExitSignal).length;
  const driftHits = trades.filter(t => String(t?.signal || '') === 'environment_drift_exit' || t?.environmentDriftApplied === true).length;
  const eqRoutingApplied = trades.filter(t => t?.entryQualityRoutingApplied === true).length;
  const netPerTrade = avg(trades.map(t => t?.realizedPnlNetUsd));
  const avgWinNet = avg(trades.filter(t => Number(t?.realizedPnlNetUsd) > 0).map(t => t?.realizedPnlNetUsd));
  const avgCapture = avg(trades.map(t => t?.captureRatio));
  const oiTrapBlocks = scanOiTrapBlocks(args.rawDir);

  const out = {
    window: {
      tradesFile: args.tradesFile,
      last: args.last,
      analyzed: trades.length
    },
    pnl: {
      netPerTrade,
      avgWinNet,
      avgCaptureRatio: avgCapture
    },
    signals: {
      reasons,
      burstHits,
      driftHits,
      eqRoutingApplied,
      oiTrapBlocks
    },
    lastTrades: trades.map(t => ({
      ts: t?.ts ?? null,
      signal: t?.signal ?? null,
      net: Number.isFinite(Number(t?.realizedPnlNetUsd)) ? Number(t.realizedPnlNetUsd) : null,
      captureRatio: Number.isFinite(Number(t?.captureRatio)) ? Number(t.captureRatio) : null,
      burstExitSignal: t?.burstExitSignal ?? null,
      environmentDriftScore: Number.isFinite(Number(t?.environmentDriftScore)) ? Number(t.environmentDriftScore) : null,
      entryQualityRoutingProfile: t?.entryQualityRoutingProfile ?? null
    }))
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
