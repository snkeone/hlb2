// core/shutdownLogger.js
// BOT停止時に markers.jsonl にシャットダウン情報を記録

import fs from 'fs';
import path from 'path';

/**
 * trades.jsonl からセッション統計を計算
 * @param {string} tradesLogPath - trades.jsonl のパス
 * @returns {object} 統計オブジェクト
 */
export function calculateSessionStats(tradesLogPath) {
  try {
    if (!fs.existsSync(tradesLogPath)) {
      return null;
    }

    const raw = fs.readFileSync(tradesLogPath, 'utf8');
    const lines = raw.trim().split('\n').filter(l => l.length > 0);
    
    if (lines.length === 0) {
      return null;
    }

    const trades = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    }).filter(t => t !== null);

    if (trades.length === 0) {
      return null;
    }

    // 統計計算
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let maxDD = 0;
    let cumulativePnl = 0;
    let peakPnl = 0;
    let lastPosition = 'flat';

    for (const trade of trades) {
      const pnl = trade.realizedPnlUsd || 0;
      totalPnl += pnl;
      cumulativePnl += pnl;

      // DD計算
      if (cumulativePnl < peakPnl) {
        const dd = peakPnl - cumulativePnl;
        maxDD = Math.max(maxDD, dd);
      } else {
        peakPnl = cumulativePnl;
      }

      // 勝敗判定
      if (pnl > 0) {
        wins++;
        grossProfit += pnl;
      } else if (pnl < 0) {
        losses++;
        grossLoss += Math.abs(pnl);
      }

      // 最終ポジション状態
      lastPosition = trade.side === 'buy' ? 'long' : trade.side === 'sell' ? 'short' : 'flat';
    }

    const totalTrades = trades.length;
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;

    return {
      trades: totalTrades,
      wins,
      losses,
      pnl: parseFloat(totalPnl.toFixed(2)),
      pf: parseFloat(pf.toFixed(2)),
      winRate: parseFloat(winRate.toFixed(3)),
      maxDD: parseFloat(maxDD.toFixed(2)),
      position: lastPosition
    };
  } catch (err) {
    console.error('[SHUTDOWN] calculateSessionStats error:', err);
    return null;
  }
}

/**
 * markers.jsonl に shutdown イベントを記録
 * @param {string} reason - 停止理由（SIGTERM など）
 * @param {number} uptimeMs - プロセス稼働時間（ms）
 * @param {object} stats - セッション統計
 */
export function logShutdown(reason = 'unknown', uptimeMs = 0, stats = null) {
  try {
    // 1世代バックアップ: trades.jsonl → trades.jsonl.prev
    const tradesPath = path.resolve(process.cwd(), 'logs/trades.jsonl');
    const tradesPrevPath = path.resolve(process.cwd(), 'logs/trades.jsonl.prev');
    
    if (fs.existsSync(tradesPath)) {
      const tradesStat = fs.statSync(tradesPath);
      if (tradesStat.size > 0) {
        // trades.jsonl が存在し、サイズが 0 より大きい場合のみバックアップ
        fs.copyFileSync(tradesPath, tradesPrevPath);
        console.log('[SHUTDOWN] trades.jsonl backed up to trades.jsonl.prev');
      }
    }

    const markersPath = path.resolve(process.cwd(), 'logs/markers.jsonl');
    const uptimeHours = (uptimeMs / (1000 * 60 * 60)).toFixed(2);
    
    const shutdownRecord = {
      ts: Date.now(),
      type: 'shutdown',
      reason,
      uptime_hours: parseFloat(uptimeHours),
      uptime_ms: uptimeMs,
      stopped_at: new Date().toISOString()
    };

    // セッション統計が取れた場合は追加
    if (stats) {
      shutdownRecord.session_stats = stats;
    }

    const line = JSON.stringify(shutdownRecord);
    fs.appendFileSync(markersPath, line + '\n');
    
    console.log('[SHUTDOWN] logged to markers.jsonl');
  } catch (err) {
    console.error('[SHUTDOWN] logShutdown error:', err);
  }
}

/**
 * プロセス開始時刻を取得（グローバルで保存）
 */
export let processStartTime = Date.now();

export function setProcessStartTime(ts) {
  processStartTime = ts;
}
