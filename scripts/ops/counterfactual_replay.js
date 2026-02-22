#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
  const out = {
    windowMin: 720,
    apply: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window-min') out.windowMin = Number(argv[++i]);
    else if (a === '--apply') out.apply = true;
  }
  return out;
}

function loadTrades(cwd, windowMin) {
  const nowTs = Date.now();
  const fromTs = nowTs - Math.max(1, windowMin) * 60 * 1000;
  const files = [
    path.join(cwd, 'test-logs', 'trades.jsonl'),
    path.join(cwd, 'logs', 'trades.jsonl')
  ];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const rows = fs.readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .map((r) => ({
        ts: toNumber(r.timestampExit ?? r.exitTs ?? r.ts),
        pnl: toNumber(r.realizedPnlNetUsd ?? r.realizedPnlUsd ?? r.pnl, 0),
        holdMs: toNumber(r.holdMs, 0),
        exitReason: String(r.exitReason ?? '').toUpperCase(),
        signal: String(r.signal ?? '').toLowerCase()
      }))
      .filter((r) => Number.isFinite(r.ts) && r.ts >= fromTs && r.ts <= nowTs);
    return { source: f, trades: rows };
  }
  return { source: null, trades: [] };
}

function scoreScenario(trades, scenario) {
  // Inference model (not a market simulator):
  // timeout/tp/sl composition is re-weighted to estimate relative edge.
  // This is intentionally conservative and only for ranking scenarios.
  let score = 0;
  for (const t of trades) {
    let p = t.pnl;
    if (t.exitReason === 'TP') {
      p *= scenario.tpStretch / 1.4;
    } else if (t.exitReason === 'TIMEOUT') {
      const timeoutScale = scenario.lossTimeoutMs / 240000;
      if (p > 0) p *= Math.max(0.85, Math.min(1.15, timeoutScale));
      else p *= Math.max(0.75, Math.min(1.25, 1 / Math.max(0.5, timeoutScale)));
    } else if (t.exitReason === 'SL') {
      // tighter SL can reduce deep losses but may cut reversals.
      const slTightness = (0.55 - scenario.hardRatio) * 2; // >0 tighter than baseline
      p *= (p < 0 ? (1 - 0.18 * slTightness) : (1 - 0.08 * slTightness));
    }
    score += p;
  }
  return score;
}

function buildGrid(current) {
  const baseTp = toNumber(current?.b2?.tpStretch, 1.4);
  const baseTimeout = toNumber(current?.lossTimeout?.ms, 240000);
  const baseSoft = toNumber(current?.lossTimeout?.softRatio, 0.35);
  const baseHard = toNumber(current?.lossTimeout?.hardRatio, 0.55);
  const tps = [baseTp - 0.08, baseTp, baseTp + 0.08].map((v) => Math.max(1.0, Math.min(2.2, v)));
  const timeouts = [baseTimeout - 30000, baseTimeout, baseTimeout + 30000].map((v) => Math.max(120000, Math.min(420000, Math.round(v))));
  const softs = [baseSoft - 0.02, baseSoft, baseSoft + 0.02].map((v) => Math.max(0.2, Math.min(0.55, v)));
  const hards = [baseHard - 0.02, baseHard, baseHard + 0.02].map((v) => Math.max(0.35, Math.min(0.8, v)));

  const out = [];
  for (const tpStretch of tps) {
    for (const lossTimeoutMs of timeouts) {
      for (const softRatio of softs) {
        for (const hardRatioRaw of hards) {
          const hardRatio = Math.max(hardRatioRaw, softRatio + 0.08);
          out.push({ tpStretch, lossTimeoutMs, softRatio, hardRatio });
        }
      }
    }
  }
  return out;
}

function applyRecommendation(cwd, recommendation) {
  const tradePath = path.join(cwd, 'config', 'trade.json');
  const current = JSON.parse(fs.readFileSync(tradePath, 'utf8'));
  const next = JSON.parse(JSON.stringify(current));
  if (!next.b2) next.b2 = {};
  if (!next.lossTimeout) next.lossTimeout = {};
  next.b2.tpStretch = recommendation.tpStretch;
  next.lossTimeout.ms = recommendation.lossTimeoutMs;
  next.lossTimeout.softRatio = recommendation.softRatio;
  next.lossTimeout.hardRatio = recommendation.hardRatio;
  const backup = `${tradePath}.bak.${Date.now()}`;
  fs.copyFileSync(tradePath, backup);
  fs.writeFileSync(tradePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return backup;
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const tradePath = path.join(cwd, 'config', 'trade.json');
  const current = JSON.parse(fs.readFileSync(tradePath, 'utf8'));
  const { source, trades } = loadTrades(cwd, args.windowMin);
  if (!source || trades.length < 20) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'insufficient_trades',
      source,
      trades: trades.length
    }, null, 2));
    return;
  }

  const grid = buildGrid(current);
  const scored = grid.map((g) => ({ ...g, score: scoreScenario(trades, g) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const baseline = {
    tpStretch: toNumber(current?.b2?.tpStretch, 1.4),
    lossTimeoutMs: toNumber(current?.lossTimeout?.ms, 240000),
    softRatio: toNumber(current?.lossTimeout?.softRatio, 0.35),
    hardRatio: toNumber(current?.lossTimeout?.hardRatio, 0.55)
  };
  const baselineScore = scoreScenario(trades, baseline);
  const improvement = best.score - baselineScore;
  let backup = null;
  if (args.apply && improvement > 0) {
    backup = applyRecommendation(cwd, best);
  }

  const report = {
    ok: true,
    inferred: true,
    source,
    trades: trades.length,
    baseline: { ...baseline, score: Number(baselineScore.toFixed(6)) },
    best: { ...best, score: Number(best.score.toFixed(6)) },
    improvement: Number(improvement.toFixed(6)),
    applied: !!backup,
    backup
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

