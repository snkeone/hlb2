/**
 * engine/packet.js
 * TEST Engine の UI Packet 生成
 * 
 * 目的:
 * - EngineState から UI用 TEST Packet を生成
 * - 小数点フォーマット統一 (0.1桁)
 * - 既存LIVE Packet形式との互換性維持
 * 
 * 仕様:
 * - type: 'test' 固定
 * - NaN/Infinity は 0.0 にフォールバック
 */

/**
 * round1
 * 小数第1位に丸める (NaN/Infinityは0.0)
 * @param {number} val
 * @returns {number}
 */
function round1(val) {
  if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
    return 0.0;
  }
  return Math.round(val * 10) / 10;
}

/**
 * buildTestPacket
 * EngineState から UI用 TestPacket を生成
 * 
 * @param {Object} state - EngineState
 * @returns {Object} TestPacket
 */
function buildTestPacket(state) {
  if (!state || !state.stats) {
    // 不正な state の場合はゼロパケット
    return {
      type: 'test',
      pnl: 0.0,
      pnlPct: 0.0,
      apr7d: 0.0,
      winRate: 0.0,
      trades: [],
      openPosition: null,
      lastDecision: null,
      lastUpdate: null
    };
  }
  
  const stats = state.stats;
  
  // 勝率計算
  let winRate = 0.0;
  if (stats.totalTrades > 0) {
    winRate = (stats.winTrades / stats.totalTrades) * 100;
  }
  
  // trades を UI 用に整形 (現状はそのまま、将来的にキー名変換可)
  const tradesView = state.trades.map(t => ({
    side: t.side,
    size: round1(t.size),
    entryPx: round1(t.entryPx),
    exitPx: round1(t.exitPx),
    pnl: round1(t.pnl),
    pnlPct: round1(t.pnlPct),
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    reason: t.reason
  }));
  
  // openPosition 整形
  let positionView = null;
  if (state.openPosition) {
    positionView = {
      side: state.openPosition.side,
      size: round1(state.openPosition.size),
      entryPx: round1(state.openPosition.entryPx),
      entryTs: state.openPosition.entryTs
    };
  }
  
  // TestPacket 構築
  return {
    type: 'test',
    pnl: round1(stats.realizedPnl),
    pnlPct: round1(stats.realizedPnlPct),
    apr7d: round1(stats.apr7d),
    winRate: round1(winRate),
    trades: tradesView,
    openPosition: positionView,
    lastDecision: state.lastDecision, // そのまま
    lastUpdate: state.lastUpdate
  };
}

export {
  buildTestPacket
};
