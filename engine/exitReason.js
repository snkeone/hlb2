// EXIT理由を定型ラベルにマッピング + 詳細情報を返す
function mapExitReason(raw, entryPx, exitPx, context = {}) {
  const missingPx = !Number.isFinite(entryPx) || !Number.isFinite(exitPx);
  if (missingPx) {
    return {
      reason: 'SYSTEM',
      signal: 'bot_restart',
      detail: 'BOT restarted, entry/exit price missing'
    };
  }
  if (!raw) {
    return {
      reason: 'SYSTEM',
      signal: 'unknown',
      detail: null
    };
  }
  const r = raw.toString().toLowerCase();

  if (r.includes('flow_adaptive_take_profit')) {
    return {
      reason: 'TP',
      signal: 'flow_adaptive_take_profit',
      detail: 'Flow-adaptive take profit: hostile flow detected after progress'
    };
  }

  if (r.includes('burst_adverse_exit')) {
    return {
      reason: 'FLOW',
      signal: 'burst_adverse_exit',
      detail: 'Micro burst exit: adverse high-rate trade flow detected'
    };
  }

  if (r.includes('environment_drift_exit')) {
    return {
      reason: 'DRIFT',
      signal: 'environment_drift_exit',
      detail: 'Environment drift exit: entry premise shifted (regime/map/flow)'
    };
  }

  if (r.includes('shield_collapse') || r.includes('wall_ahead') || r.includes('flow_imbalance')) {
    return {
      reason: 'DEPTH',
      signal: r.includes('shield_collapse')
        ? 'shield_collapse_exit'
        : (r.includes('wall_ahead') ? 'wall_ahead_exit' : 'flow_imbalance_exit'),
      detail: 'Depth-aware exit triggered by realtime orderbook change'
    };
  }

  if (r.includes('tp') || r.includes('take_profit')) {
    const tpDist = context.tpDistanceUsd;
    const detail = Number.isFinite(tpDist) ? `TP reached, target distance: ${tpDist.toFixed(2)} USD` : null;
    return { reason: 'TP', signal: 'tp_hit', detail };
  }

  if (
    r.includes('sl') ||
    r.includes('stop_loss') ||
    r.includes('loss_clamp') ||
    r.includes('hard_sl') ||
    r.includes('soft_sl') ||
    r.includes('stress_cut')
  ) {
    const maxAdverse = context.maxAdverseRatio;
    const detail = Number.isFinite(maxAdverse)
      ? `SL triggered, max adverse ratio: ${(maxAdverse * 100).toFixed(2)}%`
      : null;
    return { reason: 'SL', signal: 'sl_hit', detail };
  }

  if (r.includes('timeout') || r.includes('time')) {
    const holdMs = context.holdMs;
    const detail = Number.isFinite(holdMs)
      ? `Position held for ${(holdMs / 1000).toFixed(0)}s, timeout exceeded`
      : null;
    return { reason: 'TIMEOUT', signal: 'timeout_close', detail };
  }

  if (r.includes('manual')) {
    return { reason: 'MANUAL', signal: 'manual_close', detail: 'Manual close by operator' };
  }

  if (r.includes('exit') || r.includes('entry allowed')) {
    return {
      reason: 'SYSTEM',
      signal: 'reverse_side_close',
      detail: 'B returned opposite side during hold'
    };
  }

  return {
    reason: 'SYSTEM',
    signal: 'unknown',
    detail: null
  };
}

export { mapExitReason };
