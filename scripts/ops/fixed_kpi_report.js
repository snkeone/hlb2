#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

function toNum(v, d = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0;
  return (a / b) * 100;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return 0;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function roundOrNull(v, d = 4) {
  return Number.isFinite(v) ? round(v, d) : null;
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function variance(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / arr.length;
}

function quantile(arr, q) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function parseArgs(argv) {
  const out = {
    trades: 'logs/trades.jsonl',
    raw: null,
    minN: 100,
    jsonOut: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === '--trades') out.trades = String(argv[++i] ?? out.trades);
    else if (a === '--raw') out.raw = String(argv[++i] ?? '');
    else if (a === '--min-n') out.minN = Math.max(1, Math.floor(toNum(argv[++i], out.minN)));
    else if (a === '--json-out') out.jsonOut = String(argv[++i] ?? '');
  }
  return out;
}

function resolveLatestRawFile(logsDir = 'logs') {
  try {
    const dir = path.resolve(process.cwd(), logsDir);
    const names = fs.readdirSync(dir)
      .filter((n) => /^raw-\d{8}\.jsonl$/.test(n))
      .sort();
    if (names.length === 0) return null;
    return path.join(dir, names[names.length - 1]);
  } catch {
    return null;
  }
}

function classifyTpMiss(trade) {
  const signal = String(trade?.signal ?? '').toLowerCase();
  const exitReason = String(trade?.exitReason ?? '').toLowerCase();
  const detail = String(trade?.exitReasonDetail ?? '').toLowerCase();
  const exitAt = String(trade?.exitAt ?? '').toLowerCase();
  const result = String(trade?.result ?? '').toLowerCase();
  const guardLike = [
    'guard',
    'burst_adverse',
    'flow',
    'drift',
    'stress_cut',
    'hostile',
    'oi-price trap',
    'ctx'
  ];
  const timeoutLike = ['timeout', 'time_limit', 'time limit'];

  if (timeoutLike.some((k) => signal.includes(k) || exitReason.includes(k) || detail.includes(k))) {
    return 'timeout';
  }
  if (guardLike.some((k) => signal.includes(k) || exitReason.includes(k) || detail.includes(k))) {
    return 'early_guard_exit';
  }
  if (exitAt === 'sl' || result === 'loss' || exitReason.includes('sl') || detail.includes('stop')) {
    return 'sl_reverse';
  }
  return 'other';
}

async function readTradesMetrics(tradesPath) {
  const stats = {
    count: 0,
    higherTfDir15m: new Map(),
    higherTfDir1h: new Map(),
    captureValues: [],
    tpReached: 0,
    tpHoldMs: [],
    slHoldMs: [],
    allHoldMs: [],
    tpMissReasons: new Map(),
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(tradesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = String(line || '').trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue;
    }
    stats.count += 1;

    const d15 = String(row?.higherTfDir15m ?? 'UNKNOWN').toUpperCase();
    const d1h = String(row?.higherTfDir1h ?? 'UNKNOWN').toUpperCase();
    stats.higherTfDir15m.set(d15, (stats.higherTfDir15m.get(d15) ?? 0) + 1);
    stats.higherTfDir1h.set(d1h, (stats.higherTfDir1h.get(d1h) ?? 0) + 1);

    const cap = toNum(row?.captureRatio, NaN);
    if (Number.isFinite(cap)) stats.captureValues.push(cap);

    const holdMs = toNum(row?.holdMs, NaN);
    if (Number.isFinite(holdMs) && holdMs >= 0) stats.allHoldMs.push(holdMs);
    const tpReached = row?.tpReached === true;
    if (tpReached) {
      stats.tpReached += 1;
      if (Number.isFinite(holdMs) && holdMs >= 0) stats.tpHoldMs.push(holdMs);
    } else {
      const reason = classifyTpMiss(row);
      stats.tpMissReasons.set(reason, (stats.tpMissReasons.get(reason) ?? 0) + 1);
      if (Number.isFinite(holdMs) && holdMs >= 0) {
        const isSl = String(row?.exitAt ?? '').toLowerCase() === 'sl' || String(row?.result ?? '').toLowerCase() === 'loss';
        if (isSl) stats.slHoldMs.push(holdMs);
      }
    }
  }

  return stats;
}

function inferGuardCategory(reason, blockerCategory) {
  const r = String(reason ?? '').toLowerCase();
  const b = String(blockerCategory ?? '').toLowerCase();
  if (b && b !== 'other' && b !== 'none') return b;
  if (r.includes('flow')) return 'flow_gate';
  if (r.includes('meta')) return 'meta_gate';
  if (r.includes('oi') && r.includes('trap')) return 'oi_trap_gate';
  if (r.includes('ctx')) return 'ctx_gate';
  if (r.includes('startup')) return 'startup_guard';
  if (r.includes('execution invalid')) return 'execution_guard';
  if (r.includes('too_far_from_sr') || r.includes('edge_negative') || r.includes('no structural')) return 'structure_gate';
  return 'other';
}

async function readDecisionMetrics(rawPath) {
  const out = {
    decisionTraceCount: 0,
    entryAllowedCount: 0,
    guardTriggeredCount: 0,
    guardCategory: new Map(),
    firstTs: null,
    lastTs: null,
  };
  if (!rawPath || !fs.existsSync(rawPath)) return out;

  const rl = readline.createInterface({
    input: fs.createReadStream(rawPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = String(line || '').trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue;
    }
    if (row?.type !== 'decision_trace') continue;
    out.decisionTraceCount += 1;
    const ts = toNum(row?.ts, NaN);
    if (Number.isFinite(ts)) {
      out.firstTs = Number.isFinite(out.firstTs) ? Math.min(out.firstTs, ts) : ts;
      out.lastTs = Number.isFinite(out.lastTs) ? Math.max(out.lastTs, ts) : ts;
    }
    const reason = String(row?.payload?.decision?.reason ?? row?.payload?.decision?.reasonCode ?? '').toLowerCase();
    const reasonCode = String(row?.payload?.decision?.reasonCode ?? '').toUpperCase();
    const side = String(row?.payload?.decision?.side ?? 'none').toLowerCase();
    const blockerCategory = String(row?.payload?.diagnostics?.blockerCategory ?? '');

    if (reasonCode.includes('ENTRY_ALLOWED') || reason.includes('entry allowed')) {
      out.entryAllowedCount += 1;
    }

    const isGuardTriggered = (
      side === 'none' && (
        reason.includes('flow') ||
        reason.includes('meta') ||
        reason.includes('guard') ||
        reason.includes('execution invalid') ||
        reason.includes('too_far_from_sr') ||
        reason.includes('edge_negative') ||
        reason.includes('no structural')
      )
    );

    if (isGuardTriggered) {
      out.guardTriggeredCount += 1;
      const cat = inferGuardCategory(reason, blockerCategory);
      out.guardCategory.set(cat, (out.guardCategory.get(cat) ?? 0) + 1);
    }
  }

  return out;
}

function mapToSortedObject(map, total) {
  const arr = [...map.entries()].map(([k, v]) => ({ key: k, count: v, rate: round(pct(v, total), 2) }));
  arr.sort((a, b) => b.count - a.count);
  return arr;
}

async function main() {
  const args = parseArgs(process.argv);
  const tradesPath = path.resolve(process.cwd(), args.trades);
  const rawPath = args.raw
    ? path.resolve(process.cwd(), args.raw)
    : resolveLatestRawFile('logs');

  if (!fs.existsSync(tradesPath)) {
    console.error(`[fixed_kpi_report] trades file not found: ${tradesPath}`);
    process.exit(1);
  }

  const trades = await readTradesMetrics(tradesPath);
  const decisions = await readDecisionMetrics(rawPath);

  const captureMedian = median(trades.captureValues);
  const captureVariance = variance(trades.captureValues);
  const tpMissTotal = Math.max(0, trades.count - trades.tpReached);
  const enoughSample = trades.count >= args.minN;
  const rawSpanHours = (Number.isFinite(decisions.firstTs) && Number.isFinite(decisions.lastTs) && decisions.lastTs > decisions.firstTs)
    ? ((decisions.lastTs - decisions.firstTs) / 3600000)
    : null;
  const entryAllowedPerHour = (Number.isFinite(rawSpanHours) && rawSpanHours > 0)
    ? (decisions.entryAllowedCount / rawSpanHours)
    : null;
  const completedPerHour = (Number.isFinite(rawSpanHours) && rawSpanHours > 0)
    ? (trades.count / rawSpanHours)
    : null;
  const remainToMinN = Math.max(0, args.minN - trades.count);
  const etaHoursToMinN = (Number.isFinite(completedPerHour) && completedPerHour > 0)
    ? (remainToMinN / completedPerHour)
    : null;

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: {
      tradesPath,
      rawPath: rawPath ?? null,
      minN: args.minN,
    },
    sample: {
      tradesN: trades.count,
      decisionTraceN: decisions.decisionTraceCount,
      enoughForDecision: enoughSample,
      remainToMinN,
    },
    funnel: {
      entryAllowed: decisions.entryAllowedCount,
      completedTrades: trades.count,
      entryAllowedToCompletedRate: round(pct(trades.count, Math.max(1, decisions.entryAllowedCount)), 4),
      entryAllowedPerHour: roundOrNull(entryAllowedPerHour, 3),
      completedPerHour: roundOrNull(completedPerHour, 4),
      etaHoursToMinN: roundOrNull(etaHoursToMinN, 2),
      etaDaysToMinN: roundOrNull(Number.isFinite(etaHoursToMinN) ? (etaHoursToMinN / 24) : NaN, 2),
    },
    kpi: {
      higherTfDir15m: mapToSortedObject(trades.higherTfDir15m, Math.max(1, trades.count)),
      higherTfDir1h: mapToSortedObject(trades.higherTfDir1h, Math.max(1, trades.count)),
      captureRatio: {
        n: trades.captureValues.length,
        median: captureMedian != null ? round(captureMedian, 6) : null,
        variance: captureVariance != null ? round(captureVariance, 8) : null,
        p25: round(quantile(trades.captureValues, 0.25) ?? NaN, 6),
        p75: round(quantile(trades.captureValues, 0.75) ?? NaN, 6),
      },
      tpReached: {
        reached: trades.tpReached,
        rate: round(pct(trades.tpReached, Math.max(1, trades.count)), 2),
      },
      holdTimeMs: {
        overall: {
          n: trades.allHoldMs.length,
          mean: roundOrNull(
            trades.allHoldMs.length > 0
              ? (trades.allHoldMs.reduce((a, b) => a + b, 0) / trades.allHoldMs.length)
              : NaN,
            0
          ),
          median: roundOrNull(median(trades.allHoldMs), 0),
        },
        toTp: {
          n: trades.tpHoldMs.length,
          median: roundOrNull(median(trades.tpHoldMs), 0),
          p25: roundOrNull(quantile(trades.tpHoldMs, 0.25), 0),
          p75: roundOrNull(quantile(trades.tpHoldMs, 0.75), 0),
        },
        toSl: {
          n: trades.slHoldMs.length,
          median: roundOrNull(median(trades.slHoldMs), 0),
          p25: roundOrNull(quantile(trades.slHoldMs, 0.25), 0),
          p75: roundOrNull(quantile(trades.slHoldMs, 0.75), 0),
        },
      },
      guardActivation: {
        triggered: decisions.guardTriggeredCount,
        rate: round(pct(decisions.guardTriggeredCount, Math.max(1, decisions.decisionTraceCount)), 2),
        byCategory: mapToSortedObject(decisions.guardCategory, Math.max(1, decisions.guardTriggeredCount)),
      },
    },
    tpMissReasonBreakdown: mapToSortedObject(trades.tpMissReasons, Math.max(1, tpMissTotal)),
  };

  if (args.jsonOut) {
    const outPath = path.resolve(process.cwd(), args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[fixed_kpi_report] failed', err);
  process.exit(1);
});
