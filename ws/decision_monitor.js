const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_LEN = 50000;
// ENTRY FILTERS: Bロジックでをぐられた理由の整理店
// - gate_denied: Aゲートでくおり殤止
// - no_depth_sr: 松扯依存欠欠
// - sr_distance: SR距離ガード対象
// - tp_failed: TP/SL計算失敗
// - expected_value_low: 期待値が低い
const REASONS = ['gate_denied', 'no_depth_sr', 'sr_distance', 'tp_failed', 'expected_value_low'];

function createDecisionMonitor(options = {}) {
  const windowMs = typeof options.windowMs === 'number' ? options.windowMs : DEFAULT_WINDOW_MS;
  const maxLen = typeof options.maxLen === 'number' ? options.maxLen : DEFAULT_MAX_LEN;
  const events = [];
  let warnedMaxLen = false;

  function prune(nowMs) {
    const cutoff = nowMs - windowMs;
    while (events.length > 0 && events[0].ts < cutoff) {
      events.shift();
    }
  }

  function addEvent(event) {
    if (!event || typeof event.ts !== 'number') return;
    events.push(event);
    if (events.length > maxLen) {
      const overflow = events.length - maxLen;
      events.splice(0, overflow);
      if (!warnedMaxLen) {
        warnedMaxLen = true;
        console.warn('[DecisionMonitor] maxLen exceeded, dropping oldest');
      }
    }
    prune(event.ts);
  }

  function getSnapshot(options = {}) {
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    const route = typeof options.route === 'string' ? options.route : null;
    prune(nowMs);
    const sample = route ? events.filter((ev) => ev.route === route) : events;

    let evaluated = 0;
    let entered = 0;
    let skippedTotal = 0;
    const skippedByReason = {
      gate_denied: 0,
      no_depth_sr: 0,
      sr_distance: 0,
      tp_failed: 0,
      expected_value_low: 0
    };
    const skippedByRawReason = Object.create(null);
    let skippedRawTotal = 0;

    for (const ev of sample) {
      if (!ev) continue;
      evaluated += 1;
      if (ev.decision === 'enter') {
        entered += 1;
        continue;
      }
      if (ev.decision === 'none' && ev.reason) {
        skippedTotal += 1;
        if (REASONS.includes(ev.reason)) {
          skippedByReason[ev.reason] += 1;
        }
      }
      if (ev.decision === 'none' && typeof ev.rawReason === 'string' && ev.rawReason.trim().length > 0) {
        const raw = ev.rawReason.trim();
        skippedRawTotal += 1;
        skippedByRawReason[raw] = (skippedByRawReason[raw] ?? 0) + 1;
      }
    }

    const skippedPctByReason = {
      gate_denied: 0,
      no_depth_sr: 0,
      sr_distance: 0,
      tp_failed: 0,
      expected_value_low: 0
    };
    for (const reason of REASONS) {
      if (skippedTotal > 0) {
        skippedPctByReason[reason] = Math.round((skippedByReason[reason] / skippedTotal) * 100);
      }
    }
    const topRawReasons = Object.entries(skippedByRawReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({
        reason,
        count,
        pct: skippedRawTotal > 0 ? Math.round((count / skippedRawTotal) * 100) : 0
      }));
    const topAGateReasons = Object.entries(skippedByRawReason)
      .filter(([reason]) => /^A:/i.test(String(reason)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([reason, count]) => ({
        reason,
        count,
        pct: skippedRawTotal > 0 ? Math.round((count / skippedRawTotal) * 100) : 0
      }));

    // REGIME ALIGNMENT統計：UP/DOWN/RANGEごとのevaluated/allowed数
    const regimeStats = {
      UP: { evaluated: 0, allowed: 0, rate: 0 },
      DOWN: { evaluated: 0, allowed: 0, rate: 0 },
      RANGE: { evaluated: 0, allowed: 0, rate: 0 }
    };
    
    for (const ev of sample) {
      if (!ev || !ev.regime) continue;
      const regime = ev.regime;
      if (regime === 'UP' || regime === 'DOWN' || regime === 'RANGE') {
        regimeStats[regime].evaluated += 1;
        if (ev.decision === 'enter' || (ev.decision === 'none' && !ev.reason)) {
          regimeStats[regime].allowed += 1;
        }
      }
    }
    
    // rate計算
    for (const regime of ['UP', 'DOWN', 'RANGE']) {
      if (regimeStats[regime].evaluated > 0) {
        regimeStats[regime].rate = Math.round((regimeStats[regime].allowed / regimeStats[regime].evaluated) * 100);
      }
    }

    return {
      windowMinutes: Math.round(windowMs / 60000),
      evaluated,
      entered,
      entryRate: evaluated > 0 ? entered / evaluated : 0,
      entryRatePct: evaluated > 0 ? (entered / evaluated) * 100 : 0,
      skippedTotal,
      skippedByReason,
      topRawReasons,
      topAGateReasons,
      skippedPctByReason,
      regimeStats,
      events: sample.slice(-20) // 直近20件のイベントを含める（UI LOG表示用）
    };
  }

  return {
    addEvent,
    getSnapshot
  };
}

export { createDecisionMonitor };
