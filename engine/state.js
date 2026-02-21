/**
 * engine/state.js
 * TEST Engine の内部状態定義とユーティリティ関数
 * 
 * 目的:
 * - ポジション・履歴・統計・最終Decisionの構造定義
 * - 初期化・クローン・履歴管理の基本操作
 * 
 * 制約:
 * - 200行以内
 * - ロジック（エントリー/EXIT判定）は含まない
 * - イミュータブル風の操作を提供
 */

// ────────────────────────────────────────
// 型定義 (JSDoc)
// ────────────────────────────────────────

/**
 * @typedef {Object} Position
 * @property {'buy'|'sell'} side
 * @property {number} size
 * @property {number} entryPx
 * @property {number} entryTs
 */

/**
 * @typedef {Object} TradeRecord
 * @property {'buy'|'sell'} side
 * @property {number} size
 * @property {number} entryPx
 * @property {number} exitPx
 * @property {number} pnl - USD金額ベース
 * @property {number} pnlPct - notional対比の%
 * @property {number} openedAt
 * @property {number} closedAt
 * @property {string} reason - Logicのreason
 */

/**
 * @typedef {Object} Stats
 * @property {number} realizedPnl - 累積実現損益 (USD)
 * @property {number} realizedPnlPct - 累積リターン % (pnlPct合算方式)
 * @property {number} winTrades
 * @property {number} loseTrades
 * @property {number} totalTrades
 * @property {number} longTrades - ロング側の対象トレード数（pnl!=0）
 * @property {number} longWins - ロング側の勝ち数
 * @property {number} shortTrades - ショート側の対象トレード数（pnl!=0）
 * @property {number} shortWins - ショート側の勝ち数
 * @property {number} apr7d - 年率換算済み数値
 * @property {TradeRecord[]} history7d - 過去7日分の履歴
 * @property {number|null} midPx
 * @property {number|null} prevMidPx
 * @property {number|null} oi
 */

/**
 * @typedef {Object} LastDecision
 * @property {'buy'|'sell'|'none'} side
 * @property {number} size
 * @property {string} reason
 * @property {number} decidedAt
 */

/**
 * @typedef {Object} EngineState
 * @property {Position|null} openPosition
 * @property {TradeRecord[]} trades - 最大50件
 * @property {Stats} stats
 * @property {LastDecision|null} lastDecision
 * @property {number|null} lastUpdate
 * @property {Object} safety - SAFETY状態 { status, reason, since }
 */

// ────────────────────────────────────────
// 公開関数
// ────────────────────────────────────────

/**
 * createInitialState
 * 全フィールドを0/null初期化したEngineStateを返す
 * @returns {EngineState}
 */
function createInitialState() {
  return {
    openPosition: null,
    trades: [],
    stats: {
      realizedPnl: 0.0,
      realizedPnlPct: 0.0,
      winTrades: 0,
      loseTrades: 0,
      totalTrades: 0,
      longTrades: 0,
      longWins: 0,
      shortTrades: 0,
      shortWins: 0,
      apr7d: 0.0,
      history7d: [],
      midPx: null,
      prevMidPx: null,
      oi: null
    },
    lastDecision: null,
    lastUpdate: null,
    lastTickTs: null,
    lastLoopAtMs: null,    // ループサイクル時刻（運用状態判定用）
    lastMarketAtMs: null,  // 市場データ更新時刻（データ新鮮度判定用）
    riskGuards: {
      lastLossAt: null,
      lastHardSlAt: null
    },
    performanceGuards: {
      blockNewEntries: false,
      reason: null,
      triggeredAt: null,
      peakEquityUsd: null,
      lastEquityUsd: null
    },
    safety: {
      status: 'NORMAL',
      reason: null,
      since: null
    }
  };
}

/**
 * cloneState
 * EngineStateを新しいオブジェクトとしてディープコピー
 * @param {EngineState} state
 * @returns {EngineState}
 */
function cloneState(state) {
  return {
    openPosition: state.openPosition ? { ...state.openPosition } : null,
    trades: [...state.trades],
    stats: {
      ...state.stats,
      history7d: [...state.stats.history7d]
    },
    lastDecision: state.lastDecision ? { ...state.lastDecision } : null,
    lastUpdate: state.lastUpdate,
    lastTickTs: state.lastTickTs ?? null,
    lastLoopAtMs: state.lastLoopAtMs ?? null,
    lastMarketAtMs: state.lastMarketAtMs ?? null,
    riskGuards: {
      lastLossAt: state.riskGuards?.lastLossAt ?? null,
      lastHardSlAt: state.riskGuards?.lastHardSlAt ?? null
    },
    performanceGuards: {
      blockNewEntries: !!state.performanceGuards?.blockNewEntries,
      reason: state.performanceGuards?.reason ?? null,
      triggeredAt: state.performanceGuards?.triggeredAt ?? null,
      peakEquityUsd: state.performanceGuards?.peakEquityUsd ?? null,
      lastEquityUsd: state.performanceGuards?.lastEquityUsd ?? null
    },
    safety: state.safety ? { ...state.safety } : null
  };
}

/**
 * pushTrade
 * tradesの末尾にtradeを追加し、maxTradesを超える古いものを削除
 * @param {EngineState} state
 * @param {TradeRecord} trade
 * @param {number} maxTrades - デフォルト50
 * @returns {EngineState}
 */
function pushTrade(state, trade, maxTrades = 50) {
  const newTrades = [...state.trades, trade];
  
  // 古いものを先頭から削除
  while (newTrades.length > maxTrades) {
    newTrades.shift();
  }
  
  return {
    ...state,
    trades: newTrades
  };
}

/**
 * cleanupHistory7d
 * Stats.history7dから7日より古いものを削除
 * @param {EngineState} state
 * @param {number} nowTs - 現在時刻 (epoch millis)
 * @returns {EngineState}
 */
function cleanupHistory7d(state, nowTs) {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoffTs = nowTs - SEVEN_DAYS_MS;
  
  const filtered = state.stats.history7d.filter(
    trade => trade.closedAt >= cutoffTs
  );
  
  return {
    ...state,
    stats: {
      ...state.stats,
      history7d: filtered
    }
  };
}

/**
 * updateMarketState
 * prev と current を受け取り、marketState を生成
 * IO層からバインド用に提供される関数
 * @param {Object} prev - 前回の状態
 * @param {Object} current - 現在の状態
 * @returns {Object} - { prev, current }
 */
function updateMarketState(prev, current) {
  return { prev, current };
}

// ────────────────────────────────────────
// エクスポート
// ────────────────────────────────────────

export {
  createInitialState,
  cloneState,
  pushTrade,
  cleanupHistory7d,
  updateMarketState
};
