import { getInitialCapitalUsd } from '../config/capital.js';

function ensureRiskGuardState(state) {
  return {
    lastLossAt: Number.isFinite(Number(state?.lastLossAt)) ? Number(state.lastLossAt) : null,
    lastHardSlAt: Number.isFinite(Number(state?.lastHardSlAt)) ? Number(state.lastHardSlAt) : null
  };
}

function updateRiskGuardState(prev, reason, pnl, nowTs) {
  const next = ensureRiskGuardState(prev);
  const reasonStr = String(reason || '').toLowerCase();
  if (Number.isFinite(pnl) && pnl < 0) {
    next.lastLossAt = nowTs;
  } else if (Number.isFinite(pnl) && pnl > 0) {
    next.lastLossAt = null;
  }
  if (reasonStr === 'hard_sl_ratio') {
    next.lastHardSlAt = nowTs;
  }
  return next;
}

function toTradeNetPnl(trade) {
  const net = Number(trade?.pnlNet);
  if (Number.isFinite(net)) return net;
  const gross = Number(trade?.pnl);
  return Number.isFinite(gross) ? gross : 0;
}

function evaluatePerformanceGuards(state, tradeConfig, nowTs) {
  const cfg = tradeConfig?.performanceGuards ?? {};
  const enabled = cfg.enabled !== false;
  const prev = state.performanceGuards && typeof state.performanceGuards === 'object'
    ? state.performanceGuards
    : {};
  const initialCapital = Number(getInitialCapitalUsd());
  const base = Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : null;
  const realized = Number(state?.stats?.realizedPnl ?? 0);
  const equityUsd = base != null && Number.isFinite(realized) ? (base + realized) : null;
  const prevPeak = Number(prev.peakEquityUsd);
  const peakEquityUsd = Number.isFinite(equityUsd)
    ? (Number.isFinite(prevPeak) ? Math.max(prevPeak, equityUsd) : equityUsd)
    : (Number.isFinite(prevPeak) ? prevPeak : null);
  let next = {
    blockNewEntries: !!prev.blockNewEntries,
    reason: prev.reason ?? null,
    triggeredAt: prev.triggeredAt ?? null,
    peakEquityUsd,
    lastEquityUsd: Number.isFinite(equityUsd) ? equityUsd : (prev.lastEquityUsd ?? null)
  };
  if (!enabled) return next;

  const inMemoryTrades = Array.isArray(state?.trades) ? state.trades.length : 0;
  if (inMemoryTrades === 0) {
    const prevReason = String(next.reason ?? '');
    if (prevReason.startsWith('kpi_guard_') || prevReason.length === 0) {
      next.blockNewEntries = false;
      next.reason = null;
      next.triggeredAt = null;
    }
  }

  const lockOnTrigger = cfg.lockOnTrigger !== false;
  const autoResume = cfg.autoResume === true;
  const resumeCooldownMs = Math.max(60000, Number(cfg.resumeCooldownMs ?? 3600000));
  const maxDrawdownPct = Math.max(1, Number(cfg.maxDrawdownPct ?? 12));
  const kpiWindowTrades = Math.max(5, Math.floor(Number(cfg.kpiWindowTrades ?? 30)));
  const minAvgNetUsd = Number(cfg.minAvgNetUsd ?? -0.05);
  const minAvgWinUsd = Math.max(0, Number(cfg.minAvgWinUsd ?? 0.45));
  const minWinRate = Math.min(0.95, Math.max(0.05, Number(cfg.minWinRate ?? 0.28)));

  let triggerReason = null;
  if (Number.isFinite(equityUsd) && Number.isFinite(peakEquityUsd) && peakEquityUsd > 0) {
    const ddPct = ((peakEquityUsd - equityUsd) / peakEquityUsd) * 100;
    if (ddPct >= maxDrawdownPct) triggerReason = `max_drawdown_${ddPct.toFixed(2)}pct`;
  }

  if (!triggerReason) {
    const recent = Array.isArray(state?.trades) ? state.trades.slice(-kpiWindowTrades) : [];
    if (recent.length >= kpiWindowTrades) {
      const netList = recent.map(toTradeNetPnl).filter(v => Number.isFinite(v));
      const winList = netList.filter(v => v > 0);
      const lossList = netList.filter(v => v < 0);
      const n = winList.length + lossList.length;
      if (n >= kpiWindowTrades) {
        const avgNet = netList.reduce((a, b) => a + b, 0) / Math.max(1, netList.length);
        const avgWin = winList.reduce((a, b) => a + b, 0) / Math.max(1, winList.length);
        const winRate = winList.length / Math.max(1, n);
        const kpiWeak = avgNet < minAvgNetUsd && (winRate < minWinRate || avgWin < minAvgWinUsd);
        if (kpiWeak) {
          triggerReason = `kpi_guard_avgNet=${avgNet.toFixed(3)}_winRate=${(winRate * 100).toFixed(1)}_avgWin=${avgWin.toFixed(3)}`;
        }
      }
    }
  }

  if (triggerReason) {
    next.blockNewEntries = lockOnTrigger || next.blockNewEntries;
    next.reason = triggerReason;
    next.triggeredAt = nowTs;
    return next;
  }

  if (next.blockNewEntries && autoResume) {
    const ts = Number(next.triggeredAt);
    const cooldownOk = !Number.isFinite(ts) || (nowTs - ts) >= resumeCooldownMs;
    if (cooldownOk) {
      next.blockNewEntries = false;
      next.reason = null;
      next.triggeredAt = null;
    }
  }

  return next;
}

export { ensureRiskGuardState, updateRiskGuardState, evaluatePerformanceGuards };
