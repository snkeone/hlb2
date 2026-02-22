#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import minimist from 'minimist';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_PATHS = {
  config: path.join(ROOT, 'config', 'trade.json'),
  trades: path.join(ROOT, 'logs', 'trades.jsonl'),
  candidates: path.join(ROOT, 'scripts', 'ops', 'profit_tuner_candidates.json'),
  state: path.join(ROOT, 'config', 'profit_tuner_state.json'),
  best: path.join(ROOT, 'config', 'profit_tuner_best.json'),
  trialLog: path.join(ROOT, 'logs', 'profit_tuner_trials.jsonl'),
  tunePid: path.join(ROOT, '.hlb.tune.pid')
};

function nowIso() {
  return new Date().toISOString();
}

function toNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function approxEq(a, b, eps = 1e-9) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= eps;
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to parse json: ${filePath}: ${err.message}`);
  }
}

function writeJson(filePath, obj) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, obj) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function isTuneDaemonRunning(tunePidPath) {
  if (!fs.existsSync(tunePidPath)) return false;
  const pid = toNum(fs.readFileSync(tunePidPath, 'utf8').trim(), NaN);
  return isAlive(pid);
}

function detectOpenPositions() {
  const files = [
    path.join(ROOT, 'ws', 'engine_state.TEST.json'),
    path.join(ROOT, 'ws', 'engine_state.LIVE.json'),
    path.join(ROOT, 'ws', 'engine_state.json')
  ];
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const pos = data?.openPosition;
      const side = String(pos?.side ?? '').toLowerCase();
      const size = toNum(pos?.size, 0);
      if ((side === 'buy' || side === 'sell') && size > 0) {
        out.push({ file: path.basename(f), side, size });
      }
    } catch (_) {}
  }
  return out;
}

function getByPath(obj, dotPath) {
  return String(dotPath).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setByPath(obj, dotPath, value) {
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function loadTrades(tradesPath) {
  if (!fs.existsSync(tradesPath)) return [];
  const txt = fs.readFileSync(tradesPath, 'utf8').trim();
  if (!txt) return [];
  const rows = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (_) {}
  }
  return rows;
}

function computeMetrics(rows) {
  const netArr = rows.map(r => toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)));
  const grossArr = rows.map(r => toNum(r.realizedPnlUsd, 0));
  const wins = rows
    .map(r => ({ net: toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)), cap: toNum(r.captureRatio, NaN) }))
    .filter(r => r.net > 0);
  const losses = netArr.filter(v => v < 0);
  const tpCount = rows.filter(r => {
    const signal = String(r.signal ?? '').toLowerCase();
    const exitReason = String(r.exitReason ?? '').toUpperCase();
    return signal.includes('tp') || exitReason === 'TP';
  }).length;
  const feeSum = rows.reduce((a, r) => a + toNum(r.feeUsd, 0), 0);
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const avg = arr => (arr.length > 0 ? sum(arr) / arr.length : null);

  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const v of netArr) {
    eq += v;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  const winCaps = wins.map(w => w.cap).filter(Number.isFinite);
  const expectancy = netArr.length > 0 ? sum(netArr) / netArr.length : null;
  const grossSum = sum(grossArr);

  return {
    n: rows.length,
    net: sum(netArr),
    expectancy,
    avgWinNet: avg(wins.map(w => w.net)),
    avgLossNet: avg(losses),
    winCount: wins.length,
    lossCount: losses.length,
    captureRatioWinAvg: avg(winCaps),
    tpRate: rows.length > 0 ? tpCount / rows.length : null,
    feeOverGrossPct: grossSum > 0 ? (feeSum / grossSum) * 100 : null,
    maxDD
  };
}

function evaluateGate(metrics, gateCfg) {
  const fatalThreshold = toNum(gateCfg?.fatal_expectancy_lt, -Infinity);
  const fatal = Number.isFinite(metrics.expectancy) && metrics.expectancy < fatalThreshold;

  const checks = [];

  const avgWinTh = toNum(gateCfg?.avg_win_net_gte, NaN);
  const avgWinValid = Number.isFinite(avgWinTh) && metrics.winCount >= 2 && Number.isFinite(metrics.avgWinNet);
  checks.push({
    key: 'avgWinNet',
    valid: avgWinValid,
    pass: avgWinValid ? metrics.avgWinNet >= avgWinTh : false,
    threshold: avgWinTh,
    value: metrics.avgWinNet
  });

  const capTh = toNum(gateCfg?.capture_ratio_win_avg_gte, NaN);
  const capValid = Number.isFinite(capTh) && metrics.winCount >= 2 && Number.isFinite(metrics.captureRatioWinAvg);
  checks.push({
    key: 'captureRatioWinAvg',
    valid: capValid,
    pass: capValid ? metrics.captureRatioWinAvg >= capTh : false,
    threshold: capTh,
    value: metrics.captureRatioWinAvg
  });

  const feeTh = toNum(gateCfg?.fee_over_gross_pct_lte, NaN);
  const feeValid = Number.isFinite(feeTh) && Number.isFinite(metrics.feeOverGrossPct);
  checks.push({
    key: 'feeOverGrossPct',
    valid: feeValid,
    pass: feeValid ? metrics.feeOverGrossPct <= feeTh : false,
    threshold: feeTh,
    value: metrics.feeOverGrossPct
  });

  const validCount = checks.filter(c => c.valid).length;
  const passCount = checks.filter(c => c.valid && c.pass).length;
  const requiredPass = Math.ceil((validCount * 2) / 3);
  const decidable = validCount >= 2;
  const pass = !fatal && decidable && passCount >= requiredPass;

  return {
    fatal,
    decidable,
    pass,
    validCount,
    passCount,
    requiredPass,
    checks
  };
}

function computeScore(metrics) {
  const avgWin = Number.isFinite(metrics.avgWinNet) ? metrics.avgWinNet : -10;
  const cap = Number.isFinite(metrics.captureRatioWinAvg) ? metrics.captureRatioWinAvg : 0;
  const tpRate = Number.isFinite(metrics.tpRate) ? metrics.tpRate : 0;
  const expectancy = Number.isFinite(metrics.expectancy) ? metrics.expectancy : -10;
  const fee = Number.isFinite(metrics.feeOverGrossPct) ? metrics.feeOverGrossPct : 500;
  // Profit-quality first: avgWin/capture dominate.
  // tpRate is intentionally light so "many small TP" does not dominate ranking.
  return (
    (1.00 * avgWin) +
    (2.00 * cap) +
    (0.50 * expectancy) +
    (0.50 * tpRate) -
    (fee / 200)
  );
}

function loadCandidates(candidatesPath, tradeConfig) {
  const parsed = readJson(candidatesPath, null);
  if (!parsed || !Array.isArray(parsed.knobs) || parsed.knobs.length === 0) {
    throw new Error(`invalid candidates file: ${candidatesPath}`);
  }
  const knobs = parsed.knobs.map(k => {
    if (!k || typeof k.key !== 'string' || !Array.isArray(k.values) || k.values.length === 0) {
      throw new Error(`invalid knob entry in ${candidatesPath}`);
    }
    const baseline = toNum(getByPath(tradeConfig, k.key), NaN);
    const merged = [];
    const pushUnique = val => {
      const n = toNum(val, NaN);
      if (!Number.isFinite(n)) return;
      if (merged.some(v => approxEq(v, n))) return;
      merged.push(n);
    };
    if (Number.isFinite(baseline)) pushUnique(baseline);
    for (const val of k.values) pushUnique(val);
    return { key: k.key, values: merged };
  });
  return { gates: parsed.gates ?? {}, knobs };
}

function initializeState(statePath, knobs, tradeConfig) {
  const existing = readJson(statePath, null);
  if (existing && typeof existing === 'object') return existing;
  const baselineByKnob = {};
  for (const k of knobs) {
    baselineByKnob[k.key] = getByPath(tradeConfig, k.key);
  }
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    mode: 'running',
    knobIndex: 0,
    candidateIndex: 0,
    baselineByKnob,
    bestByKnob: {},
    completedKnobs: [],
    trial: null,
    lastAction: 'initialized'
  };
}

function applyConfigValue(configPath, key, value) {
  const cfg = readJson(configPath, null);
  if (!cfg) throw new Error(`missing config: ${configPath}`);
  const current = getByPath(cfg, key);
  const cNum = toNum(current, NaN);
  const vNum = toNum(value, NaN);
  const unchanged = Number.isFinite(cNum) && Number.isFinite(vNum) ? approxEq(cNum, vNum) : current === value;
  if (unchanged) return { changed: false, before: current, after: value };
  setByPath(cfg, key, value);
  writeJson(configPath, cfg);
  return { changed: true, before: current, after: value };
}

function saveBestSnapshot(bestPath, state) {
  const payload = {
    updatedAt: nowIso(),
    mode: state.mode,
    knobIndex: state.knobIndex,
    candidateIndex: state.candidateIndex,
    bestByKnob: state.bestByKnob,
    completedKnobs: state.completedKnobs
  };
  writeJson(bestPath, payload);
}

function markDone(state, knobs) {
  state.mode = 'done';
  state.doneAt = nowIso();
  state.trial = null;
  state.lastAction = `completed_all_knobs:${knobs.length}`;
}

function startTrial(state, knobs, paths) {
  const knob = knobs[state.knobIndex];
  const value = knob.values[state.candidateIndex];
  const apply = applyConfigValue(paths.config, knob.key, value);
  const startTradeCount = loadTrades(paths.trades).length;
  state.trial = {
    knobKey: knob.key,
    value,
    phase: 'collect5',
    startTradeCount,
    startTs: Date.now()
  };
  state.lastAction = `trial_started:${knob.key}=${value}`;
  appendJsonl(paths.trialLog, {
    ts: Date.now(),
    at: nowIso(),
    type: 'trial_started',
    knobKey: knob.key,
    value,
    startTradeCount,
    apply
  });
}

function moveToNextCandidateOrKnob(state, knobs, paths) {
  const knob = knobs[state.knobIndex];
  const key = knob.key;
  const hasNextCandidate = (state.candidateIndex + 1) < knob.values.length;
  if (hasNextCandidate) {
    state.candidateIndex += 1;
    state.trial = null;
    state.lastAction = `next_candidate:${key}[${state.candidateIndex}]`;
    return;
  }

  const best = state.bestByKnob[key];
  const fallback = state.baselineByKnob[key];
  const chosen = best && Number.isFinite(best.score) ? best.value : fallback;
  const apply = applyConfigValue(paths.config, key, chosen);

  state.completedKnobs.push({
    key,
    chosen,
    best: best ?? null,
    fallback,
    completedAt: nowIso()
  });
  state.knobIndex += 1;
  state.candidateIndex = 0;
  state.trial = null;
  state.lastAction = `knob_completed:${key}=>${chosen}`;
  appendJsonl(paths.trialLog, {
    ts: Date.now(),
    at: nowIso(),
    type: 'knob_completed',
    key,
    chosen,
    best: best ?? null,
    fallback,
    apply
  });

  if (state.knobIndex >= knobs.length) {
    markDone(state, knobs);
  }
}

function runTick(paths, options = {}) {
  const allowTuneDaemon = options.allowTuneDaemon === true;
  const tradeConfig = readJson(paths.config, null);
  if (!tradeConfig) throw new Error(`missing config: ${paths.config}`);
  const { gates, knobs } = loadCandidates(paths.candidates, tradeConfig);
  const state = initializeState(paths.state, knobs, tradeConfig);
  state.updatedAt = nowIso();

  if (state.mode === 'done') {
    saveBestSnapshot(paths.best, state);
    writeJson(paths.state, state);
    return { type: 'done', state };
  }

  if (!allowTuneDaemon && isTuneDaemonRunning(paths.tunePid)) {
    state.lastAction = 'blocked:tune_daemon_running';
    writeJson(paths.state, state);
    appendJsonl(paths.trialLog, {
      ts: Date.now(),
      at: nowIso(),
      type: 'blocked',
      reason: 'tune_daemon_running'
    });
    return { type: 'blocked', reason: 'tune_daemon_running', state };
  }

  const openPositions = detectOpenPositions();
  if (openPositions.length > 0) {
    state.lastAction = 'blocked:open_position';
    writeJson(paths.state, state);
    appendJsonl(paths.trialLog, {
      ts: Date.now(),
      at: nowIso(),
      type: 'blocked',
      reason: 'open_position',
      openPositions
    });
    return { type: 'blocked', reason: 'open_position', openPositions, state };
  }

  if (state.knobIndex >= knobs.length) {
    markDone(state, knobs);
    saveBestSnapshot(paths.best, state);
    writeJson(paths.state, state);
    appendJsonl(paths.trialLog, {
      ts: Date.now(),
      at: nowIso(),
      type: 'done'
    });
    return { type: 'done', state };
  }

  if (!state.trial) {
    startTrial(state, knobs, paths);
    saveBestSnapshot(paths.best, state);
    writeJson(paths.state, state);
    return { type: 'started_trial', state };
  }

  const rows = loadTrades(paths.trades);
  if (rows.length < state.trial.startTradeCount) {
    const prevStart = state.trial.startTradeCount;
    state.trial.startTradeCount = rows.length;
    state.trial.phase = 'collect5';
    state.trial.startTs = Date.now();
    state.lastAction = `trial_rebased_after_trade_reset:${state.trial.knobKey}=${state.trial.value}`;
    appendJsonl(paths.trialLog, {
      ts: Date.now(),
      at: nowIso(),
      type: 'trial_rebased_after_trade_reset',
      knobKey: state.trial.knobKey,
      value: state.trial.value,
      prevStartTradeCount: prevStart,
      newStartTradeCount: rows.length
    });
    saveBestSnapshot(paths.best, state);
    writeJson(paths.state, state);
    return { type: 'trial_rebased_after_trade_reset', prevStartTradeCount: prevStart, newStartTradeCount: rows.length, state };
  }
  const since = rows.slice(state.trial.startTradeCount);

  const stage5Cfg = gates?.stage5 ?? {};
  const stage10Cfg = gates?.stage10 ?? {};

  if (state.trial.phase === 'collect5') {
    if (since.length < 5) {
      state.lastAction = `waiting_stage5:${since.length}/5`;
      writeJson(paths.state, state);
      return { type: 'waiting', stage: 'collect5', have: since.length, need: 5, state };
    }
    const sample5 = since.slice(0, 5);
    const metrics5 = computeMetrics(sample5);
    const gate5 = evaluateGate(metrics5, stage5Cfg);
    appendJsonl(paths.trialLog, {
      ts: Date.now(),
      at: nowIso(),
      type: 'stage5_result',
      knobKey: state.trial.knobKey,
      value: state.trial.value,
      metrics: metrics5,
      gate: gate5
    });
    if (gate5.fatal || (gate5.decidable && !gate5.pass)) {
      state.lastAction = `stage5_fail:${state.trial.knobKey}=${state.trial.value}`;
      moveToNextCandidateOrKnob(state, knobs, paths);
      if (state.mode === 'running' && !state.trial) {
        startTrial(state, knobs, paths);
      }
      saveBestSnapshot(paths.best, state);
      writeJson(paths.state, state);
      return { type: 'stage5_fail', metrics: metrics5, gate: gate5, state };
    }
    state.trial.phase = 'collect10';
    state.lastAction = `stage5_pass:${state.trial.knobKey}=${state.trial.value}`;
    if (since.length < 10) {
      saveBestSnapshot(paths.best, state);
      writeJson(paths.state, state);
      return { type: 'stage5_pass_wait10', state };
    }
  }

  if (state.trial.phase === 'collect10') {
    if (since.length < 10) {
      state.lastAction = `waiting_stage10:${since.length}/10`;
      writeJson(paths.state, state);
      return { type: 'waiting', stage: 'collect10', have: since.length, need: 10, state };
    }
    const sample10 = since.slice(0, 10);
    const metrics10 = computeMetrics(sample10);
    const gate10 = evaluateGate(metrics10, stage10Cfg);
    const passed = gate10.decidable && gate10.pass && !gate10.fatal;
    const score = passed ? computeScore(metrics10) : Number.NEGATIVE_INFINITY;
    appendJsonl(paths.trialLog, {
      ts: Date.now(),
      at: nowIso(),
      type: 'stage10_result',
      knobKey: state.trial.knobKey,
      value: state.trial.value,
      metrics: metrics10,
      gate: gate10,
      passed,
      score
    });
    if (passed) {
      const key = state.trial.knobKey;
      const currentBest = state.bestByKnob[key];
      if (!currentBest || !Number.isFinite(currentBest.score) || score > currentBest.score) {
        state.bestByKnob[key] = {
          value: state.trial.value,
          score,
          metrics: metrics10,
          updatedAt: nowIso()
        };
      }
    }
    state.lastAction = `stage10_${passed ? 'pass' : 'fail'}:${state.trial.knobKey}=${state.trial.value}`;
    moveToNextCandidateOrKnob(state, knobs, paths);
    if (state.mode === 'running' && !state.trial) {
      startTrial(state, knobs, paths);
    }
    saveBestSnapshot(paths.best, state);
    writeJson(paths.state, state);
    return { type: passed ? 'stage10_pass' : 'stage10_fail', metrics: metrics10, gate: gate10, score, state };
  }

  state.lastAction = `invalid_trial_phase:${state.trial.phase}`;
  writeJson(paths.state, state);
  return { type: 'error', reason: 'invalid_trial_phase', state };
}

function printStatus(paths) {
  const state = readJson(paths.state, null);
  const best = readJson(paths.best, null);
  const tradesCount = loadTrades(paths.trades).length;
  const out = {
    at: nowIso(),
    tradesCount,
    state: state ?? null,
    best: best ?? null
  };
  console.log(JSON.stringify(out, null, 2));
}

function resetState(paths, opts = {}) {
  const restoreBaseline = opts.restoreBaseline === true;
  const state = readJson(paths.state, null);
  if (restoreBaseline && state?.baselineByKnob) {
    const cfg = readJson(paths.config, null);
    if (cfg) {
      for (const [k, v] of Object.entries(state.baselineByKnob)) {
        setByPath(cfg, k, v);
      }
      writeJson(paths.config, cfg);
    }
  }
  if (fs.existsSync(paths.state)) fs.rmSync(paths.state, { force: true });
  if (fs.existsSync(paths.best)) fs.rmSync(paths.best, { force: true });
  console.log(JSON.stringify({ ok: true, reset: true, restoreBaseline }, null, 2));
}

function resolvePaths(args) {
  return {
    config: path.resolve(args.config ?? DEFAULT_PATHS.config),
    trades: path.resolve(args.trades ?? DEFAULT_PATHS.trades),
    candidates: path.resolve(args.candidates ?? DEFAULT_PATHS.candidates),
    state: path.resolve(args.state ?? DEFAULT_PATHS.state),
    best: path.resolve(args.best ?? DEFAULT_PATHS.best),
    trialLog: path.resolve(args['trial-log'] ?? DEFAULT_PATHS.trialLog),
    tunePid: path.resolve(args['tune-pid'] ?? DEFAULT_PATHS.tunePid)
  };
}

async function runDaemon(paths, opts) {
  const intervalSec = Math.max(5, Math.floor(toNum(opts['interval-sec'], 30)));
  console.log(`[profit-tuner] daemon started interval=${intervalSec}s`);
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      const res = runTick(paths, { allowTuneDaemon: opts['allow-tune-daemon'] === true });
      console.log(`[profit-tuner] ${nowIso()} ${res.type}`);
    } catch (err) {
      console.error(`[profit-tuner] tick failed: ${err.message}`);
    } finally {
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalSec * 1000);
  await new Promise(() => {});
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['allow-tune-daemon', 'restore-baseline'],
    string: ['config', 'trades', 'candidates', 'state', 'best', 'trial-log', 'tune-pid', 'interval-sec']
  });
  const cmd = String(args._[0] ?? 'tick').toLowerCase();
  const paths = resolvePaths(args);

  if (cmd === 'status') {
    printStatus(paths);
    return;
  }
  if (cmd === 'reset') {
    resetState(paths, { restoreBaseline: args['restore-baseline'] === true });
    return;
  }
  if (cmd === 'daemon') {
    await runDaemon(paths, args);
    return;
  }
  if (cmd === 'tick') {
    const res = runTick(paths, { allowTuneDaemon: args['allow-tune-daemon'] === true });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.error('usage: node scripts/ops/profit_tuner.js [tick|status|daemon|reset] [--allow-tune-daemon] [--interval-sec N]');
  process.exit(1);
}

main().catch(err => {
  console.error(`[profit-tuner] fatal: ${err.message}`);
  process.exit(1);
});
