#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function resolveSessionFromTs(ts, tzOffsetMin = 0) {
  if (!Number.isFinite(ts)) return 'off';
  const local = new Date(ts + tzOffsetMin * 60 * 1000);
  const h = local.getUTCHours();
  if (h >= 6 && h < 12) return 'asia';
  if (h >= 12 && h < 18) return 'eu';
  if (h >= 18 && h < 24) return 'us';
  return 'off';
}

function defaultSessionProfile(name) {
  if (name === 'asia') {
    return {
      tpStretchMul: 0.98,
      timeoutMsMul: 0.95,
      tpSplitCloseRatioMul: 1.03
    };
  }
  if (name === 'eu') {
    return {
      tpStretchMul: 1.02,
      timeoutMsMul: 1.03,
      tpSplitCloseRatioMul: 0.98
    };
  }
  if (name === 'us') {
    return {
      tpStretchMul: 1.03,
      timeoutMsMul: 1.05,
      tpSplitCloseRatioMul: 0.96
    };
  }
  return {
    tpStretchMul: 1.0,
    timeoutMsMul: 1.0,
    tpSplitCloseRatioMul: 1.0
  };
}

function parseArgs(argv) {
  const out = {
    input: null,
    apply: false,
    minSamples: 5000,
    minTradeSamples: 40,
    maxChangeRatio: 0.2,
    windowMin: null,
    adaptive: false,
    regime: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i] || null;
    else if (a === '--apply') out.apply = true;
    else if (a === '--min-samples') out.minSamples = Number(argv[++i]);
    else if (a === '--min-trade-samples') out.minTradeSamples = Number(argv[++i]);
    else if (a === '--max-change-ratio') out.maxChangeRatio = Number(argv[++i]);
    else if (a === '--window-min') out.windowMin = Number(argv[++i]);
    else if (a === '--adaptive') out.adaptive = true;
    else if (a === '--regime') out.regime = String(argv[++i] || '').toLowerCase();
  }
  return out;
}

function findLatestRawLog(logDir) {
  const files = fs.readdirSync(logDir)
    .filter((f) => /^raw-\d{8}\.jsonl$/.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(logDir, files[0]) : null;
}

function findRecentRawLogs(logDir, maxFiles = 2) {
  const files = fs.readdirSync(logDir)
    .filter((f) => /^raw-\d{8}\.jsonl$/.test(f))
    .sort()
    .reverse()
    .slice(0, Math.max(1, maxFiles));
  return files.map((f) => path.join(logDir, f));
}

function resolveInputFiles(cwd, args, logDir) {
  if (args.input) {
    return String(args.input)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => path.resolve(cwd, s))
      .filter((p) => fs.existsSync(p));
  }
  return findRecentRawLogs(logDir, 2);
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveStartupGuardApplyFreezeMs(current) {
  const raw = toNumber(current?.startupGuard?.freezeAutoTuneApplyMs);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function readLatestMarkerTs(cwd, types = []) {
  try {
    const markerPath = path.resolve(cwd, 'logs', 'markers.jsonl');
    if (!fs.existsSync(markerPath)) return null;
    const lines = fs.readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean);
    const typeSet = new Set(types);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let row = null;
      try { row = JSON.parse(lines[i]); } catch (_) { row = null; }
      if (!row) continue;
      if (typeSet.size > 0 && !typeSet.has(String(row.type ?? ''))) continue;
      const ts = toNumber(row.ts);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
  } catch (_) {}
  return null;
}

function resolveCapitalUsd(cwd, current) {
  const fromEnv = toNumber(process.env.AUTO_TUNE_CAPITAL_USD)
    ?? toNumber(process.env.ACCOUNT_EQUITY_USD);
  if (fromEnv != null && fromEnv > 0) return fromEnv;
  const fromCfg = toNumber(current?.autoTuner?.capitalUsd);
  if (fromCfg != null && fromCfg > 0) return fromCfg;
  const equityJson = safeReadJson(path.join(cwd, 'config', 'equity.json'));
  const fromEquity = toNumber(equityJson?.baseEquityLiveUsd);
  if (fromEquity != null && fromEquity > 0) return fromEquity;
  const capitalJson = safeReadJson(path.join(cwd, 'config', 'capital.json'));
  const fromCapital = toNumber(capitalJson?.initialCapitalUsd);
  if (fromCapital != null && fromCapital > 0) return fromCapital;
  return 2000;
}

async function analyzeTradesWindow(cwd, windowMin) {
  const nowTs = Date.now();
  const windowMs = Number.isFinite(windowMin) && windowMin > 0 ? windowMin * 60 * 1000 : 12 * 60 * 60 * 1000;
  const fromTs = nowTs - windowMs;
  const candidates = [
    path.join(cwd, 'test-logs', 'trades.jsonl'),
    path.join(cwd, 'logs', 'trades.jsonl')
  ];
  const stats = {
    source: null,
    count: 0,
    winCount: 0,
    lossCount: 0,
    pnlSum: 0,
    avgPnl: 0,
    avgNotional: 0,
    avgWinPnl: 0,
    avgLossPnl: 0,
    avgHoldMs: 0,
    avgCaptureRatio: null,
    captureLowRate: null,
    avgRegretUsd: null,
    regretOver1Rate: null,
    tpSource: {
      srNext: 0,
      channelEdge: 0,
      other: 0
    },
    exit: {
      tp: 0,
      sl: 0,
      timeout: 0,
      other: 0,
      timeoutLossOnly: 0,
      hardSl: 0,
      softSl: 0,
      tp1Partial: 0,
      stressCutLoss: 0
    },
    tpMode: {
      rail: 0,
      stretch: 0,
      unknown: 0
    },
    sessions: {
      asia: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 },
      eu: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 },
      us: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 },
      off: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 }
    }
  };
  const tzOffsetMin = toNumber(process.env.AUTO_TUNE_SESSION_TZ_OFFSET_MIN) ?? toNumber(process.env.SESSION_TZ_OFFSET_MIN) ?? 540;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let count = 0;
    let winCount = 0;
    let lossCount = 0;
    let pnlSum = 0;
    let winPnlSum = 0;
    let lossPnlSum = 0;
    let notionalSum = 0;
    let notionalCount = 0;
    let holdMsSum = 0;
    let holdMsCount = 0;
    let captureSum = 0;
    let captureCount = 0;
    let captureLowCount = 0;
    let regretSum = 0;
    let regretCount = 0;
    let regretOver1Count = 0;
    let tpSourceSrNext = 0;
    let tpSourceChannelEdge = 0;
    let tpSourceOther = 0;
    let tp = 0;
    let sl = 0;
    let timeout = 0;
    let other = 0;
    let timeoutLossOnly = 0;
    let hardSl = 0;
    let softSl = 0;
    let tp1Partial = 0;
    let stressCutLoss = 0;
    let tpModeRail = 0;
    let tpModeStretch = 0;
    let tpModeUnknown = 0;
    const sessions = {
      asia: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 },
      eu: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 },
      us: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 },
      off: { count: 0, pnlSum: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0 }
    };
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || line[0] !== '{') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const ts = toNumber(row?.timestampExit ?? row?.exitTs ?? row?.ts ?? row?.timestamp);
      if (!Number.isFinite(ts) || ts < fromTs || ts > nowTs) continue;
      const pnl = toNumber(row?.realizedPnlNetUsd ?? row?.realizedPnlUsd ?? row?.pnl);
      if (pnl == null) continue;
      count += 1;
      pnlSum += pnl;
      if (pnl > 0) {
        winCount += 1;
        winPnlSum += pnl;
      }
      if (pnl < 0) {
        lossCount += 1;
        lossPnlSum += pnl;
      }
      const notional = toNumber(row?.notional);
      if (notional != null && notional > 0) {
        notionalSum += notional;
        notionalCount += 1;
      }
      const holdMs = toNumber(row?.holdMs);
      if (holdMs != null && holdMs >= 0) {
        holdMsSum += holdMs;
        holdMsCount += 1;
      }
      const capture = toNumber(row?.captureRatio);
      if (capture != null && capture >= 0) {
        captureSum += capture;
        captureCount += 1;
        if (capture < 0.5) captureLowCount += 1;
      }
      const regret = toNumber(row?.regretMaxUsd);
      if (regret != null && regret >= 0) {
        regretSum += regret;
        regretCount += 1;
        if (regret >= 1.0) regretOver1Count += 1;
      }
      const tpSource = String(row?.plannedTpSource ?? '').toLowerCase();
      if (tpSource === 'sr_next') tpSourceSrNext += 1;
      else if (tpSource === 'channel_edge') tpSourceChannelEdge += 1;
      else tpSourceOther += 1;
      const exitReason = String(row?.exitReason ?? '').toUpperCase();
      const signal = String(row?.signal ?? '').toLowerCase();
      const tpMode = String(row?.tpMode ?? '').toLowerCase();
      const session = resolveSessionFromTs(ts, tzOffsetMin);
      if (exitReason === 'TP') tp += 1;
      else if (exitReason === 'SL') sl += 1;
      else if (exitReason === 'TIMEOUT') timeout += 1;
      else other += 1;
      if (signal === 'timeout_loss_only') timeoutLossOnly += 1;
      if (signal === 'hard_sl_ratio') hardSl += 1;
      if (signal === 'soft_sl_timeout') softSl += 1;
      if (signal === 'tp1_partial') tp1Partial += 1;
      if (signal === 'stress_cut_loss') stressCutLoss += 1;
      const sess = sessions[session] || sessions.off;
      sess.count += 1;
      sess.pnlSum += pnl;
      if (signal === 'timeout_loss_only') sess.timeoutLossOnly += 1;
      if (exitReason === 'TP') sess.tp += 1;
      if (signal === 'stress_cut_loss') sess.stressCutLoss += 1;
      if (tpMode === 'rail') tpModeRail += 1;
      else if (tpMode === 'rail+holdstretch') tpModeStretch += 1;
      else tpModeUnknown += 1;
    }
    if (count > stats.count) {
      stats.source = filePath;
      stats.count = count;
      stats.winCount = winCount;
      stats.lossCount = lossCount;
      stats.pnlSum = pnlSum;
      stats.avgPnl = count > 0 ? pnlSum / count : 0;
      stats.avgNotional = notionalCount > 0 ? notionalSum / notionalCount : 0;
      stats.avgWinPnl = winCount > 0 ? winPnlSum / winCount : 0;
      stats.avgLossPnl = lossCount > 0 ? lossPnlSum / lossCount : 0;
      stats.avgHoldMs = holdMsCount > 0 ? holdMsSum / holdMsCount : 0;
      stats.avgCaptureRatio = captureCount > 0 ? (captureSum / captureCount) : null;
      stats.captureLowRate = captureCount > 0 ? (captureLowCount / captureCount) : null;
      stats.avgRegretUsd = regretCount > 0 ? (regretSum / regretCount) : null;
      stats.regretOver1Rate = regretCount > 0 ? (regretOver1Count / regretCount) : null;
      stats.tpSource = {
        srNext: tpSourceSrNext,
        channelEdge: tpSourceChannelEdge,
        other: tpSourceOther
      };
      stats.exit = {
        tp,
        sl,
        timeout,
        other,
        timeoutLossOnly,
        hardSl,
        softSl,
        tp1Partial,
        stressCutLoss
      };
      stats.tpMode = {
        rail: tpModeRail,
        stretch: tpModeStretch,
        unknown: tpModeUnknown
      };
      stats.sessions = sessions;
    }
  }
  return stats;
}

async function analyzeLogFile(filePath, opts = {}) {
  const nowTs = Date.now();
  const windowMs = Number.isFinite(opts.windowMin) && opts.windowMin > 0
    ? opts.windowMin * 60 * 1000
    : null;
  const windowFromTs = windowMs != null ? nowTs - windowMs : null;
  const stats = {
    totalDecisionTrace: 0,
    entryCount: 0,
    noneCount: 0,
    toxicStopCount: 0,
    outsideArenaCount: 0,
    spreadBps: [],
    velocityBps: [],
    edgeScore: [],
    qualityScore: [],
    metaScore: [],
    metaSpread: [],
    metaVelocity: [],
    metaShock: [],
    microSpreadEntry: [],
    microVelocityEntry: [],
    microShockEntry: [],
    regime: {
      up: 0,
      down: 0,
      range: 0,
      none: 0
    },
    entryModes: {
      maker: 0,
      taker: 0
    },
    reasonCounts: {
      bMidPosition: 0,
      aRangeTooNarrow: 0,
      aNotReadyBar1h: 0,
      bBar1hSpanFloorUnmet: 0,
      bNoStructuralTp: 0,
      bNoStructuralPath: 0,
      bLowExecutionQuality: 0
    },
    bar1hSpanFloorUnmet: []
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (row?.type !== 'decision_trace') continue;
    const payload = row?.payload ?? {};
    const ts = toNumber(payload?.ts) ?? toNumber(row?.ts);
    if (windowFromTs != null && Number.isFinite(ts) && ts < windowFromTs) continue;
    const decision = payload?.decision ?? {};
    const context = payload?.context ?? {};
    const bResult = context?.bResult ?? {};
    const metaGate = context?.metaGate ?? null;
    const marketMicro = context?.marketMicro ?? null;
    const aRegimeRaw = String(context?.aResult?.regime ?? '').toLowerCase();

    stats.totalDecisionTrace += 1;
    const side = typeof decision?.side === 'string' ? decision.side.toLowerCase() : 'none';
    if (side === 'none') stats.noneCount += 1;
    else {
      stats.entryCount += 1;
      const mode = String(bResult?.entryProfile?.mode ?? '').toLowerCase();
      if (mode === 'maker') stats.entryModes.maker += 1;
      else if (mode === 'taker') stats.entryModes.taker += 1;
    }

    const reason = String(decision?.reason ?? '');
    const reasonLower = reason.toLowerCase();
    if (reasonLower.includes('meta_toxic_flow')) stats.toxicStopCount += 1;
    if (reasonLower.includes('b: outside a arena')) stats.outsideArenaCount += 1;
    if (reasonLower.includes('b: mid position')) stats.reasonCounts.bMidPosition += 1;
    if (reasonLower.includes('a: range too narrow')) stats.reasonCounts.aRangeTooNarrow += 1;
    if (reasonLower.includes('a: bar1h not ready')) stats.reasonCounts.aNotReadyBar1h += 1;
    if (reasonLower.includes('b: bar1h span floor unmet')) {
      stats.reasonCounts.bBar1hSpanFloorUnmet += 1;
      const arenaTop = toNumber(context?.aResult?.arena?.channelTop);
      const arenaBottom = toNumber(context?.aResult?.arena?.channelBottom);
      const span = (arenaTop != null && arenaBottom != null) ? (arenaTop - arenaBottom) : null;
      if (span != null && span > 0) stats.bar1hSpanFloorUnmet.push(span);
    }
    if (reasonLower.includes('b: no structural tp')) stats.reasonCounts.bNoStructuralTp += 1;
    if (reasonLower.includes('b: no structural path')) stats.reasonCounts.bNoStructuralPath += 1;
    if (reasonLower.includes('b: low execution quality')) stats.reasonCounts.bLowExecutionQuality += 1;
    if (aRegimeRaw === 'up') stats.regime.up += 1;
    else if (aRegimeRaw === 'down') stats.regime.down += 1;
    else if (aRegimeRaw === 'range') stats.regime.range += 1;
    else stats.regime.none += 1;

    const entryProfile = bResult?.entryProfile ?? null;
    const spread = toNumber(entryProfile?.spreadBps);
    const velocity = toNumber(entryProfile?.velocityBps);
    const quality = toNumber(entryProfile?.entryQualityScore);
    const edge = toNumber(bResult?.sizeFactors?.edgeScore);
    if (spread != null) stats.spreadBps.push(spread);
    if (velocity != null) stats.velocityBps.push(velocity);
    if (quality != null) stats.qualityScore.push(quality);
    if (edge != null) stats.edgeScore.push(edge);

    const mScore = toNumber(metaGate?.score);
    const mSpread = toNumber(metaGate?.diagnostics?.spreadBps);
    const mVelocity = toNumber(metaGate?.diagnostics?.priceVelocityBps);
    const mShock = toNumber(metaGate?.diagnostics?.cShock);
    if (mScore != null) stats.metaScore.push(mScore);
    if (mSpread != null) stats.metaSpread.push(mSpread);
    if (mVelocity != null) stats.metaVelocity.push(mVelocity);
    if (mShock != null) stats.metaShock.push(mShock);

    if (side !== 'none') {
      const ms = toNumber(marketMicro?.spreadBps);
      const mv = toNumber(marketMicro?.velocityBps);
      const mc = toNumber(marketMicro?.cShock);
      if (ms != null) stats.microSpreadEntry.push(ms);
      if (mv != null) stats.microVelocityEntry.push(mv);
      if (mc != null) stats.microShockEntry.push(mc);
    }
  }
  return stats;
}

async function analyzeLogFiles(filePaths, opts = {}) {
  const merged = {
    totalDecisionTrace: 0,
    entryCount: 0,
    noneCount: 0,
    toxicStopCount: 0,
    outsideArenaCount: 0,
    spreadBps: [],
    velocityBps: [],
    edgeScore: [],
    qualityScore: [],
    metaScore: [],
    metaSpread: [],
    metaVelocity: [],
    metaShock: [],
    microSpreadEntry: [],
    microVelocityEntry: [],
    microShockEntry: [],
    regime: { up: 0, down: 0, range: 0, none: 0 },
    entryModes: { maker: 0, taker: 0 },
    reasonCounts: {
      bMidPosition: 0,
      aRangeTooNarrow: 0,
      aNotReadyBar1h: 0,
      bBar1hSpanFloorUnmet: 0,
      bNoStructuralTp: 0,
      bNoStructuralPath: 0,
      bLowExecutionQuality: 0
    },
    bar1hSpanFloorUnmet: []
  };
  for (const filePath of filePaths) {
    const s = await analyzeLogFile(filePath, opts);
    merged.totalDecisionTrace += s.totalDecisionTrace;
    merged.entryCount += s.entryCount;
    merged.noneCount += s.noneCount;
    merged.toxicStopCount += s.toxicStopCount;
    merged.outsideArenaCount += s.outsideArenaCount;
    merged.spreadBps.push(...s.spreadBps);
    merged.velocityBps.push(...s.velocityBps);
    merged.edgeScore.push(...s.edgeScore);
    merged.qualityScore.push(...s.qualityScore);
    merged.metaScore.push(...s.metaScore);
    merged.metaSpread.push(...s.metaSpread);
    merged.metaVelocity.push(...s.metaVelocity);
    merged.metaShock.push(...s.metaShock);
    merged.microSpreadEntry.push(...s.microSpreadEntry);
    merged.microVelocityEntry.push(...s.microVelocityEntry);
    merged.microShockEntry.push(...s.microShockEntry);
    merged.regime.up += s.regime.up;
    merged.regime.down += s.regime.down;
    merged.regime.range += s.regime.range;
    merged.regime.none += s.regime.none;
    merged.entryModes.maker += s.entryModes.maker;
    merged.entryModes.taker += s.entryModes.taker;
    merged.reasonCounts.bMidPosition += s.reasonCounts.bMidPosition;
    merged.reasonCounts.aRangeTooNarrow += s.reasonCounts.aRangeTooNarrow;
    merged.reasonCounts.aNotReadyBar1h += s.reasonCounts.aNotReadyBar1h;
    merged.reasonCounts.bBar1hSpanFloorUnmet += s.reasonCounts.bBar1hSpanFloorUnmet;
    merged.reasonCounts.bNoStructuralTp += s.reasonCounts.bNoStructuralTp;
    merged.reasonCounts.bNoStructuralPath += s.reasonCounts.bNoStructuralPath;
    merged.reasonCounts.bLowExecutionQuality += s.reasonCounts.bLowExecutionQuality;
    merged.bar1hSpanFloorUnmet.push(...(s.bar1hSpanFloorUnmet ?? []));
  }
  return merged;
}

function resolveCapitalProfile(capitalUsd, current) {
  const profileRoot = current?.autoTuner?.capitalProfiles ?? {};
  const defaults = {
    micro: { maxCapitalUsd: 300, riskRatio: 0.012, minNotionalRatio: 0.14, maxNotionalRatio: 0.50 },
    standard: { maxCapitalUsd: 3000, riskRatio: 0.018, minNotionalRatio: 0.22, maxNotionalRatio: 0.78 },
    growth: { maxCapitalUsd: 7000, riskRatio: 0.015, minNotionalRatio: 0.18, maxNotionalRatio: 0.68 },
    scale: { maxCapitalUsd: 1e9, riskRatio: 0.012, minNotionalRatio: 0.14, maxNotionalRatio: 0.55 }
  };
  const merged = {
    micro: { ...defaults.micro, ...(profileRoot.micro ?? {}) },
    standard: { ...defaults.standard, ...(profileRoot.standard ?? {}) },
    growth: { ...defaults.growth, ...(profileRoot.growth ?? {}) },
    scale: { ...defaults.scale, ...(profileRoot.scale ?? {}) }
  };
  if (capitalUsd <= merged.micro.maxCapitalUsd) return { stage: 'micro', cfg: merged.micro };
  if (capitalUsd <= merged.standard.maxCapitalUsd) return { stage: 'standard', cfg: merged.standard };
  if (capitalUsd <= merged.growth.maxCapitalUsd) return { stage: 'growth', cfg: merged.growth };
  return { stage: 'scale', cfg: merged.scale };
}

function resolveCapitalStageBand(capitalUsd, current) {
  const root = current?.capitalStages;
  if (!root || root.enabled !== true || !Array.isArray(root.bands) || root.bands.length === 0) {
    return null;
  }
  const bands = root.bands
    .map((b) => ({
      name: String(b?.name ?? ''),
      upTo: toNumber(b?.upToEquityUsd),
      min: toNumber(b?.lotMinRatio),
      max: toNumber(b?.lotMaxRatio)
    }))
    .filter((b) => b.min != null && b.max != null)
    .sort((a, b) => {
      const aa = a.upTo == null ? Number.POSITIVE_INFINITY : a.upTo;
      const bb = b.upTo == null ? Number.POSITIVE_INFINITY : b.upTo;
      return aa - bb;
    });
  if (bands.length === 0) return null;
  for (const b of bands) {
    if (b.upTo == null || capitalUsd <= b.upTo) {
      return {
        name: b.name || 'stage',
        min: clamp(Math.min(b.min, b.max), 0.08, 0.99),
        max: clamp(Math.max(b.min, b.max), 0.08, 0.99)
      };
    }
  }
  const last = bands[bands.length - 1];
  return {
    name: last.name || 'stage',
    min: clamp(Math.min(last.min, last.max), 0.08, 0.99),
    max: clamp(Math.max(last.min, last.max), 0.08, 0.99)
  };
}

function proposeSettings(stats, current, extras = {}) {
  const spreadSource = stats.spreadBps.length > 0 ? stats.spreadBps : stats.microSpreadEntry;
  const velocitySource = stats.velocityBps.length > 0 ? stats.velocityBps : stats.microVelocityEntry;
  const shockSource = stats.metaShock.length > 0 ? stats.metaShock : stats.microShockEntry;
  const spreadSorted = [...spreadSource].sort((a, b) => a - b);
  const velocitySorted = [...velocitySource].sort((a, b) => a - b);
  const qualitySorted = [...stats.qualityScore].sort((a, b) => a - b);
  const metaScoreSorted = [...stats.metaScore].sort((a, b) => a - b);
  const metaSpreadSorted = [...stats.metaSpread].sort((a, b) => a - b);
  const metaVelocitySorted = [...stats.metaVelocity].sort((a, b) => a - b);
  const metaShockSorted = [...shockSource].sort((a, b) => a - b);

  const p60Spread = percentile(spreadSorted, 0.60);
  const p85Spread = percentile(spreadSorted, 0.85);
  const p60Velocity = percentile(velocitySorted, 0.60);
  const p85Velocity = percentile(velocitySorted, 0.85);
  const p30Quality = percentile(qualitySorted, 0.30);
  const p70Quality = percentile(qualitySorted, 0.70);

  const p80MetaScore = percentile(metaScoreSorted, 0.80);
  const p90MetaSpread = percentile(metaSpreadSorted.length > 0 ? metaSpreadSorted : spreadSorted, 0.90);
  const p90MetaVelocity = percentile(metaVelocitySorted.length > 0 ? metaVelocitySorted : velocitySorted, 0.90);
  const p90MetaShock = percentile(metaShockSorted, 0.90);

  const next = JSON.parse(JSON.stringify(current));
  if (!next.b2Upgrade) next.b2Upgrade = {};
  if (!next.b2Upgrade.executionModel) next.b2Upgrade.executionModel = {};
  if (!next.b2Upgrade.execution) next.b2Upgrade.execution = {};
  if (!next.b2Upgrade.adaptiveSize) next.b2Upgrade.adaptiveSize = {};
  if (!next.b2Upgrade.ladderAttack) next.b2Upgrade.ladderAttack = {};
  if (!next.b2Upgrade.higherTfControl) next.b2Upgrade.higherTfControl = {};
  if (!next.metaGate) next.metaGate = {};

  if (p60Spread != null) next.b2Upgrade.execution.makerMaxSpreadBps = clamp(p60Spread * 1.05, 0.2, 5);
  if (p60Velocity != null) next.b2Upgrade.execution.makerMaxVelocityBps = clamp(p60Velocity * 1.05, 0.2, 5);
  if (p85Spread != null) next.b2Upgrade.execution.maxSpreadBps = clamp(p85Spread * 1.15, 0.5, 8);
  if (p85Velocity != null) next.b2Upgrade.execution.maxVelocityBps = clamp(p85Velocity * 1.15, 0.5, 8);

  if (p30Quality != null) next.b2Upgrade.adaptiveSize.minScalar = clamp(0.75 + p30Quality * 0.3, 0.6, 1.0);
  if (p70Quality != null) next.b2Upgrade.adaptiveSize.maxScalar = clamp(1.05 + p70Quality * 0.35, 1.0, 1.6);

  if (p90MetaSpread != null) next.metaGate.maxSpreadBps = clamp(p90MetaSpread * 1.1, 0.5, 8);
  if (p90MetaVelocity != null) next.metaGate.maxPriceVelocityBps = clamp(p90MetaVelocity * 1.1, 0.5, 8);
  if (p90MetaShock != null) next.metaGate.maxCShock = clamp(p90MetaShock * 1.1, 0.1, 2);
  if (p80MetaScore != null) next.metaGate.toxicityThreshold = clamp(p80MetaScore, 0.6, 2.5);

  // Entry-frequency adaptive tuning (safe, small-step):
  // - widen B edge zone when "B: mid position" dominates
  // - relax A range floor when "A: range too narrow" dominates
  if (!next.b2Upgrade.edgeControl) next.b2Upgrade.edgeControl = {};
  if (!next.rangeFilter) next.rangeFilter = {};
  if (!next.lot) next.lot = {};
  const total = Math.max(1, stats.totalDecisionTrace);
  const noneRate = stats.noneCount / total;
  const bMidRate = (stats.reasonCounts?.bMidPosition ?? 0) / total;
  const aRangeNarrowRate = (stats.reasonCounts?.aRangeTooNarrow ?? 0) / total;
  const aBar1hNotReadyRate = (stats.reasonCounts?.aNotReadyBar1h ?? 0) / total;
  const bNoStructuralTpRate = (stats.reasonCounts?.bNoStructuralTp ?? 0) / total;
  const bNoStructuralPathRate = (stats.reasonCounts?.bNoStructuralPath ?? 0) / total;
  const bLowExecutionQualityRate = (stats.reasonCounts?.bLowExecutionQuality ?? 0) / total;
  const bBar1hSpanFloorUnmetRate = (stats.reasonCounts?.bBar1hSpanFloorUnmet ?? 0) / total;

  const useDistanceEntry = (current?.b2Upgrade?.executionModel?.enabled === true)
    ? (current?.b2Upgrade?.executionModel?.useDistanceEntry !== false)
    : true;
  const curBaseRatio = toNumber(current?.b2Upgrade?.edgeControl?.baseRatio);
  const curMinRangeUsd = toNumber(current?.rangeFilter?.minRangeUsd);
  if (curBaseRatio != null && useDistanceEntry) {
    let edgeRatio = curBaseRatio;
    // Expand only when misses are structurally high and not dominated by warm-up.
    if (noneRate >= 0.97 && bMidRate >= 0.35 && aBar1hNotReadyRate < 0.2) {
      edgeRatio += 0.02;
    } else if (noneRate >= 0.94 && bMidRate >= 0.20 && aBar1hNotReadyRate < 0.2) {
      edgeRatio += 0.01;
    } else if (noneRate <= 0.75 && bMidRate <= 0.05) {
      // If entries are already frequent, gently tighten.
      edgeRatio -= 0.01;
    }
    next.b2Upgrade.edgeControl.baseRatio = clamp(edgeRatio, 0.08, 0.25);
  }

  if (curMinRangeUsd != null) {
    let minRange = curMinRangeUsd;
    if (noneRate >= 0.97 && aRangeNarrowRate >= 0.20) {
      minRange -= 15;
    } else if (noneRate >= 0.94 && aRangeNarrowRate >= 0.10) {
      minRange -= 10;
    } else if (noneRate <= 0.70 && aRangeNarrowRate <= 0.01) {
      minRange += 5;
    }
    next.rangeFilter.minRangeUsd = clamp(Math.round(minRange), 60, 220);
  }

  // TP-path formation tuning for viewpoint (small steps):
  // relax when "no structural tp/path" dominates, tighten slightly on quality stress.
  if (!next.viewpoint || typeof next.viewpoint !== 'object') next.viewpoint = {};
  let vpMinStepUsd = toNumber(next?.viewpoint?.minStepUsd ?? current?.viewpoint?.minStepUsd ?? 90) ?? 90;
  let vpBar15mWeight = toNumber(next?.viewpoint?.bar15mRangeWeight ?? current?.viewpoint?.bar15mRangeWeight ?? 0.6) ?? 0.6;
  let vpNearRetryFactor = toNumber(next?.viewpoint?.nearRetryFactor ?? current?.viewpoint?.nearRetryFactor ?? 0.6) ?? 0.6;
  let vpNearRetryMinUsd = toNumber(next?.viewpoint?.nearRetryMinUsd ?? current?.viewpoint?.nearRetryMinUsd ?? 20) ?? 20;

  if (bNoStructuralTpRate >= 0.55 || bNoStructuralPathRate >= 0.25) {
    vpMinStepUsd -= 8;
    vpBar15mWeight -= 0.05;
    vpNearRetryFactor += 0.05;
    vpNearRetryMinUsd -= 2;
  } else if (bNoStructuralTpRate <= 0.20 && bLowExecutionQualityRate >= 0.10) {
    vpMinStepUsd += 4;
    vpBar15mWeight += 0.03;
  }

  next.viewpoint.minStepUsd = Math.round(clamp(vpMinStepUsd, 40, 180));
  next.viewpoint.bar15mRangeWeight = clamp(vpBar15mWeight, 0.2, 1.2);
  next.viewpoint.nearRetryFactor = clamp(vpNearRetryFactor, 0.30, 0.90);
  next.viewpoint.nearRetryMinUsd = Math.round(clamp(vpNearRetryMinUsd, 8, 40));

  // bar1h span-floor tuning (small, bounded steps).
  if (!next.bar1h || typeof next.bar1h !== 'object') next.bar1h = {};
  if (!next.bar1h.adaptive || typeof next.bar1h.adaptive !== 'object') next.bar1h.adaptive = {};
  const spanUnmetSamples = Array.isArray(stats.bar1hSpanFloorUnmet)
    ? stats.bar1hSpanFloorUnmet.filter((v) => Number.isFinite(v) && v > 0)
    : [];
  const spanUnmetSorted = [...spanUnmetSamples].sort((a, b) => a - b);
  const spanUnmetCount = spanUnmetSorted.length;
  const spanUnmetP50 = percentile(spanUnmetSorted, 0.50);
  const spanUnmetP70 = percentile(spanUnmetSorted, 0.70);
  const spanUnmetP85 = percentile(spanUnmetSorted, 0.85);
  let minFinalSpanUsd = toNumber(
    next?.bar1h?.adaptive?.minFinalSpanUsd
      ?? current?.bar1h?.adaptive?.minFinalSpanUsd
      ?? 1700
  ) ?? 1700;
  if (spanUnmetCount >= 200 && bBar1hSpanFloorUnmetRate >= 0.20) {
    let targetMinFinalSpan = minFinalSpanUsd;
    if (bBar1hSpanFloorUnmetRate >= 0.85 && spanUnmetP50 != null) {
      targetMinFinalSpan = spanUnmetP50 + 10;
    } else if (bBar1hSpanFloorUnmetRate >= 0.60 && spanUnmetP70 != null) {
      targetMinFinalSpan = spanUnmetP70 + 15;
    } else if (spanUnmetP85 != null) {
      targetMinFinalSpan = spanUnmetP85 + 20;
    }
    // Lower faster when blocked heavily, raise slowly.
    const delta = clamp(targetMinFinalSpan - minFinalSpanUsd, -120, 40);
    minFinalSpanUsd += delta;
  }
  next.bar1h.adaptive.minFinalSpanUsd = Math.round(clamp(minFinalSpanUsd, 1600, 2000));

  // Capital-aware lot/risk tuning (market + account stage).
  const capitalUsd = toNumber(extras.capitalUsd) ?? 2000;
  const tradeStats = extras.tradeStats ?? {};
  const profile = resolveCapitalProfile(capitalUsd, current);
  const stageBand = resolveCapitalStageBand(capitalUsd, current);
  const autoTunerCfg = current?.autoTuner && typeof current.autoTuner === 'object'
    ? current.autoTuner
    : {};
  const fullAutoEnabled = autoTunerCfg?.fullAuto?.enabled === true;
  const lotTuningEnabled = fullAutoEnabled || autoTunerCfg?.lotTuning?.enabled === true;
  let riskRatio = toNumber(profile.cfg?.riskRatio ?? current?.riskRatio ?? 0.02) ?? 0.02;
  let minNotionalRatio = toNumber(current?.lot?.minNotionalRatio ?? 0.3) ?? 0.3;
  let maxNotionalRatio = toNumber(current?.lot?.maxNotionalRatio ?? 0.9) ?? 0.9;
  if (lotTuningEnabled) {
    minNotionalRatio = toNumber(profile.cfg?.minNotionalRatio ?? minNotionalRatio) ?? minNotionalRatio;
    maxNotionalRatio = toNumber(profile.cfg?.maxNotionalRatio ?? maxNotionalRatio) ?? maxNotionalRatio;
  }

  const entryRate = stats.totalDecisionTrace > 0 ? stats.entryCount / stats.totalDecisionTrace : 0;
  const winRate = tradeStats.count > 0 ? tradeStats.winCount / tradeStats.count : null;
  const avgPnl = toNumber(tradeStats.avgPnl);
  const avgNotional = toNumber(tradeStats.avgNotional);
  const pnlPer100 = (avgPnl != null && avgNotional != null && avgNotional > 0) ? (avgPnl / avgNotional) * 100 : null;
  const makerEntries = Number(stats?.entryModes?.maker ?? 0);
  const takerEntries = Number(stats?.entryModes?.taker ?? 0);
  const modeTotal = Math.max(1, makerEntries + takerEntries);
  const makerRate = makerEntries / modeTotal;
  const takerRate = takerEntries / modeTotal;
  const feeCfg = current?.autoTuner?.fees ?? {};
  const makerFeeBps = clamp(toNumber(feeCfg.makerFeeBps ?? 1.44), 0.01, 20);
  const takerFeeBps = clamp(toNumber(feeCfg.takerFeeBps ?? 4.32), 0.01, 30);
  const oneWaySlippageBps = clamp(toNumber(feeCfg.oneWaySlippageBps ?? 0.5), 0, 20);
  // Conservative round-trip edge cost: blended fee on both sides + slippage on both sides.
  const blendedEntryBps = makerRate * makerFeeBps + takerRate * takerFeeBps;
  const roundTripCostBps = (blendedEntryBps * 2) + (oneWaySlippageBps * 2);
  const costPer100 = roundTripCostBps * 0.01; // bps -> USD per 100 notional
  const netPnlPer100 = pnlPer100 != null ? (pnlPer100 - costPer100) : null;

  // Regime multipliers first.
  if (lotTuningEnabled && extras.regime === 'trend') {
    riskRatio *= 1.06;
    maxNotionalRatio += 0.04;
  } else if (lotTuningEnabled && extras.regime === 'range') {
    riskRatio *= 0.94;
    maxNotionalRatio -= 0.04;
  } else if (lotTuningEnabled && extras.regime === 'high_vol') {
    riskRatio *= 0.82;
    minNotionalRatio -= 0.03;
    maxNotionalRatio -= 0.10;
  }

  // Performance + activity multipliers.
  if (winRate != null && netPnlPer100 != null) {
    if (winRate >= 0.58 && netPnlPer100 > 0.02) {
      riskRatio *= 1.08;
      if (lotTuningEnabled) {
        maxNotionalRatio += 0.05;
        minNotionalRatio += 0.01;
      }
    } else if (winRate < 0.46 || netPnlPer100 < -0.005) {
      riskRatio *= 0.86;
      if (lotTuningEnabled) {
        maxNotionalRatio -= 0.08;
        minNotionalRatio -= 0.03;
      }
    }
  }
  if (lotTuningEnabled && entryRate < 0.004) {
    // Very low activity: widen max a bit to improve per-trade payoff.
    maxNotionalRatio += 0.03;
  }

  next.riskRatio = clamp(riskRatio, 0.005, 0.04);
  if (next?.b2Upgrade?.executionModel) {
    const qFloor = p30Quality != null ? clamp(p30Quality * 0.85, 0.18, 0.6) : 0.33;
    next.b2Upgrade.executionModel.minEntryQuality = qFloor;
    const baseMapStrength = toNumber(current?.b2Upgrade?.executionModel?.minMapStrength ?? 0.2) ?? 0.2;
    let mapStrength = baseMapStrength;
    if (stats.noneCount > 0 && stats.totalDecisionTrace > 0) {
      const noneRateNow = stats.noneCount / Math.max(1, stats.totalDecisionTrace);
      if (noneRateNow > 0.995) mapStrength -= 0.03;
      else if (noneRateNow < 0.90) mapStrength += 0.01;
    }
    next.b2Upgrade.executionModel.minMapStrength = clamp(mapStrength, 0.05, 0.45);
  }
  let minRatioSafe = clamp(minNotionalRatio, 0.08, 0.95);
  let maxRatioSafe = clamp(Math.max(minRatioSafe + 0.01, maxNotionalRatio), 0.2, 0.99);
  // Do not let lot auto-tune escape configured capital-stage band.
  if (lotTuningEnabled && stageBand) {
    minRatioSafe = clamp(minRatioSafe, stageBand.min, stageBand.max);
    maxRatioSafe = clamp(maxRatioSafe, stageBand.min, stageBand.max);
    if (maxRatioSafe < minRatioSafe) maxRatioSafe = minRatioSafe;
  }
  next.lot.minNotionalRatio = minRatioSafe;
  next.lot.maxNotionalRatio = maxRatioSafe;
  // Raise/lower minExpectedUsd to reflect estimated edge cost (gross threshold).
  const feeSafetyMul = clamp(toNumber(feeCfg.feeSafetyMul ?? 1.8), 1.0, 4.0);
  if (avgNotional != null && avgNotional > 0) {
    const estimatedRoundTripFeeUsd = avgNotional * (roundTripCostBps / 10000);
    next.minExpectedUsd = clamp(estimatedRoundTripFeeUsd * feeSafetyMul, 4, 40);
    if (!next.feeEdgeGuard || typeof next.feeEdgeGuard !== 'object') next.feeEdgeGuard = {};
    const edgeUsdSafetyMul = clamp(toNumber(feeCfg.edgeUsdSafetyMul ?? 1.2), 0.8, 3.0);
    const minNetUsdCandidate = estimatedRoundTripFeeUsd * edgeUsdSafetyMul;
    next.feeEdgeGuard.minNetUsd = clamp(minNetUsdCandidate, 1.0, 6.0);
    next.feeEdgeGuard.minNetPer100Notional = clamp(costPer100 * 0.35, 0.01, 0.15);
  }
  if (!next.feeEdgeGuard || typeof next.feeEdgeGuard !== 'object') next.feeEdgeGuard = {};
  const feeEdgePinnedOff = !fullAutoEnabled
    && current?.feeEdgeGuard?.enabled === false
    && autoTunerCfg?.allowFeeEdgeGuardEnable !== true;
  if (next.feeEdgeGuard.exitMode == null) next.feeEdgeGuard.exitMode = 'taker';
  if (feeEdgePinnedOff) {
    next.feeEdgeGuard.enabled = false;
  } else {
    if (next.feeEdgeGuard.enabled == null) next.feeEdgeGuard.enabled = false;
    if (winRate != null && netPnlPer100 != null) {
      if (netPnlPer100 < 0 || winRate < 0.48) {
        next.feeEdgeGuard.enabled = true;
      } else if (netPnlPer100 > 0.03 && winRate >= 0.55) {
        next.feeEdgeGuard.enabled = false;
      }
    }
  }

  // TP/SL/timeout adaptive tuning (phase-2).
  if (!next.b2 || typeof next.b2 !== 'object') next.b2 = {};
  if (!next.b2.hybridMode || typeof next.b2.hybridMode !== 'object') next.b2.hybridMode = {};
  if (!next.b2.tpSplit || typeof next.b2.tpSplit !== 'object') next.b2.tpSplit = {};
  const hybridEnabled = next?.b2?.hybridMode?.enabled !== false;
  if (!next.lossTimeout || typeof next.lossTimeout !== 'object') next.lossTimeout = {};
  if (!next.lossTimeout.dynamicRealtime || typeof next.lossTimeout.dynamicRealtime !== 'object') {
    next.lossTimeout.dynamicRealtime = {};
  }
  const exit = tradeStats.exit ?? {};
  const tCount = Math.max(1, Number(tradeStats.count ?? 0));
  const tpRate = (Number(exit.tp ?? 0)) / tCount;
  const slRate = (Number(exit.sl ?? 0)) / tCount;
  const timeoutRate = (Number(exit.timeout ?? 0)) / tCount;
  const timeoutLossRate = (Number(exit.timeoutLossOnly ?? 0)) / tCount;
  const hardSlRate = (Number(exit.hardSl ?? 0)) / tCount;
  const tp1PartialRate = (Number(exit.tp1Partial ?? 0)) / tCount;
  const stressCutRate = (Number(exit.stressCutLoss ?? 0)) / tCount;
  const avgHoldMs = Math.max(0, toNumber(tradeStats.avgHoldMs) ?? 0);
  const avgWinPnl = toNumber(tradeStats.avgWinPnl) ?? 0;
  const avgLossPnl = toNumber(tradeStats.avgLossPnl) ?? 0;
  const nowTs = Date.now();

  let tpStretch = toNumber(next?.b2?.tpStretch ?? current?.b2?.tpStretch ?? 1.4) ?? 1.4;
  let tpStretchHoldMs = toNumber(next?.b2?.tpStretchHoldMs ?? current?.b2?.tpStretchHoldMs ?? 90000) ?? 90000;
  let lossTimeoutMs = toNumber(next?.lossTimeout?.ms ?? current?.lossTimeout?.ms ?? 240000) ?? 240000;
  let softRatio = toNumber(next?.lossTimeout?.softRatio ?? current?.lossTimeout?.softRatio ?? 0.35) ?? 0.35;
  let hardRatio = toNumber(next?.lossTimeout?.hardRatio ?? current?.lossTimeout?.hardRatio ?? 0.55) ?? 0.55;
  let tpSplitCloseRatio = toNumber(next?.b2?.tpSplit?.closeRatio ?? current?.b2?.tpSplit?.closeRatio ?? 0.5) ?? 0.5;
  let stressExitMinHoldMs = toNumber(
    next?.lossTimeout?.dynamicRealtime?.stressExitMinHoldMs
      ?? current?.lossTimeout?.dynamicRealtime?.stressExitMinHoldMs
      ?? 15000
  ) ?? 15000;
  let stressExitMinAdverseRatio = toNumber(
    next?.lossTimeout?.dynamicRealtime?.stressExitMinAdverseRatio
      ?? current?.lossTimeout?.dynamicRealtime?.stressExitMinAdverseRatio
      ?? 0.08
  ) ?? 0.08;
  let earlyExitMinHoldMs = toNumber(
    next?.lossTimeout?.dynamicRealtime?.earlyExitMinHoldMs
      ?? current?.lossTimeout?.dynamicRealtime?.earlyExitMinHoldMs
      ?? 45000
  ) ?? 45000;
  let earlyExitProgressMax = toNumber(
    next?.lossTimeout?.dynamicRealtime?.earlyExitProgressMax
      ?? current?.lossTimeout?.dynamicRealtime?.earlyExitProgressMax
      ?? 0.22
  ) ?? 0.22;
  let adaptiveMinScalar = toNumber(next?.b2Upgrade?.adaptiveSize?.minScalar ?? current?.b2Upgrade?.adaptiveSize?.minScalar ?? 0.85) ?? 0.85;
  let adaptiveMaxScalar = toNumber(next?.b2Upgrade?.adaptiveSize?.maxScalar ?? current?.b2Upgrade?.adaptiveSize?.maxScalar ?? 1.25) ?? 1.25;
  let ladderBoostMax = toNumber(next?.b2Upgrade?.ladderAttack?.boostMax ?? current?.b2Upgrade?.ladderAttack?.boostMax ?? 1.22) ?? 1.22;
  let higherTfSizeBoostMax = toNumber(next?.b2Upgrade?.higherTfControl?.sizeBoostMax ?? current?.b2Upgrade?.higherTfControl?.sizeBoostMax ?? 1.30) ?? 1.30;
  let higherTfTpBoostMax = toNumber(next?.b2Upgrade?.higherTfControl?.tpBoostMax ?? current?.b2Upgrade?.higherTfControl?.tpBoostMax ?? 1.20) ?? 1.20;
  const avgCaptureRatio = (tradeStats.avgCaptureRatio != null && Number.isFinite(Number(tradeStats.avgCaptureRatio)))
    ? Number(tradeStats.avgCaptureRatio)
    : null;
  const captureLowRate = (tradeStats.captureLowRate != null && Number.isFinite(Number(tradeStats.captureLowRate)))
    ? Number(tradeStats.captureLowRate)
    : null;
  const tpSource = tradeStats.tpSource ?? {};
  const tpSourceTotal = Math.max(1, Number(tpSource.srNext ?? 0) + Number(tpSource.channelEdge ?? 0) + Number(tpSource.other ?? 0));
  const srNextShare = Number(tpSource.srNext ?? 0) / tpSourceTotal;
  const avgRegretUsd = (tradeStats.avgRegretUsd != null && Number.isFinite(Number(tradeStats.avgRegretUsd)))
    ? Number(tradeStats.avgRegretUsd)
    : null;
  const regretOver1Rate = (tradeStats.regretOver1Rate != null && Number.isFinite(Number(tradeStats.regretOver1Rate)))
    ? Number(tradeStats.regretOver1Rate)
    : null;

  // If many timeout losses, cut stretch and close losers earlier.
  if (timeoutLossRate >= 0.20) {
    tpStretch -= 0.06;
    tpStretchHoldMs -= 10000;
    lossTimeoutMs -= 20000;
    softRatio -= 0.02;
    hardRatio -= 0.02;
    tpSplitCloseRatio += 0.05;
    stressExitMinHoldMs -= 1500;
    stressExitMinAdverseRatio -= 0.01;
  } else if (timeoutRate >= 0.45 && tpRate < 0.22) {
    // Timeout-heavy but not necessarily losing: reduce target distance moderately.
    tpStretch -= 0.04;
    tpStretchHoldMs -= 5000;
    tpSplitCloseRatio += 0.03;
  } else if (tpRate >= 0.30 && avgWinPnl > Math.abs(avgLossPnl) * 0.9 && winRate != null && winRate >= 0.52) {
    // TP is working and edge is acceptable: expand winners.
    tpStretch += 0.05;
    tpStretchHoldMs += 10000;
    lossTimeoutMs += 15000;
    tpSplitCloseRatio -= 0.03;
  }

  // tp1_partial and stress cut self-correction.
  if (tp1PartialRate >= 0.22 && tpRate < 0.16) {
    // Too many early partials without final TP conversion: let runners breathe.
    tpSplitCloseRatio -= 0.04;
  } else if (tp1PartialRate <= 0.05 && timeoutLossRate >= 0.18) {
    // Rare partials + timeout loss heavy: lock more at TP1.
    tpSplitCloseRatio += 0.04;
  }
  if (stressCutRate >= 0.18) {
    // Over-triggered stress exits -> relax.
    stressExitMinHoldMs += 1500;
    stressExitMinAdverseRatio += 0.01;
    earlyExitMinHoldMs += 2500;
    earlyExitProgressMax -= 0.015;
  } else if (stressCutRate <= 0.03 && timeoutLossRate >= 0.20) {
    // Not enough stress exits while timeout losses are high -> tighten.
    stressExitMinHoldMs -= 1000;
    stressExitMinAdverseRatio -= 0.008;
    earlyExitMinHoldMs -= 1500;
    earlyExitProgressMax += 0.01;
  }

  // Capture-ratio tuning: raise runner share when we are systematically under-capturing.
  if (avgCaptureRatio != null && captureLowRate != null) {
    if (avgCaptureRatio < 0.45 || captureLowRate >= 0.60) {
      tpSplitCloseRatio -= 0.05;
      tpStretch += 0.05;
      tpStretchHoldMs += 8000;
      earlyExitMinHoldMs += 4000;
      earlyExitProgressMax -= 0.02;
    } else if (avgCaptureRatio > 0.80 && timeoutLossRate >= 0.18) {
      tpSplitCloseRatio += 0.03;
      tpStretch -= 0.03;
      earlyExitMinHoldMs -= 2000;
      earlyExitProgressMax += 0.01;
    }
  }

  // If SR-driven exits are scarce, avoid over-stretching and prefer earlier conversion to realized PnL.
  if (srNextShare < 0.30 && tpRate < 0.25) {
    tpSplitCloseRatio += 0.03;
    tpStretch -= 0.03;
  }
  // Regret-aware tuning: high regret means exits are too early in favorable structures.
  if (avgRegretUsd != null && regretOver1Rate != null) {
    if (avgRegretUsd >= 0.35 || regretOver1Rate >= 0.25) {
      tpSplitCloseRatio -= 0.04;
      tpStretch += 0.05;
      tpStretchHoldMs += 10000;
      earlyExitMinHoldMs += 4000;
      earlyExitProgressMax -= 0.02;
    }
  }

  // Attack scalers: increase only when structure + execution quality support runner extension.
  const attackReady = srNextShare >= 0.50
    && tpRate >= 0.20
    && (avgRegretUsd == null || avgRegretUsd >= 0.20);
  const defensivePhase = timeoutLossRate >= 0.22
    || hardSlRate >= 0.18
    || (winRate != null && winRate < 0.45)
    || (netPnlPer100 != null && netPnlPer100 < -0.01);
  if (attackReady) {
    adaptiveMaxScalar += 0.05;
    ladderBoostMax += 0.04;
    higherTfSizeBoostMax += 0.04;
    higherTfTpBoostMax += 0.03;
    if (avgCaptureRatio != null && avgCaptureRatio < 0.45) {
      adaptiveMaxScalar += 0.02;
      ladderBoostMax += 0.02;
    }
  } else if (defensivePhase) {
    adaptiveMaxScalar -= 0.06;
    adaptiveMinScalar -= 0.02;
    ladderBoostMax -= 0.05;
    higherTfSizeBoostMax -= 0.06;
    higherTfTpBoostMax -= 0.04;
  }

  // Time-session balancing (auto): adjust toward weaker active session.
  const sessions = tradeStats.sessions ?? {};
  const sessionKeys = ['asia', 'eu', 'us', 'off'];
  const dominantSessionKey = sessionKeys.reduce((best, k) => {
    const cur = sessions[k]?.count ?? 0;
    const prev = sessions[best]?.count ?? 0;
    return cur > prev ? k : best;
  }, 'off');
  const dominantSession = sessions[dominantSessionKey] ?? { count: 0, timeoutLossOnly: 0, tp: 0, stressCutLoss: 0, pnlSum: 0 };
  const dominantCount = Math.max(0, Number(dominantSession.count ?? 0));
  const dominantSessionPnlUsd = toNumber(dominantSession.pnlSum) ?? 0;
  const sessionCfgRoot = current?.autoTuner?.sessionTuning ?? {};
  const sessionProfiles = sessionCfgRoot.profiles && typeof sessionCfgRoot.profiles === 'object'
    ? sessionCfgRoot.profiles
    : {};
  const dominantProfile = {
    ...defaultSessionProfile(dominantSessionKey),
    ...(sessionProfiles[dominantSessionKey] ?? {})
  };
  tpStretch *= clamp(toNumber(dominantProfile.tpStretchMul) ?? 1, 0.85, 1.20);
  lossTimeoutMs *= clamp(toNumber(dominantProfile.timeoutMsMul) ?? 1, 0.80, 1.25);
  tpSplitCloseRatio *= clamp(toNumber(dominantProfile.tpSplitCloseRatioMul) ?? 1, 0.85, 1.20);
  if (dominantCount >= Math.max(5, Math.floor(tCount * 0.3))) {
    const sessTimeoutLossRate = (Number(dominantSession.timeoutLossOnly ?? 0)) / dominantCount;
    const sessTpRate = (Number(dominantSession.tp ?? 0)) / dominantCount;
    const sessStressRate = (Number(dominantSession.stressCutLoss ?? 0)) / dominantCount;
    if (sessTimeoutLossRate >= 0.35) {
      lossTimeoutMs -= 10000;
      softRatio -= 0.01;
      hardRatio -= 0.01;
      tpSplitCloseRatio += 0.02;
      if (sessStressRate <= 0.03) {
        stressExitMinHoldMs -= 700;
        stressExitMinAdverseRatio -= 0.004;
      }
    } else if (sessTpRate >= 0.45 && sessTimeoutLossRate <= 0.18) {
      lossTimeoutMs += 7000;
      tpStretch += 0.03;
      tpSplitCloseRatio -= 0.02;
    }
  }

  // If hard SL dominates, tighten stop behavior; if rare, allow a little room.
  if (hardSlRate >= 0.18 || slRate >= 0.45) {
    softRatio -= 0.015;
    hardRatio -= 0.02;
  } else if (tpRate >= 0.35 && slRate <= 0.22 && avgHoldMs > 0 && avgHoldMs < lossTimeoutMs * 0.55) {
    softRatio += 0.01;
    hardRatio += 0.015;
  }

  next.b2.tpStretch = clamp(tpStretch, 1.0, 1.9);
  next.b2.tpStretchHoldMs = Math.round(clamp(tpStretchHoldMs, 30000, 240000));
  if (hybridEnabled) {
    next.b2.tpSplit.enabled = true;
    next.b2.tpSplit.closeRatio = clamp(tpSplitCloseRatio, 0.25, 0.75);
  } else {
    next.b2.tpSplit.enabled = false;
  }
  next.lossTimeout.ms = Math.round(clamp(lossTimeoutMs, 120000, 420000));
  next.lossTimeout.softRatio = clamp(softRatio, 0.20, 0.55);
  next.lossTimeout.hardRatio = clamp(Math.max(next.lossTimeout.softRatio + 0.08, hardRatio), 0.35, 0.80);
  next.lossTimeout.dynamicRealtime.stressExitMinHoldMs = Math.round(clamp(stressExitMinHoldMs, 5000, 60000));
  next.lossTimeout.dynamicRealtime.stressExitMinAdverseRatio = clamp(stressExitMinAdverseRatio, 0.04, 0.20);
  next.lossTimeout.dynamicRealtime.earlyExitMinHoldMs = Math.round(clamp(earlyExitMinHoldMs, 10000, 120000));
  next.lossTimeout.dynamicRealtime.earlyExitProgressMax = clamp(earlyExitProgressMax, 0.08, 0.50);
  next.b2Upgrade.adaptiveSize.minScalar = clamp(adaptiveMinScalar, 0.5, 1.0);
  next.b2Upgrade.adaptiveSize.maxScalar = clamp(Math.max(next.b2Upgrade.adaptiveSize.minScalar + 0.08, adaptiveMaxScalar), 1.0, 1.8);
  next.b2Upgrade.ladderAttack.boostMax = clamp(ladderBoostMax, 1.0, 1.8);
  next.b2Upgrade.higherTfControl.sizeBoostMax = clamp(higherTfSizeBoostMax, 1.0, 2.0);
  next.b2Upgrade.higherTfControl.tpBoostMax = clamp(higherTfTpBoostMax, 1.0, 1.8);
  // keep consistency for timeout helper.
  const softTimeoutMs = toNumber(next?.lossTimeout?.softTimeoutMs ?? current?.lossTimeout?.softTimeoutMs ?? 5000) ?? 5000;
  next.lossTimeout.softTimeoutMs = Math.round(clamp(softTimeoutMs, 1000, next.lossTimeout.ms));

  // Hybrid auto on/off with hysteresis and minimum hold time.
  if (!next.autoTuner || typeof next.autoTuner !== 'object') next.autoTuner = {};
  const hybridAuto = next.autoTuner.hybridAuto && typeof next.autoTuner.hybridAuto === 'object'
    ? next.autoTuner.hybridAuto
    : {};
  const hybridAutoEnabled = hybridAuto.enabled !== false;
  const hybridMinHoldMs = Math.max(30 * 60 * 1000, toNumber(hybridAuto.minHoldMs) ?? (2 * 60 * 60 * 1000));
  const lastSwitchTs = toNumber(hybridAuto.lastSwitchTs);
  const canSwitch = !(Number.isFinite(lastSwitchTs) && (nowTs - lastSwitchTs) < hybridMinHoldMs);
  const hybridCurrent = next?.b2?.hybridMode?.enabled !== false;
  const hybridOnSignal = (timeoutLossRate >= 0.18) || (netPnlPer100 != null && netPnlPer100 < 0 && tpRate < 0.45);
  const hybridOffSignal = (timeoutLossRate <= 0.12) && (tpRate >= 0.42) && (netPnlPer100 != null && netPnlPer100 > 0.01);
  let hybridSwitched = false;
  if (hybridAutoEnabled && canSwitch) {
    if (!hybridCurrent && hybridOnSignal) {
      next.b2.hybridMode.enabled = true;
      next.b2.tpSplit.enabled = true;
      hybridAuto.lastSwitchTs = nowTs;
      hybridSwitched = true;
    } else if (hybridCurrent && hybridOffSignal) {
      next.b2.hybridMode.enabled = false;
      next.b2.tpSplit.enabled = false;
      hybridAuto.lastSwitchTs = nowTs;
      hybridSwitched = true;
    }
  }
  hybridAuto.minHoldMs = hybridMinHoldMs;
  hybridAuto.enabled = hybridAutoEnabled;
  next.autoTuner.hybridAuto = hybridAuto;
  const tzOffsetMin = toNumber(process.env.AUTO_TUNE_SESSION_TZ_OFFSET_MIN)
    ?? toNumber(process.env.SESSION_TZ_OFFSET_MIN)
    ?? toNumber(sessionCfgRoot.tzOffsetMin)
    ?? 540;
  next.autoTuner.sessionTuning = {
    ...(sessionCfgRoot && typeof sessionCfgRoot === 'object' ? sessionCfgRoot : {}),
    enabled: sessionCfgRoot.enabled !== false,
    tzOffsetMin,
    lastDominantSession: dominantSessionKey,
    lastEvaluatedAt: nowTs
  };

  return {
    next,
    diagnostics: {
      p60Spread,
      p85Spread,
      p60Velocity,
      p85Velocity,
      p30Quality,
      p70Quality,
      p80MetaScore,
      p90MetaSpread,
      p90MetaVelocity,
      p90MetaShock,
      bMidPositionRate: Number((bMidRate * 100).toFixed(2)),
      aRangeTooNarrowRate: Number((aRangeNarrowRate * 100).toFixed(2)),
      aNotReadyBar1hRate: Number((aBar1hNotReadyRate * 100).toFixed(2)),
      bNoStructuralTpRate: Number((bNoStructuralTpRate * 100).toFixed(2)),
      bNoStructuralPathRate: Number((bNoStructuralPathRate * 100).toFixed(2)),
      bLowExecutionQualityRate: Number((bLowExecutionQualityRate * 100).toFixed(2)),
      bBar1hSpanFloorUnmetRate: Number((bBar1hSpanFloorUnmetRate * 100).toFixed(2)),
      bar1hSpanFloorUnmetCount: spanUnmetCount,
      bar1hSpanFloorUnmetP50: spanUnmetP50 != null ? Number(spanUnmetP50.toFixed(2)) : null,
      bar1hSpanFloorUnmetP70: spanUnmetP70 != null ? Number(spanUnmetP70.toFixed(2)) : null,
      bar1hSpanFloorUnmetP85: spanUnmetP85 != null ? Number(spanUnmetP85.toFixed(2)) : null,
      bar1hAdaptiveMinFinalSpanUsd: toNumber(next?.bar1h?.adaptive?.minFinalSpanUsd),
      capitalUsd: Number(capitalUsd.toFixed(2)),
      capitalStage: profile.stage,
      tradesInWindow: Number(tradeStats.count ?? 0),
      tradesWinRate: winRate != null ? Number((winRate * 100).toFixed(2)) : null,
      tradesAvgPnlUsd: avgPnl != null ? Number(avgPnl.toFixed(4)) : null,
      tradesPnlPer100Notional: pnlPer100 != null ? Number(pnlPer100.toFixed(4)) : null,
      makerRate: Number((makerRate * 100).toFixed(2)),
      takerRate: Number((takerRate * 100).toFixed(2)),
      roundTripCostBps: Number(roundTripCostBps.toFixed(4)),
      netPnlPer100Notional: netPnlPer100 != null ? Number(netPnlPer100.toFixed(4)) : null,
      feeEdgeGuardEnabled: !!next?.feeEdgeGuard?.enabled,
      hybridEnabled: !!next?.b2?.hybridMode?.enabled,
      hybridAutoEnabled,
      hybridSwitched,
      hybridCanSwitch: canSwitch,
      dominantSession: dominantSessionKey,
      dominantSessionTrades: dominantCount,
      dominantSessionPnlUsd: Number(dominantSessionPnlUsd.toFixed(4)),
      feeEdgeGuardMinNetUsd: toNumber(next?.feeEdgeGuard?.minNetUsd),
      feeEdgeGuardMinNetPer100: toNumber(next?.feeEdgeGuard?.minNetPer100Notional),
      tpRate: Number((tpRate * 100).toFixed(2)),
      slRate: Number((slRate * 100).toFixed(2)),
      timeoutRate: Number((timeoutRate * 100).toFixed(2)),
      timeoutLossRate: Number((timeoutLossRate * 100).toFixed(2)),
      hardSlRate: Number((hardSlRate * 100).toFixed(2)),
      tp1PartialRate: Number((tp1PartialRate * 100).toFixed(2)),
      stressCutRate: Number((stressCutRate * 100).toFixed(2)),
      avgHoldSec: Number((avgHoldMs / 1000).toFixed(1)),
      avgCaptureRatio: avgCaptureRatio != null ? Number(avgCaptureRatio.toFixed(4)) : null,
      captureLowRate: captureLowRate != null ? Number((captureLowRate * 100).toFixed(2)) : null,
      srNextShare: Number((srNextShare * 100).toFixed(2)),
      avgRegretUsd: avgRegretUsd != null ? Number(avgRegretUsd.toFixed(4)) : null,
      regretOver1Rate: regretOver1Rate != null ? Number((regretOver1Rate * 100).toFixed(2)) : null,
      attackReady,
      defensivePhase,
      adaptiveMinScalar: Number(next?.b2Upgrade?.adaptiveSize?.minScalar ?? 0),
      adaptiveMaxScalar: Number(next?.b2Upgrade?.adaptiveSize?.maxScalar ?? 0),
      ladderBoostMax: Number(next?.b2Upgrade?.ladderAttack?.boostMax ?? 0),
      higherTfSizeBoostMax: Number(next?.b2Upgrade?.higherTfControl?.sizeBoostMax ?? 0),
      higherTfTpBoostMax: Number(next?.b2Upgrade?.higherTfControl?.tpBoostMax ?? 0),
      lotTuningEnabled,
      fullAutoEnabled,
      capitalStageBandName: stageBand?.name ?? null,
      capitalStageLotMin: stageBand?.min ?? null,
      capitalStageLotMax: stageBand?.max ?? null
    }
  };
}

function detectMarketRegime(stats, diagnostics, current, forcedRegime = null) {
  const validForced = forcedRegime === 'trend' || forcedRegime === 'range' || forcedRegime === 'high_vol';
  if (validForced) return forcedRegime;
  const regime = stats?.regime ?? {};
  const total = (regime.up ?? 0) + (regime.down ?? 0) + (regime.range ?? 0);
  const rangeRatio = total > 0 ? (regime.range ?? 0) / total : 0;
  const trendRatio = total > 0 ? ((regime.up ?? 0) + (regime.down ?? 0)) / total : 0;
  const highVolVelocityBps = clamp(
    toNumber(current?.autoTuner?.highVolVelocityBps ?? 2.8),
    0.5,
    12
  );
  const velocity = toNumber(diagnostics?.p90MetaVelocity ?? diagnostics?.p85Velocity);
  if (velocity != null && velocity >= highVolVelocityBps) return 'high_vol';
  if (rangeRatio >= 0.55) return 'range';
  if (trendRatio >= 0.45) return 'trend';
  return 'range';
}

function applyAdaptiveProfile(proposed, regime, current) {
  const next = JSON.parse(JSON.stringify(proposed));
  const profileRoot = current?.autoTuner?.profiles ?? {};
  const defaultProfiles = {
    trend: {
      makerMaxSpreadMul: 0.95,
      makerMaxVelocityMul: 1.1,
      toxicityThresholdMul: 1.08,
      minScalarMul: 1.0,
      maxScalarMul: 1.08,
      riskRatioMul: 1.06,
      lotMinRatioMul: 1.02,
      lotMaxRatioMul: 1.08,
      minExpectedUsdMul: 1.06,
      tpStretchMul: 1.05,
      tpSplitCloseRatioMul: 0.97,
      lossTimeoutMsMul: 1.05,
      softRatioMul: 1.02,
      hardRatioMul: 1.02
    },
    range: {
      makerMaxSpreadMul: 1.08,
      makerMaxVelocityMul: 0.95,
      toxicityThresholdMul: 0.96,
      minScalarMul: 1.02,
      maxScalarMul: 1.02,
      riskRatioMul: 0.95,
      lotMinRatioMul: 0.98,
      lotMaxRatioMul: 0.95,
      minExpectedUsdMul: 0.96,
      tpStretchMul: 0.98,
      tpSplitCloseRatioMul: 1.04,
      lossTimeoutMsMul: 0.96,
      softRatioMul: 0.98,
      hardRatioMul: 0.98
    },
    high_vol: {
      makerMaxSpreadMul: 0.9,
      makerMaxVelocityMul: 0.88,
      toxicityThresholdMul: 0.9,
      minScalarMul: 0.95,
      maxScalarMul: 0.9,
      riskRatioMul: 0.82,
      lotMinRatioMul: 0.92,
      lotMaxRatioMul: 0.85,
      minExpectedUsdMul: 1.18,
      tpStretchMul: 0.92,
      tpSplitCloseRatioMul: 1.08,
      lossTimeoutMsMul: 0.88,
      softRatioMul: 0.94,
      hardRatioMul: 0.94
    }
  };
  const p = { ...defaultProfiles[regime], ...(profileRoot?.[regime] ?? {}) };

  const applyMul = (pathExpr, mul, min, max) => {
    const parts = pathExpr.split('.');
    let cur = next;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') return;
      cur = cur[parts[i]];
    }
    const key = parts[parts.length - 1];
    const base = toNumber(cur[key]);
    if (base == null || mul == null) return;
    cur[key] = clamp(base * Number(mul), min, max);
  };

  applyMul('b2Upgrade.execution.makerMaxSpreadBps', p.makerMaxSpreadMul, 0.1, 8);
  applyMul('b2Upgrade.execution.makerMaxVelocityBps', p.makerMaxVelocityMul, 0.1, 8);
  applyMul('metaGate.toxicityThreshold', p.toxicityThresholdMul, 0.4, 3);
  applyMul('b2Upgrade.adaptiveSize.minScalar', p.minScalarMul, 0.5, 1.0);
  applyMul('b2Upgrade.adaptiveSize.maxScalar', p.maxScalarMul, 1.0, 2.0);
  applyMul('riskRatio', p.riskRatioMul, 0.005, 0.04);
  applyMul('lot.minNotionalRatio', p.lotMinRatioMul, 0.08, 0.7);
  applyMul('lot.maxNotionalRatio', p.lotMaxRatioMul, 0.2, 0.95);
  applyMul('minExpectedUsd', p.minExpectedUsdMul, 4, 40);
  applyMul('b2.tpStretch', p.tpStretchMul, 1.0, 2.2);
  applyMul('b2.tpSplit.closeRatio', p.tpSplitCloseRatioMul, 0.25, 0.75);
  applyMul('lossTimeout.ms', p.lossTimeoutMsMul, 120000, 420000);
  applyMul('lossTimeout.softRatio', p.softRatioMul, 0.2, 0.55);
  applyMul('lossTimeout.hardRatio', p.hardRatioMul, 0.35, 0.8);

  const minScalar = toNumber(next?.b2Upgrade?.adaptiveSize?.minScalar);
  const maxScalar = toNumber(next?.b2Upgrade?.adaptiveSize?.maxScalar);
  if (minScalar != null && maxScalar != null && minScalar > maxScalar) {
    next.b2Upgrade.adaptiveSize.minScalar = maxScalar;
  }
  const minRatio = toNumber(next?.lot?.minNotionalRatio);
  const maxRatio = toNumber(next?.lot?.maxNotionalRatio);
  if (minRatio != null && maxRatio != null && minRatio > maxRatio) {
    next.lot.minNotionalRatio = maxRatio;
  }
  const softRatio = toNumber(next?.lossTimeout?.softRatio);
  const hardRatio = toNumber(next?.lossTimeout?.hardRatio);
  if (softRatio != null && hardRatio != null && hardRatio <= softRatio) {
    next.lossTimeout.hardRatio = clamp(softRatio + 0.08, 0.35, 0.8);
  }

  return next;
}

function appendMarker(marker) {
  const markerFile = path.resolve(process.cwd(), 'logs', 'markers.jsonl');
  fs.appendFileSync(markerFile, `${JSON.stringify(marker)}\n`, 'utf8');
}

function getAtPath(obj, pathExpr) {
  const parts = pathExpr.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return cur;
}

function buildGuardedConfig(current, proposed, maxChangeRatio) {
  const guarded = JSON.parse(JSON.stringify(proposed));
  const ratio = clamp(toNumber(maxChangeRatio), 0.01, 0.8);
  const guardedPaths = [];
  const paths = [
    'b2Upgrade.execution.makerMaxSpreadBps',
    'b2Upgrade.execution.makerMaxVelocityBps',
    'b2Upgrade.execution.maxSpreadBps',
    'b2Upgrade.execution.maxVelocityBps',
    'b2Upgrade.adaptiveSize.minScalar',
    'b2Upgrade.adaptiveSize.maxScalar',
    'b2Upgrade.ladderAttack.boostMax',
    'b2Upgrade.higherTfControl.sizeBoostMax',
    'b2Upgrade.higherTfControl.tpBoostMax',
    'metaGate.maxSpreadBps',
    'metaGate.maxPriceVelocityBps',
    'metaGate.maxCShock',
    'metaGate.toxicityThreshold',
    'b2Upgrade.edgeControl.baseRatio',
    'rangeFilter.minRangeUsd',
    'riskRatio',
    'lot.minNotionalRatio',
    'lot.maxNotionalRatio',
    'minExpectedUsd',
    'feeEdgeGuard.minNetUsd',
    'feeEdgeGuard.minNetPer100Notional',
    'b2.tpStretch',
    'b2.tpSplit.closeRatio',
    'b2.tpStretchHoldMs',
    'lossTimeout.ms',
    'lossTimeout.softRatio',
    'lossTimeout.hardRatio',
    'lossTimeout.dynamicRealtime.stressExitMinHoldMs',
    'lossTimeout.dynamicRealtime.stressExitMinAdverseRatio',
    'lossTimeout.dynamicRealtime.earlyExitMinHoldMs',
    'lossTimeout.dynamicRealtime.earlyExitProgressMax',
    'viewpoint.minStepUsd',
    'viewpoint.bar15mRangeWeight',
    'viewpoint.nearRetryFactor',
    'viewpoint.nearRetryMinUsd',
    'bar1h.adaptive.minFinalSpanUsd'
  ];
  for (const p of paths) {
    const oldV = toNumber(getAtPath(current, p));
    const newV = toNumber(getAtPath(guarded, p));
    if (oldV == null || newV == null || oldV === 0) continue;
    const maxUp = oldV * (1 + ratio);
    const maxDown = oldV * (1 - ratio);
    const bounded = clamp(newV, Math.min(maxDown, maxUp), Math.max(maxDown, maxUp));
    if (Math.abs(bounded - newV) > 1e-12) {
      const parts = p.split('.');
      let cur = guarded;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = bounded;
      guardedPaths.push({
        path: p,
        oldValue: oldV,
        proposedValue: newV,
        boundedValue: bounded
      });
    }
  }
  return { guarded, guardedPaths };
}

function enforceCapitalStageLotBand(configObj, capitalUsd) {
  const band = resolveCapitalStageBand(capitalUsd, configObj);
  if (!band || !configObj?.lot) return { configObj, band: null, adjusted: false };
  const prevMin = toNumber(configObj?.lot?.minNotionalRatio);
  const prevMax = toNumber(configObj?.lot?.maxNotionalRatio);
  if (prevMin == null || prevMax == null) return { configObj, band, adjusted: false };
  let min = clamp(prevMin, band.min, band.max);
  let max = clamp(prevMax, band.min, band.max);
  if (max < min) max = min;
  configObj.lot.minNotionalRatio = min;
  configObj.lot.maxNotionalRatio = max;
  return {
    configObj,
    band,
    adjusted: Math.abs(min - prevMin) > 1e-12 || Math.abs(max - prevMax) > 1e-12
  };
}

function printSummary(filePath, stats, diagnostics, changed, guard, adaptiveInfo = null) {
  const denyRate = stats.totalDecisionTrace > 0 ? stats.noneCount / stats.totalDecisionTrace : 0;
  const toxicRate = stats.totalDecisionTrace > 0 ? stats.toxicStopCount / stats.totalDecisionTrace : 0;
  const arenaRate = stats.totalDecisionTrace > 0 ? stats.outsideArenaCount / stats.totalDecisionTrace : 0;
  console.log(JSON.stringify({
    input: filePath,
    samples: {
      decisionTrace: stats.totalDecisionTrace,
      entries: stats.entryCount,
      none: stats.noneCount,
      toxicStops: stats.toxicStopCount,
      outsideArenaStops: stats.outsideArenaCount
    },
    rates: {
      noneRate: Number((denyRate * 100).toFixed(2)),
      toxicStopRate: Number((toxicRate * 100).toFixed(2)),
      outsideArenaStopRate: Number((arenaRate * 100).toFixed(2))
    },
    quantiles: diagnostics,
    changed,
    guard,
    adaptive: adaptiveInfo
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const logDir = path.resolve(cwd, 'logs');
  const tradePath = path.resolve(cwd, 'config', 'trade.json');
  const inputFiles = resolveInputFiles(cwd, args, logDir);
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
    console.error('No raw log found. Use --input logs/raw-YYYYMMDD.jsonl or keep default auto-select');
    process.exit(1);
  }
  if (!fs.existsSync(tradePath)) {
    console.error('config/trade.json not found');
    process.exit(1);
  }
  const current = JSON.parse(fs.readFileSync(tradePath, 'utf8'));
  const stats = await analyzeLogFiles(inputFiles, { windowMin: args.windowMin });
  const tradeStats = await analyzeTradesWindow(cwd, args.windowMin);
  const capitalUsd = resolveCapitalUsd(cwd, current);
  const { next: proposedBase, diagnostics } = proposeSettings(stats, current, {
    capitalUsd,
    tradeStats
  });
  const regime = args.adaptive
    ? detectMarketRegime(stats, diagnostics, current, args.regime)
    : null;
  const proposed = args.adaptive
    ? applyAdaptiveProfile(proposedBase, regime, current)
    : proposedBase;
  // keep stage/tune metadata in config for auditability
  if (!proposed.autoTuner || typeof proposed.autoTuner !== 'object') proposed.autoTuner = {};
  proposed.autoTuner.capitalUsd = capitalUsd;
  proposed.autoTuner.lastTradeSource = tradeStats.source ?? null;
  proposed.autoTuner.lastWindowTrades = tradeStats.count;
  proposed.autoTuner.lastWindowAvgPnlUsd = Number((tradeStats.avgPnl ?? 0).toFixed(6));
  const { guarded, guardedPaths } = buildGuardedConfig(current, proposed, args.maxChangeRatio);
  const stageBandPostGuard = enforceCapitalStageLotBand(guarded, capitalUsd);
  if (stageBandPostGuard.adjusted) {
    guardedPaths.push({
      path: 'lot.stageBandPostGuard',
      oldValue: {
        min: toNumber(current?.lot?.minNotionalRatio),
        max: toNumber(current?.lot?.maxNotionalRatio)
      },
      proposedValue: {
        min: toNumber(proposed?.lot?.minNotionalRatio),
        max: toNumber(proposed?.lot?.maxNotionalRatio)
      },
      boundedValue: {
        min: toNumber(guarded?.lot?.minNotionalRatio),
        max: toNumber(guarded?.lot?.maxNotionalRatio),
        band: stageBandPostGuard?.band ?? null
      }
    });
  }

  const changed = JSON.stringify(current) !== JSON.stringify(guarded);
  const guard = {
    minSamples: args.minSamples,
    minTradeSamples: args.minTradeSamples,
    maxChangeRatio: args.maxChangeRatio,
    boundedChanges: guardedPaths.length
  };
  const adaptiveInfo = args.adaptive
    ? {
      enabled: true,
      regime,
      regimeCounts: stats.regime,
      windowMin: args.windowMin
    }
    : null;
  printSummary(inputFiles, stats, diagnostics, changed, guard, adaptiveInfo);

  if (!args.apply) return;
  const startupFreezeMs = resolveStartupGuardApplyFreezeMs(current);
  if (startupFreezeMs > 0) {
    const startupRefTs = readLatestMarkerTs(cwd, [
      'log_reset',
      'manual_reset',
      'ops_restart_with_log_reset',
      'manual_reset_and_restart'
    ]);
    if (Number.isFinite(startupRefTs)) {
      const elapsed = Date.now() - startupRefTs;
      if (elapsed >= 0 && elapsed < startupFreezeMs) {
        console.log(`Startup guard freeze active: elapsed=${Math.floor(elapsed / 1000)}s < freeze=${Math.floor(startupFreezeMs / 1000)}s. Skipped apply.`);
        appendMarker({
          ts: Date.now(),
          type: 'auto_tune_skip_startup_guard',
          elapsedMs: elapsed,
          freezeMs: startupFreezeMs,
          input: inputFiles
        });
        return;
      }
    }
  }
  if (!Number.isFinite(args.minSamples) || stats.totalDecisionTrace < args.minSamples) {
    console.log(`Insufficient samples: ${stats.totalDecisionTrace} < ${args.minSamples}. Skipped apply.`);
    return;
  }
  if (!Number.isFinite(args.minTradeSamples) || tradeStats.count < args.minTradeSamples) {
    console.log(`Insufficient trade samples: ${tradeStats.count} < ${args.minTradeSamples}. Skipped apply.`);
    return;
  }
  if (!changed) {
    console.log('No changes detected. Skipped apply.');
    return;
  }

  const backupPath = `${tradePath}.bak.${Date.now()}`;
  fs.copyFileSync(tradePath, backupPath);
  fs.writeFileSync(tradePath, `${JSON.stringify(guarded, null, 2)}\n`, 'utf8');
  appendMarker({
    ts: Date.now(),
    type: 'auto_tune_apply',
    reason: 'decision_trace quantile tuning',
    input: inputFiles,
    adaptive: args.adaptive,
    regime,
    windowMin: args.windowMin,
    backupPath,
    minSamples: args.minSamples,
    minTradeSamples: args.minTradeSamples,
    maxChangeRatio: args.maxChangeRatio,
    boundedChanges: guardedPaths,
    changedKeys: [
      'b2Upgrade.execution',
      'b2Upgrade.adaptiveSize',
      'metaGate',
      'b2Upgrade.edgeControl',
      'rangeFilter',
      'riskRatio',
      'lot.minNotionalRatio',
      'lot.maxNotionalRatio',
      'minExpectedUsd',
      'feeEdgeGuard',
      'b2.tpStretch',
      'b2.hybridMode.enabled',
      'b2.tpSplit.enabled',
      'b2.tpSplit.closeRatio',
      'b2.tpStretchHoldMs',
      'lossTimeout.ms',
      'lossTimeout.softRatio',
      'lossTimeout.hardRatio',
      'lossTimeout.dynamicRealtime.stressExitMinHoldMs',
      'lossTimeout.dynamicRealtime.stressExitMinAdverseRatio',
      'autoTuner.hybridAuto',
      'autoTuner.capitalUsd',
      'bar1h.adaptive.minFinalSpanUsd'
    ]
  });
  console.log(`Applied tuning. Backup: ${backupPath}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
