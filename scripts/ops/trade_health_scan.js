#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import minimist from 'minimist';

function toNum(v, d = 0) {
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

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function loadJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) {}
  }
  return out;
}

function analyze(rows) {
  const n = rows.length;
  const netArr = rows.map(r => toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)));
  const grossArr = rows.map(r => toNum(r.realizedPnlUsd, 0));
  const feeArr = rows.map(r => toNum(r.feeUsd, 0));
  const notionalArr = rows.map(r => toNum(r.notional, 0));
  const captureArr = rows.map(r => toNum(r.captureRatio, NaN)).filter(v => Number.isFinite(v) && v >= 0);
  const mapStrengthArr = rows.map(r => toNum(r.mapStrength, NaN)).filter(v => Number.isFinite(v) && v >= 0);
  const weakMapCount = rows.filter(r => String(r.signal ?? '') === 'weak_structural_map').length;
  const noPathCount = rows.filter(r => String(r.signal ?? '') === 'no_structural_path').length;
  const ladderAttackArr = rows.map(r => toNum(r.ladderAttackScalar, NaN)).filter(v => Number.isFinite(v) && v > 0);
  const regretArr = rows.map(r => toNum(r.regretMaxUsd, NaN)).filter(v => Number.isFinite(v) && v >= 0);
  const wins = netArr.filter(v => v > 0).length;
  const losses = netArr.filter(v => v < 0).length;
  const winNetArr = netArr.filter(v => v > 0);
  const lossNetArr = netArr.filter(v => v < 0);
  const sig = (name) => rows.filter(r => String(r.signal ?? '') === name).length;
  const takerEntry = rows.filter(r => String(r.entryExecMode ?? '') === 'taker').length;
  const takerExit = rows.filter(r => String(r.exitExecMode ?? '') === 'taker').length;
  const entryProfileUnknown = rows.filter(r => {
    const mode = String(r.entryProfileMode ?? '').toLowerCase();
    return !mode || mode === 'unknown' || mode === 'na' || mode === 'none';
  }).length;
  const higherTfConflictLoss = rows.filter(r => {
    const align = toNum(r.higherTfAlignScore, 0);
    const net = toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    return align <= -0.5 && net < 0;
  }).length;
  const timeoutRows = rows.filter(r => String(r.signal ?? '') === 'timeout_loss_only');
  const timeoutLikeRows = rows.filter((r) => {
    const timeoutSignal = String(r.signal ?? '').toLowerCase();
    const timeoutExitReason = String(r.exitReason ?? '').toLowerCase();
    return timeoutSignal.includes('timeout') || timeoutExitReason.includes('timeout');
  });
  const timeoutGross = timeoutRows.reduce((a, r) => a + toNum(r.realizedPnlUsd, 0), 0);
  const timeoutNet = timeoutRows.reduce((a, r) => a + toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)), 0);
  const timeoutFee = timeoutRows.reduce((a, r) => a + toNum(r.feeUsd, 0), 0);
  const timeoutLikeGross = timeoutLikeRows.reduce((a, r) => a + toNum(r.realizedPnlUsd, 0), 0);
  const timeoutLikeNet = timeoutLikeRows.reduce((a, r) => a + toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)), 0);
  const timeoutLikeFee = timeoutLikeRows.reduce((a, r) => a + toNum(r.feeUsd, 0), 0);
  const byTpSourceMap = new Map();
  const byTpPhaseMap = new Map();
  const byTimeoutReasonMap = new Map();
  const byStructureSourceMap = new Map();
  const byStructureBasisMap = new Map();
  const byRegimeSideMap = new Map();
  const byRegimeMap = new Map();
  const unknownBreakdown = {
    tpPhaseMissing: 0,
    tpSourceUnknown: 0,
    marketRegimeUnknown: 0,
    marketStateUnknown: 0,
    logQualityPartial: 0
  };
  for (const r of rows) {
    const key = String(r.plannedTpSource ?? 'unknown');
    const cur = byTpSourceMap.get(key) ?? { n: 0, net: 0, tpDistSum: 0, tpDistN: 0 };
    cur.n += 1;
    cur.net += toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    const tpDistForSource = toNum(r.tpDistanceUsd, toNum(r.plannedTpDistanceUsd, NaN));
    if (Number.isFinite(tpDistForSource) && tpDistForSource > 0) {
      cur.tpDistSum += tpDistForSource;
      cur.tpDistN += 1;
    }
    byTpSourceMap.set(key, cur);
    const tpPhase = String(r.plannedTpPhase ?? r.tpPhase ?? 'unknown').toUpperCase();
    if (tpPhase === 'UNKNOWN' || tpPhase === 'NA' || tpPhase === 'NONE') {
      unknownBreakdown.tpPhaseMissing += 1;
    }
    const curTpPhase = byTpPhaseMap.get(tpPhase) ?? { n: 0, net: 0, win: 0 };
    const netForTpPhase = toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    curTpPhase.n += 1;
    curTpPhase.net += netForTpPhase;
    if (netForTpPhase > 0) curTpPhase.win += 1;
    byTpPhaseMap.set(tpPhase, curTpPhase);

    const timeoutSignal = String(r.signal ?? '').toLowerCase();
    const timeoutExitReason = String(r.exitReason ?? '').toLowerCase();
    if (timeoutSignal.includes('timeout') || timeoutExitReason.includes('timeout')) {
      const timeoutReason = String(r.signal ?? r.exitReason ?? 'timeout_unknown').toLowerCase();
      const curTimeoutReason = byTimeoutReasonMap.get(timeoutReason) ?? { n: 0, net: 0, fee: 0 };
      curTimeoutReason.n += 1;
      curTimeoutReason.net += toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
      curTimeoutReason.fee += toNum(r.feeUsd, 0);
      byTimeoutReasonMap.set(timeoutReason, curTimeoutReason);
    }

    const structureSource = String(r.plannedStructureSource ?? 'unknown');
    const curStructureSource = byStructureSourceMap.get(structureSource) ?? { n: 0, net: 0, spanSum: 0, spanN: 0, win: 0, tpDistSum: 0, tpDistN: 0, holdMsSum: 0, holdMsN: 0 };
    curStructureSource.n += 1;
    curStructureSource.net += toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    if (toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)) > 0) curStructureSource.win += 1;
    const span = toNum(r.plannedStructureSpanUsd, NaN);
    if (Number.isFinite(span) && span > 0) {
      curStructureSource.spanSum += span;
      curStructureSource.spanN += 1;
    }
    const tpDist = toNum(r.tpDistanceUsd, toNum(r.plannedTpDistanceUsd, NaN));
    if (Number.isFinite(tpDist) && tpDist > 0) {
      curStructureSource.tpDistSum += tpDist;
      curStructureSource.tpDistN += 1;
    }
    const holdMs = toNum(r.holdMs, NaN);
    if (Number.isFinite(holdMs) && holdMs > 0) {
      curStructureSource.holdMsSum += holdMs;
      curStructureSource.holdMsN += 1;
    }
    byStructureSourceMap.set(structureSource, curStructureSource);

    const structureBasis = String(r.plannedStructureBasis ?? 'unknown');
    const curStructureBasis = byStructureBasisMap.get(structureBasis) ?? { n: 0, net: 0 };
    curStructureBasis.n += 1;
    curStructureBasis.net += toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    byStructureBasisMap.set(structureBasis, curStructureBasis);

    const regime = String(r.marketRegime ?? 'UNKNOWN').toUpperCase();
    if (String(r.plannedTpSource ?? 'unknown').toLowerCase() === 'unknown') unknownBreakdown.tpSourceUnknown += 1;
    if (regime === 'UNKNOWN') unknownBreakdown.marketRegimeUnknown += 1;
    if (String(r.marketState ?? 'UNKNOWN').toUpperCase() === 'UNKNOWN') unknownBreakdown.marketStateUnknown += 1;
    if (String(r.logQuality ?? '').toLowerCase() === 'partial') unknownBreakdown.logQualityPartial += 1;
    const side = String(r.side ?? 'UNKNOWN').toUpperCase();
    const regimeSideKey = `${regime}:${side}`;
    const netForRegime = toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    const curRegimeSide = byRegimeSideMap.get(regimeSideKey) ?? { regime, side, n: 0, net: 0, win: 0 };
    curRegimeSide.n += 1;
    curRegimeSide.net += netForRegime;
    if (netForRegime > 0) curRegimeSide.win += 1;
    byRegimeSideMap.set(regimeSideKey, curRegimeSide);

    const curRegime = byRegimeMap.get(regime) ?? { regime, n: 0, net: 0, win: 0, loss: 0, winNet: 0, lossNet: 0, longN: 0, shortN: 0 };
    curRegime.n += 1;
    curRegime.net += netForRegime;
    if (netForRegime > 0) {
      curRegime.win += 1;
      curRegime.winNet += netForRegime;
    }
    if (netForRegime < 0) {
      curRegime.loss += 1;
      curRegime.lossNet += netForRegime;
    }
    if (side === 'LONG') curRegime.longN += 1;
    if (side === 'SHORT') curRegime.shortN += 1;
    byRegimeMap.set(regime, curRegime);
  }
  const byTpSource = [...byTpSourceMap.entries()]
    .map(([source, v]) => ({
      source,
      n: v.n,
      rate: round(pct(v.n, n), 2),
      avgNet: round(v.net / Math.max(1, v.n), 6),
      avgTpDistanceUsd: v.tpDistN > 0 ? round(v.tpDistSum / v.tpDistN, 2) : null
    }))
    .sort((a, b) => b.n - a.n);
  const byStructureSource = [...byStructureSourceMap.entries()]
    .map(([source, v]) => ({
      source,
      n: v.n,
      avgNet: round(v.net / Math.max(1, v.n), 6),
      winRate: round(pct(v.win, v.n), 2),
      avgSpanUsd: v.spanN > 0 ? round(v.spanSum / v.spanN, 2) : null,
      avgTpDistanceUsd: v.tpDistN > 0 ? round(v.tpDistSum / v.tpDistN, 2) : null,
      avgHoldMs: v.holdMsN > 0 ? Math.round(v.holdMsSum / v.holdMsN) : null
    }))
    .sort((a, b) => b.n - a.n);
  const byStructureBasis = [...byStructureBasisMap.entries()]
    .map(([basis, v]) => ({ basis, n: v.n, avgNet: round(v.net / Math.max(1, v.n), 6) }))
    .sort((a, b) => b.n - a.n);
  const byTpPhase = [...byTpPhaseMap.entries()]
    .map(([phase, v]) => ({
      phase,
      n: v.n,
      rate: round(pct(v.n, n), 2),
      avgNet: round(v.net / Math.max(1, v.n), 6),
      winRate: round(pct(v.win, v.n), 2)
    }))
    .sort((a, b) => b.n - a.n);
  const byTimeoutReason = [...byTimeoutReasonMap.entries()]
    .map(([reason, v]) => ({
      reason,
      n: v.n,
      rate: round(pct(v.n, Math.max(1, timeoutLikeRows.length)), 2),
      avgNet: round(v.net / Math.max(1, v.n), 6),
      avgFee: round(v.fee / Math.max(1, v.n), 6)
    }))
    .sort((a, b) => b.n - a.n);
  const byRegimeSide = [...byRegimeSideMap.entries()]
    .map(([, v]) => ({
      regime: v.regime,
      side: v.side,
      n: v.n,
      rate: round(pct(v.n, n), 2),
      avgNet: round(v.net / Math.max(1, v.n), 6),
      winRate: round(pct(v.win, v.n), 2)
    }))
    .sort((a, b) => b.n - a.n);
  const byRegime = [...byRegimeMap.entries()]
    .map(([, v]) => ({
      regime: v.regime,
      n: v.n,
      rate: round(pct(v.n, n), 2),
      avgNet: round(v.net / Math.max(1, v.n), 6),
      winRate: round(pct(v.win, v.n), 2),
      avgWinNet: round(v.winNet / Math.max(1, v.win), 6),
      avgLossNet: round(v.lossNet / Math.max(1, v.loss), 6),
      expectancy: round(((pct(v.win, v.n) / 100) * (v.winNet / Math.max(1, v.win))) + ((pct(v.loss, v.n) / 100) * (v.lossNet / Math.max(1, v.loss))), 6),
      longShare: round(pct(v.longN, v.n), 2),
      shortShare: round(pct(v.shortN, v.n), 2)
    }))
    .sort((a, b) => b.n - a.n);

  const byRevMap = new Map();
  for (const r of rows) {
    const rev = String(r.bLogicRevision ?? 'unknown');
    const cur = byRevMap.get(rev) ?? { n: 0, net: 0, win: 0, stress: 0, timeout: 0, tp: 0 };
    const net = toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0));
    cur.n += 1;
    cur.net += net;
    if (net > 0) cur.win += 1;
    if (String(r.signal ?? '') === 'stress_cut_loss') cur.stress += 1;
    if (String(r.signal ?? '') === 'timeout_loss_only') cur.timeout += 1;
    if (String(r.signal ?? '') === 'tp_hit' || String(r.signal ?? '') === 'tp1_partial') cur.tp += 1;
    byRevMap.set(rev, cur);
  }
  const byRevision = [...byRevMap.entries()].map(([rev, v]) => ({
    revision: rev,
    n: v.n,
    avgNet: round(v.net / Math.max(1, v.n), 6),
    winRate: round(pct(v.win, v.n), 2),
    stressRate: round(pct(v.stress, v.n), 2),
    timeoutRate: round(pct(v.timeout, v.n), 2),
    tpRate: round(pct(v.tp, v.n), 2)
  })).sort((a, b) => a.revision.localeCompare(b.revision));

  const netSum = netArr.reduce((a, b) => a + b, 0);
  const grossSum = grossArr.reduce((a, b) => a + b, 0);
  const feeSum = feeArr.reduce((a, b) => a + b, 0);
  const avgNet = netSum / Math.max(1, n);
  const avgWinNet = winNetArr.reduce((a, b) => a + b, 0) / Math.max(1, winNetArr.length);
  const avgLossNet = lossNetArr.reduce((a, b) => a + b, 0) / Math.max(1, lossNetArr.length);
  const expectancy = (pct(wins, n) / 100) * avgWinNet + (pct(losses, n) / 100) * avgLossNet;
  const avgGross = grossSum / Math.max(1, n);
  const avgFee = feeSum / Math.max(1, n);
  const avgNotional = notionalArr.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const makerEntryRate = 100 - pct(takerEntry, Math.max(1, n));
  const makerExitRate = 100 - pct(takerExit, Math.max(1, n));
  const feeOverGrossPct = grossSum > 0 ? (feeSum / grossSum) * 100 : 0;
  const medianNet = median(netArr);
  const netOver1Count = netArr.filter(v => v >= 1.0).length;
  const netOver1Rate = pct(netOver1Count, n);

  const flags = [];
  if (avgNet < 0) flags.push('avg_net_negative');
  if (avgNet < 1.0) flags.push('avg_net_below_1usd');
  if (avgWinNet < 1.0) flags.push('avg_win_below_1usd');
  if (netOver1Rate < 30) flags.push('net_over_1usd_rate_low');
  if (feeOverGrossPct > 70) flags.push('fee_over_gross_high');
  if (pct(sig('stress_cut_loss'), n) >= 35) flags.push('stress_cut_rate_high');
  if (pct(sig('timeout_loss_only'), n) >= 20) flags.push('timeout_rate_high');
  if ((sig('tp_hit') + sig('tp1_partial')) / Math.max(1, n) < 0.3) flags.push('tp_rate_low');
  if (pct(weakMapCount, n) > 25) flags.push('weak_map_rate_high');
  if (pct(noPathCount, n) > 25) flags.push('no_structural_path_rate_high');
  if (makerEntryRate < 10) flags.push('maker_entry_rate_low');
  if (pct(entryProfileUnknown, Math.max(1, n)) > 30) flags.push('entry_profile_mode_missing');
  if (pct(higherTfConflictLoss, Math.max(1, n)) > 20) flags.push('higher_tf_conflict_loss_high');
  if (avgGross > 0 && avgNet < 0) flags.push('gross_positive_but_net_negative');
  if (timeoutGross > 0 && timeoutNet < 0) flags.push('timeout_fee_drain');
  if (pct(unknownBreakdown.tpPhaseMissing, n) > 20) flags.push('tp_phase_unknown_high');
  if (pct(unknownBreakdown.marketRegimeUnknown, n) > 10) flags.push('market_regime_unknown_high');
  if (pct(unknownBreakdown.logQualityPartial, n) > 10) flags.push('log_quality_partial_high');

  const quickActions = [];
  if (round(pct(unknownBreakdown.tpPhaseMissing, n), 2) > 30) quickActions.push('new_log_only_for_tp_phase');
  if (round(pct(sig('timeout_loss_only'), n), 2) > 20) quickActions.push('reduce_timeout_fee_drain');
  if (round(pct(byTpSourceMap.get('channel_edge')?.n ?? 0, n), 2) > 40) quickActions.push('decrease_channel_edge_dependency');
  if (sustainedNegative(byRegime)) quickActions.push('regime_side_guard_tuning');

  // Time-series comparison: split rows into recent half vs older half by structureSource
  const halfIdx = Math.floor(n / 2);
  const olderRows = rows.slice(0, halfIdx);
  const recentRows = rows.slice(halfIdx);
  const trendBySource = [];
  if (olderRows.length >= 3 && recentRows.length >= 3) {
    const allSources = new Set([...byStructureSourceMap.keys()]);
    for (const src of allSources) {
      const olderNet = olderRows.filter(r => String(r.plannedStructureSource ?? 'unknown') === src).map(r => toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)));
      const recentNet = recentRows.filter(r => String(r.plannedStructureSource ?? 'unknown') === src).map(r => toNum(r.realizedPnlNetUsd, toNum(r.realizedPnlUsd, 0)));
      if (olderNet.length === 0 && recentNet.length === 0) continue;
      const olderAvg = olderNet.length > 0 ? olderNet.reduce((a, b) => a + b, 0) / olderNet.length : 0;
      const recentAvg = recentNet.length > 0 ? recentNet.reduce((a, b) => a + b, 0) / recentNet.length : 0;
      const delta = recentAvg - olderAvg;
      trendBySource.push({
        source: src,
        olderN: olderNet.length,
        recentN: recentNet.length,
        olderAvgNet: round(olderAvg, 6),
        recentAvgNet: round(recentAvg, 6),
        delta: round(delta, 6),
        direction: delta > 0.5 ? 'improving' : (delta < -0.5 ? 'degrading' : 'stable')
      });
    }
    trendBySource.sort((a, b) => a.delta - b.delta);
  }

  return {
    summary: {
      n,
      wins,
      losses,
      winRate: round(pct(wins, n), 2),
      netSum: round(netSum, 6),
      grossSum: round(grossSum, 6),
      feeSum: round(feeSum, 6),
      avgNet: round(avgNet, 6),
      avgWinNet: round(avgWinNet, 6),
      avgLossNet: round(avgLossNet, 6),
      expectancy: round(expectancy, 6),
      medianNet: round(medianNet, 6),
      avgGross: round(avgGross, 6),
      avgFee: round(avgFee, 6),
      feeOverGrossPct: round(feeOverGrossPct, 2),
      avgNotional: round(avgNotional, 6),
      avgCaptureRatio: round(captureArr.reduce((a, b) => a + b, 0) / Math.max(1, captureArr.length), 4),
      avgMapStrength: round(mapStrengthArr.reduce((a, b) => a + b, 0) / Math.max(1, mapStrengthArr.length), 4),
      weakMapRate: round(pct(weakMapCount, n), 2),
      noStructuralPathRate: round(pct(noPathCount, n), 2),
      ladderAttackActiveRate: round(pct(ladderAttackArr.filter(v => v > 1.01).length, n), 2),
      avgRegretUsd: round(regretArr.reduce((a, b) => a + b, 0) / Math.max(1, regretArr.length), 6),
      regretOver1UsdRate: round(pct(regretArr.filter(v => v >= 1.0).length, n), 2),
      netOver1UsdCount: netOver1Count,
      netOver1UsdRate: round(netOver1Rate, 2),
      stressRate: round(pct(sig('stress_cut_loss'), n), 2),
      timeoutRate: round(pct(sig('timeout_loss_only'), n), 2),
      tpRate: round(pct(sig('tp_hit') + sig('tp1_partial'), n), 2),
      makerEntryRate: round(makerEntryRate, 2),
      makerExitRate: round(makerExitRate, 2),
      entryProfileUnknownRate: round(pct(entryProfileUnknown, n), 2),
      higherTfConflictLossRate: round(pct(higherTfConflictLoss, n), 2)
    },
    timeoutSegment: {
      n: timeoutRows.length,
      gross: round(timeoutGross, 6),
      net: round(timeoutNet, 6),
      fee: round(timeoutFee, 6)
    },
    timeoutAllSegment: {
      n: timeoutLikeRows.length,
      gross: round(timeoutLikeGross, 6),
      net: round(timeoutLikeNet, 6),
      fee: round(timeoutLikeFee, 6)
    },
    byTpSource,
    byTpPhase,
    byTimeoutReason,
    byStructureSource,
    byStructureBasis,
    byRegimeSide,
    byRegime,
    unknownBreakdown: {
      tpPhaseMissing: unknownBreakdown.tpPhaseMissing,
      tpSourceUnknown: unknownBreakdown.tpSourceUnknown,
      marketRegimeUnknown: unknownBreakdown.marketRegimeUnknown,
      marketStateUnknown: unknownBreakdown.marketStateUnknown,
      logQualityPartial: unknownBreakdown.logQualityPartial,
      tpPhaseMissingRate: round(pct(unknownBreakdown.tpPhaseMissing, n), 2),
      tpSourceUnknownRate: round(pct(unknownBreakdown.tpSourceUnknown, n), 2),
      marketRegimeUnknownRate: round(pct(unknownBreakdown.marketRegimeUnknown, n), 2),
      marketStateUnknownRate: round(pct(unknownBreakdown.marketStateUnknown, n), 2),
      logQualityPartialRate: round(pct(unknownBreakdown.logQualityPartial, n), 2)
    },
    quickActions,
    byRevision,
    trendBySource,
    flags
  };
}

function sustainedNegative(byRegime = []) {
  if (!Array.isArray(byRegime) || byRegime.length === 0) return false;
  const majors = byRegime.filter(r => r.n >= 5);
  if (majors.length === 0) return false;
  return majors.every(r => toNum(r.avgNet, 0) < 0);
}

function printHuman(report, file, windowHours) {
  const s = report.summary;
  console.log(`[trade-health] file=${file} window=${windowHours}h n=${s.n}`);
  if (s.n === 0) {
    console.log('- no rows in selected window/filter. try: --windowHours 24 or disable --production-only');
    return;
  }
  console.log(`- avgNet=${s.avgNet} avgWinNet=${s.avgWinNet} avgLossNet=${s.avgLossNet} expectancy=${s.expectancy}`);
  console.log(`- medianNet=${s.medianNet} net>=1usd=${s.netOver1UsdCount}/${s.n} (${s.netOver1UsdRate}%)`);
  console.log(`- avgGross=${s.avgGross} avgFee=${s.avgFee} feeOverGross=${s.feeOverGrossPct}% avgNotional=${s.avgNotional}`);
  console.log(`- winRate=${s.winRate}% tpRate=${s.tpRate}% stressRate=${s.stressRate}% timeoutRate=${s.timeoutRate}%`);
  console.log(`- makerEntryRate=${s.makerEntryRate}% makerExitRate=${s.makerExitRate}% unknownEntryProfile=${s.entryProfileUnknownRate}%`);
  console.log(`- higherTfConflictLossRate=${s.higherTfConflictLossRate}%`);
  console.log(`- timeout segment: n=${report.timeoutSegment.n} gross=${report.timeoutSegment.gross} net=${report.timeoutSegment.net} fee=${report.timeoutSegment.fee}`);
  console.log(`- timeout(all)   : n=${report.timeoutAllSegment.n} gross=${report.timeoutAllSegment.gross} net=${report.timeoutAllSegment.net} fee=${report.timeoutAllSegment.fee}`);
  console.log(`- avgCaptureRatio=${s.avgCaptureRatio} ladderAttackActiveRate=${s.ladderAttackActiveRate}% avgRegretUsd=${s.avgRegretUsd} regret>=1usd=${s.regretOver1UsdRate}%`);
  console.log(`- map: avgStrength=${s.avgMapStrength} weakRate=${s.weakMapRate}% noPathRate=${s.noStructuralPathRate}%`);
  if (report.unknownBreakdown) {
    const u = report.unknownBreakdown;
    console.log(`- unknown: tpPhase=${u.tpPhaseMissingRate}% tpSource=${u.tpSourceUnknownRate}% regime=${u.marketRegimeUnknownRate}% marketState=${u.marketStateUnknownRate}% partialLog=${u.logQualityPartialRate}%`);
  }
  if (report.flags.length > 0) {
    console.log(`- flags: ${report.flags.join(', ')}`);
  } else {
    console.log('- flags: none');
  }
  if (Array.isArray(report.quickActions) && report.quickActions.length > 0) {
    console.log(`- quickActions: ${report.quickActions.join(', ')}`);
  }
  if (report.byRevision.length > 0) {
    console.log('- byRevision:');
    for (const r of report.byRevision) {
      console.log(`  * ${r.revision} n=${r.n} avgNet=${r.avgNet} winRate=${r.winRate}% tp=${r.tpRate}% stress=${r.stressRate}% timeout=${r.timeoutRate}%`);
    }
  }
  if (report.byTpSource.length > 0) {
    console.log('- byTpSource:');
    for (const t of report.byTpSource) {
      console.log(`  * ${t.source} n=${t.n} avgNet=${t.avgNet}`);
    }
  }
  if (report.byTpPhase.length > 0) {
    console.log('- byTpPhase:');
    for (const t of report.byTpPhase) {
      console.log(`  * ${t.phase} n=${t.n} avgNet=${t.avgNet} winRate=${t.winRate}%`);
    }
  }
  if (report.byTimeoutReason.length > 0) {
    console.log('- byTimeoutReason:');
    for (const t of report.byTimeoutReason) {
      console.log(`  * ${t.reason} n=${t.n} avgNet=${t.avgNet} avgFee=${t.avgFee}`);
    }
  }
  if (report.byStructureSource.length > 0) {
    console.log('- byStructureSource:');
    for (const t of report.byStructureSource) {
      const holdSec = t.avgHoldMs != null ? Math.round(t.avgHoldMs / 1000) : null;
      console.log(`  * ${t.source} n=${t.n} avgNet=${t.avgNet} winRate=${t.winRate}% avgSpan=${t.avgSpanUsd ?? 'null'} avgTpDist=${t.avgTpDistanceUsd ?? 'null'} avgHold=${holdSec != null ? holdSec + 's' : 'null'}`);
    }
  }
  if (report.byStructureBasis.length > 0) {
    console.log('- byStructureBasis:');
    for (const t of report.byStructureBasis) {
      console.log(`  * ${t.basis} n=${t.n} avgNet=${t.avgNet}`);
    }
  }
  if (report.byRegime.length > 0) {
    console.log('- byRegime:');
    for (const t of report.byRegime) {
      console.log(`  * ${t.regime} n=${t.n} avgNet=${t.avgNet} exp=${t.expectancy} winRate=${t.winRate}% long=${t.longShare}% short=${t.shortShare}%`);
    }
  }
  if (report.byRegimeSide.length > 0) {
    console.log('- byRegimeSide:');
    for (const t of report.byRegimeSide) {
      console.log(`  * ${t.regime}:${t.side} n=${t.n} avgNet=${t.avgNet} winRate=${t.winRate}%`);
    }
  }
  if (report.trendBySource.length > 0) {
    console.log('- trendBySource (older_half → recent_half):');
    for (const t of report.trendBySource) {
      console.log(`  * ${t.source} ${t.olderN}→${t.recentN} avgNet: ${t.olderAvgNet}→${t.recentAvgNet} (${t.delta >= 0 ? '+' : ''}${t.delta}) [${t.direction}]`);
    }
  }
}

function main() {
  const args = minimist(process.argv.slice(2), {
    string: ['file', 'sinceRevision'],
    boolean: ['json', 'productionOnly', 'liveFile'],
    default: { json: false, windowHours: 12, productionOnly: false, liveFile: false }
  });
  const productionOnly = args.productionOnly === true || args['production-only'] === true;
  const liveFile = args.liveFile === true || args['live-file'] === true;
  const cwd = process.cwd();
  const defaultTestFile = path.resolve(cwd, 'test-logs', 'trades.jsonl');
  const defaultLiveFile = path.resolve(cwd, 'logs', 'trades.jsonl');
  const file = args.file
    ? path.resolve(cwd, args.file)
    : liveFile
      ? defaultLiveFile
      : defaultTestFile;
  const windowHours = Math.max(1, Math.floor(toNum(args.windowHours, 12)));
  const nowMs = Date.now();
  let rows = loadJsonl(file).filter(r => (toNum(r.ts, 0) >= nowMs - windowHours * 60 * 60 * 1000));
  if (productionOnly) {
    rows = rows.filter((r) => {
      const rev = String(r.bLogicRevision ?? '').toLowerCase();
      const schema = toNum(r.logSchemaVersion, 0);
      return rev !== 'test' && schema >= 2;
    });
  }
  if (args.latestRevisionOnly === true) {
    const revs = rows
      .map(r => String(r.bLogicRevision ?? ''))
      .filter(v => v && v !== 'unknown' && v !== 'test');
    const latest = revs.sort((a, b) => a.localeCompare(b)).at(-1);
    if (latest) rows = rows.filter(r => String(r.bLogicRevision ?? '') === latest);
  }
  if (typeof args.sinceRevision === 'string' && args.sinceRevision.trim()) {
    const sinceRev = args.sinceRevision.trim();
    rows = rows.filter(r => String(r.bLogicRevision ?? '') >= sinceRev);
  }
  const report = analyze(rows);
  if (args.json) {
    console.log(JSON.stringify({
      file,
      windowHours,
      productionOnly,
      liveFile,
      latestRevisionOnly: args.latestRevisionOnly === true,
      sinceRevision: typeof args.sinceRevision === 'string' ? args.sinceRevision : null,
      ...report
    }, null, 2));
    return;
  }
  printHuman(report, file, windowHours);
}

main();
