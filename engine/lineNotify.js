import axios from 'axios';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { getInitialCapitalUsd } from '../config/capital.js';
import { getBaseEquityLiveUsd } from '../config/equity.js';
import { resolveTradesPath } from '../config/tradesPath.js';

const { LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID, lineNotify: lineNotifyCfg = {} } = config;
// Priority: process.env > config > default ('0' = disabled)
// トレード通知: デフォルトOFF（メール移行済み）
const envTradesEnabled = process.env.LINE_NOTIFY_TRADES_ENABLED;
const cfgTradesEnabled = lineNotifyCfg.tradesEnabled;
const LINE_NOTIFY_TRADES_ENABLED = (envTradesEnabled ?? (cfgTradesEnabled ? '1' : '0')) !== '0';

// マスター／種別フラグ（デフォルト: master=ON, others=OFF）
const envEnabled = process.env.LINE_NOTIFY_ENABLED;
const cfgEnabled = lineNotifyCfg.enabled;
const LINE_NOTIFY_ENABLED = (envEnabled ?? (cfgEnabled !== undefined ? (cfgEnabled ? '1' : '0') : '1')) !== '0';

// 勝率マイルストーン: デフォルトOFF（メール移行済み）
const envWinrateEnabled = process.env.LINE_NOTIFY_WINRATE_ENABLED;
const cfgWinrateEnabled = lineNotifyCfg.winrateEnabled;
const LINE_NOTIFY_WINRATE_ENABLED = (envWinrateEnabled ?? (cfgWinrateEnabled ? '1' : '0')) !== '0';

const envGenericEnabled = process.env.LINE_NOTIFY_GENERIC_ENABLED;
const cfgGenericEnabled = lineNotifyCfg.genericEnabled;
const LINE_NOTIFY_GENERIC_ENABLED = (envGenericEnabled ?? (cfgGenericEnabled ? '1' : '0')) !== '0';

// 異常アラート: デフォルトON（推奨設定）
const envAlertsEnabled = process.env.LINE_NOTIFY_ALERTS_ENABLED;
const cfgAlertsEnabled = lineNotifyCfg.alertsEnabled;
const LINE_NOTIFY_ALERTS_ENABLED = (envAlertsEnabled ?? (cfgAlertsEnabled !== undefined ? (cfgAlertsEnabled ? '1' : '0') : '1')) !== '0';

// 日次/週次レポート通知: デフォルトOFF（alerts only 運用向け）
const envReportsEnabled = process.env.LINE_NOTIFY_REPORTS_ENABLED;
const cfgReportsEnabled = lineNotifyCfg.reportsEnabled;
const LINE_NOTIFY_REPORTS_ENABLED = (envReportsEnabled ?? (cfgReportsEnabled ? '1' : '0')) !== '0';

const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const notifiedTradeIds = new Set();
const LINE_NOTIFY_STATE_PATH = path.join(process.cwd(), 'config', 'lineNotifyState.json');
let lastPnlParseWarnAt = 0;

const DEFAULT_NOTIFY_STATE = {
  version: '1.1',
  lastRecordedWinRate: null,
  lastNotifiedAt: { 55: null, 52: null, 50: null },
  monthlyNotificationCount: 0,
  currentWinRate: null,
  lastUpdateTimestamp: null,
  currentMonth: null,
  limitReachedNotified: false,
  lastDailyMorningSentAt: null,
  lastDailyEveningSentAt: null,
  lastWeeklySentAt: null,
  alertCooldowns: {}
};

function normalizeSide(side) {
  if (!side) return 'UNKNOWN';
  const s = side.toString().toLowerCase();
  if (s === 'buy' || s === 'long') return 'LONG';
  if (s === 'sell' || s === 'short') return 'SHORT';
  return side.toString().toUpperCase();
}

function getBaseEquity() {
  const mode = (process.env.MODE || '').toLowerCase();
  if (mode === 'live') {
    const liveBase = getBaseEquityLiveUsd();
    return Number.isFinite(liveBase) && liveBase > 0 ? liveBase : null;
  }
  const testBase = getInitialCapitalUsd();
  return Number.isFinite(testBase) && testBase > 0 ? testBase : null;
}

function resolveTotalPnlUsd(totalPnlUsdFallback) {
  try {
    const tradesPath = resolveTradesPath();
    if (fs.existsSync(tradesPath)) {
      const data = fs.readFileSync(tradesPath, 'utf-8');
      const lines = data.split('\n').filter(l => l.trim());
      let sum = 0;
      let count = 0;
      let parseErrors = 0;
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          const pnl = Number(record.realizedPnlUsd ?? record.pnl ?? 0);
          if (Number.isFinite(pnl)) {
            sum += pnl;
            count += 1;
          }
        } catch (_) {
          parseErrors += 1;
          continue;
        }
      }
      if (parseErrors > 0) {
        const now = Date.now();
        if (!lastPnlParseWarnAt || (now - lastPnlParseWarnAt) > 60 * 60 * 1000) {
          lastPnlParseWarnAt = now;
          console.warn(`[LINE_NOTIFY] trades.jsonl parse errors: ${parseErrors}`);
        }
      }
      if (count > 0) {
        return sum;
      }
    }
  } catch (_) {
    // noop: fallback below
  }
  const fallback = Number(totalPnlUsdFallback);
  return Number.isFinite(fallback) ? fallback : null;
}

function formatSignedUsd(value) {
  const num = Number(value);
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num > 0) return `▲ $${formatted}`;
  if (num < 0) return `▼ $${formatted}`;
  return `— $${formatted}`;
}

function formatSignedUsdPlain(value) {
  const num = Number(value);
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (num > 0) return `+$${formatted}`;
  if (num < 0) return `-$${formatted}`;
  return `$${formatted}`;
}

function formatUsdPlain(value) {
  const num = Number(value);
  const formatted = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `$${formatted}`;
}

function formatNegativeUsdPlain(value) {
  const num = Math.abs(Number(value));
  const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `-$${formatted}`;
}

function getJstDateParts(ts = Date.now()) {
  const jst = new Date(ts + 9 * 60 * 60 * 1000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    dayOfWeek: jst.getUTCDay()
  };
}

function toJstTimestamp(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
}

function formatJstDate(ts) {
  const p = getJstDateParts(ts);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${mm}/${dd}`;
}

function formatJstDateTime(ts) {
  const p = getJstDateParts(ts);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  const hh = String(p.hour).padStart(2, '0');
  const min = String(p.minute).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

function buildLineMessage(trade, totalPnlUsd) {
  const sideText = normalizeSide(trade.side);
  // trades.jsonl の現在のフィールド構造に対応
  const tradePnl = trade.realizedPnlUsd ?? trade.pnl ?? 0;
  const resultText = tradePnl > 0 ? 'WIN' : tradePnl < 0 ? 'LOSS' : 'FLAT';
  const baseEquity = getBaseEquity();
  const totalPnlValue = resolveTotalPnlUsd(totalPnlUsd);
  const equityUsd = baseEquity && totalPnlValue !== null ? baseEquity + totalPnlValue : null;
  const equityText = equityUsd === null ? '—' : `$${equityUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  // このトレードの損益を表示
  const tradePnlText = formatSignedUsd(tradePnl);
  // 累積損益を表示
  const totalPnlText = totalPnlValue !== null ? formatSignedUsd(totalPnlValue) : '—';
  
  // exitReason または signal を使用
  const exitInfo = trade.exitReason || trade.signal || '-';
  
  return [
    'HLB TRADE',
    '',
    `SIDE: ${sideText}`,
    `RESULT: ${resultText}`,
    `PnL: ${tradePnlText}`,
    `TOTAL: ${totalPnlText}`,
    `EQUITY: ${equityText}`,
    '',
    `EXIT: ${exitInfo}`
  ].join('\n');
}

async function notifyLine(trade, totalPnlUsd) {
  if (!LINE_NOTIFY_ENABLED || !LINE_NOTIFY_TRADES_ENABLED) {
    return;
  }
  if (!trade || !trade.tradeId) {
    console.warn('[LINE_NOTIFY] skip: invalid trade');
    return;
  }
  if (notifiedTradeIds.has(trade.tradeId)) {
    console.log(`[LINE_NOTIFY] skip duplicate tradeId=${trade.tradeId}`);
    return;
  }

  const text = buildLineMessage(trade, totalPnlUsd);
  const sent = await sendLineText(text, { kind: 'trade' });
  if (sent) {
    notifiedTradeIds.add(trade.tradeId);
  }
}

// ================================================================================
// WINRATE MILESTONE NOTIFICATION
// ================================================================================

/**
 * Dashboard metrics 計算（WebUI と同一ロジック）
 * @param {Array} trades - トレード配列 [{pnl, side, ...}]
 * @param {Number} baseEquity - 基準残高
 * @returns {Object} metrics - 全指標（PF/RR/AV.WIN/AV.LOSS/MAX DD）
 */
function calcDashboardMetrics(trades, baseEquity) {
  const metrics = {
    pf: null,
    pfDisplay: '-- (N/A)',
    pfLabel: '',
    rr: null,
    rrDisplay: '-- (N/A)',
    rrLabel: '',
    avWin: 0,
    avWinDisplay: '▲ $0.00',
    avLoss: 0,
    avLossDisplay: '▼ $0.00',
    maxDD: 0,
    maxDDDisplay: '▼ $0.00',
    trustFlag: ''
  };
  
  if (trades.length === 0) {
    metrics.trustFlag = '🔴';
    return metrics;
  }
  
  // PF calculation
  const wins = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  
  if (losses === 0) {
    if (wins > 0) {
      metrics.pf = Infinity;
      metrics.pfDisplay = '∞';
      metrics.pfLabel = 'STRONG';
    }
  } else {
    const pfValue = wins / losses;
    metrics.pf = pfValue;
    metrics.pfDisplay = pfValue.toFixed(2);
    
    // PF Label
    if (pfValue < 1.2) metrics.pfLabel = 'BAD';
    else if (pfValue < 1.3) metrics.pfLabel = 'POOR';
    else if (pfValue < 1.6) metrics.pfLabel = 'OK';
    else if (pfValue < 2.0) metrics.pfLabel = 'GOOD';
    else metrics.pfLabel = 'STRONG';
  }
  
  // RR / AV.WIN / AV.LOSS
  const winTradesList = trades.filter(t => t.pnl > 0);
  const lossTradesList = trades.filter(t => t.pnl < 0);
  
  const avgWin = winTradesList.length > 0
    ? winTradesList.reduce((sum, t) => sum + t.pnl, 0) / winTradesList.length
    : 0;
  
  const avgLoss = lossTradesList.length > 0
    ? Math.abs(lossTradesList.reduce((sum, t) => sum + t.pnl, 0) / lossTradesList.length)
    : 0;
  
  // RR (Risk-Reward Ratio)
  if (avgLoss === 0) {
    metrics.rr = avgWin > 0 ? Infinity : 0;
    metrics.rrDisplay = avgWin > 0 ? '∞' : '0.00';
    metrics.rrLabel = avgWin > 0 ? 'GOOD' : 'BAD';
  } else {
    const rrValue = avgWin / avgLoss;
    metrics.rr = rrValue;
    metrics.rrDisplay = rrValue.toFixed(2);
    
    // RR Label
    if (rrValue < 1.0) metrics.rrLabel = 'BAD';
    else if (rrValue < 1.2) metrics.rrLabel = 'POOR';
    else if (rrValue < 1.5) metrics.rrLabel = 'OK';
    else metrics.rrLabel = 'GOOD';
  }
  
  // AV.WIN (average win) - format with ▲ and K notation
  if (avgWin >= 1000) {
    metrics.avWinDisplay = `▲ $${(avgWin / 1000).toFixed(2)}K`;
  } else {
    metrics.avWinDisplay = `▲ $${avgWin.toFixed(2)}`;
  }
  metrics.avWin = avgWin;
  
  // AV.LOSS (average loss) - format with ▼ and K notation
  if (avgLoss >= 1000) {
    metrics.avLossDisplay = `▼ $${(avgLoss / 1000).toFixed(2)}K`;
  } else {
    metrics.avLossDisplay = `▼ $${avgLoss.toFixed(2)}`;
  }
  metrics.avLoss = avgLoss;
  
  // MAX DD (maximum drawdown)
  let peak = baseEquity;
  let maxDD = 0;
  let cumPnl = 0;
  
  // 時系列ソート
  const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  
  for (const t of sortedTrades) {
    const tPnl = t.realizedPnlUsd ?? t.pnl ?? 0;
    cumPnl += tPnl;
    const equity = baseEquity + cumPnl;
    
    if (equity > peak) {
      peak = equity;
    }
    
    const drawdown = peak - equity;
    if (drawdown > maxDD) {
      maxDD = drawdown;
    }
  }
  
  metrics.maxDD = maxDD;
  if (maxDD >= 1000) {
    metrics.maxDDDisplay = `▼ $${(maxDD / 1000).toFixed(2)}K`;
  } else {
    metrics.maxDDDisplay = `▼ $${maxDD.toFixed(2)}`;
  }
  
  // Trust Flag
  if (trades.length < 10) metrics.trustFlag = '🔴';
  else if (trades.length < 30) metrics.trustFlag = '🟡';
  else metrics.trustFlag = '🟢';
  
  return metrics;
}

/**
 * trades.jsonl を読み込んで勝率を計算
 * キャッシング: 前回結果を保持、新規 trade 時のみ再計算
 */
let lastCalculated = null;
let lastValidWinRate = null;
let lastTradeCount = 0;

function calculateWinRate() {
  try {
    // ✅ 必須: ファイル存在確認（ウォームアップ中の初回クラッシュ防止）
    // runtime / tradeLogger と同じパス解決ロジックを使用（resolveTradesPath）
    const tradesPath = resolveTradesPath(process.env.MODE, process.env.LOG_TRADES_PATH);
    if (!fs.existsSync(tradesPath)) {
      return lastValidWinRate || { 
        total: 0, long: 0, short: 0, 
        winCount: 0, lossCount: 0, 
        longCount: 0, shortCount: 0, 
        timestamp: null 
      };
    }
    
    const data = fs.readFileSync(tradesPath, 'utf-8');
    const lines = data.split('\n').filter(l => l.trim());
    
    // キャッシュチェック: trade数が同じなら再計算不要
    if (lastCalculated && lines.length === lastTradeCount) {
      return lastCalculated;
    }
    
    let winCount = 0, lossCount = 0;
    let longWins = 0, longLosses = 0;
    let shortWins = 0, shortLosses = 0;
    
    for (const line of lines) {
      // ✅ 必須: JSON.parse エラーハンドリング（破損行スキップ）
      let trade;
      try {
        trade = JSON.parse(line);
      } catch (parseErr) {
        console.warn('[WINRATE] invalid JSON line, skipping:', line.substring(0, 50));
        continue;
      }
      
      // pnl=0 は除外（FLAT トレード）
      const tradePnl = trade.realizedPnlUsd ?? trade.pnl ?? 0;
      if (tradePnl === 0) continue;
      
      const isWin = tradePnl > 0;
      const sideNorm = (trade.side || '').toString().toLowerCase();
      const isLong = sideNorm === 'buy' || sideNorm === 'long';
      
      if (isWin) {
        winCount++;
        if (isLong) longWins++;
        else shortWins++;
      } else {
        lossCount++;
        if (isLong) longLosses++;
        else shortLosses++;
      }
    }
    
    const totalTrades = winCount + lossCount;
    const longTotal = longWins + longLosses;
    const shortTotal = shortWins + shortLosses;
    
    const result = {
      total: totalTrades > 0 ? (winCount / totalTrades) * 100 : 0,
      long: longTotal > 0 ? (longWins / longTotal) * 100 : 0,
      short: shortTotal > 0 ? (shortWins / shortTotal) * 100 : 0,
      winCount,
      lossCount,
      longCount: longTotal,
      shortCount: shortTotal,
      timestamp: new Date().toISOString()
    };
    
    lastCalculated = result;
    lastValidWinRate = result;
    lastTradeCount = lines.length;
    
    return result;
    
  } catch (err) {
    console.error('[WINRATE] calculation error:', err.message);
    return lastValidWinRate || { 
      total: 0, long: 0, short: 0, 
      winCount: 0, lossCount: 0, 
      longCount: 0, shortCount: 0, 
      timestamp: null 
    };
  }
}

/**
 * キャッシュクリア付き勝率計算（強制再計算）
 */
function calculateWinRateCached(forceRefresh = false) {
  if (forceRefresh) {
    lastCalculated = null;
    lastTradeCount = 0;
  }
  return calculateWinRate();
}

/**
 * 勝率通知メッセージを生成（Phase 1: METRICS 追加）
 */
function buildWinRateMessage(winRateData, totalPnlUsd, threshold, metrics) {
  const baseEquity = getBaseEquity();
  const totalPnlValue = resolveTotalPnlUsd(totalPnlUsd);
  const equityUsd = baseEquity && totalPnlValue !== null ? baseEquity + totalPnlValue : null;
  const equityText = equityUsd === null ? '—' : `$${equityUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const usdText = formatSignedUsd(totalPnlValue !== null ? totalPnlValue : 0);
  
  const totalTrades = winRateData.winCount + winRateData.lossCount;
  
  const message = [
    `📊 LINE NOTIFICATION: WIN RATE MILESTONE`,
    '',
    `EQUITY:       ${equityText}`,
    `              ${usdText}`,
    '',
    `WIN RATE:     ${winRateData.total.toFixed(1)}%`,
    `  LONG   ${String(winRateData.longCount).padStart(3, '0')}   ${String(Math.round(winRateData.long)).padStart(3, '0')}%`,
    `  SHORT  ${String(winRateData.shortCount).padStart(3, '0')}   ${String(Math.round(winRateData.short)).padStart(3, '0')}%`
  ];
  
  // METRICS セクション追加（Phase 1）
  if (metrics) {
    message.push('');
    message.push('METRICS:');
    message.push(`  PF:        ${metrics.pfDisplay} (${metrics.pfLabel})`);
    message.push(`  RR:        ${metrics.rrDisplay} (${metrics.rrLabel})`);
    message.push(`  AV.WIN:    ${metrics.avWinDisplay}`);
    message.push(`  AV.LOSS:   ${metrics.avLossDisplay}`);
    message.push(`  MAX DD:    ${metrics.maxDDDisplay}`);
  }
  
  message.push('');
  message.push(`TRADES:    ${totalTrades} ${metrics ? metrics.trustFlag : ''}`);
  message.push(`THRESHOLD: ${threshold}%`);
  
  return message.join('\n');
}

/**
 * 勝率マイルストーン通知を送信（Phase 1: metrics 追加）
 */
async function notifyLineWinRate(winRateData, totalPnlUsd, threshold, metrics) {
  const text = buildWinRateMessage(winRateData, totalPnlUsd, threshold, metrics);
  return sendLineText(text, { kind: 'winrate' });
}

/**
 * 通知状態の読み込み
 */
function loadNotifiedState() {
  try {
    if (!fs.existsSync(LINE_NOTIFY_STATE_PATH)) {
      return { ...DEFAULT_NOTIFY_STATE, lastNotifiedAt: { ...DEFAULT_NOTIFY_STATE.lastNotifiedAt }, alertCooldowns: {} };
    }
    const data = fs.readFileSync(LINE_NOTIFY_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      ...DEFAULT_NOTIFY_STATE,
      ...parsed,
      lastNotifiedAt: { ...DEFAULT_NOTIFY_STATE.lastNotifiedAt, ...(parsed?.lastNotifiedAt || {}) },
      alertCooldowns: { ...(parsed?.alertCooldowns || {}) }
    };
  } catch (err) {
    console.error('[LINE_NOTIFY] failed to load state:', err.message);
    return { ...DEFAULT_NOTIFY_STATE, lastNotifiedAt: { ...DEFAULT_NOTIFY_STATE.lastNotifiedAt }, alertCooldowns: {} };
  }
}

/**
 * 通知状態の保存
 */
function saveNotifiedState(state) {
  try {
    fs.writeFileSync(LINE_NOTIFY_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[LINE_NOTIFY] failed to save state:', err.message);
  }
}

/**
 * 通知判定（重複防止・下抜け判定）
 */
function shouldNotify(threshold, currentWinRate, state) {
  const now = Date.now();
  const lastNotified = state.lastNotifiedAt[threshold];
  
  // 1時間以内に通知済み → skip
  if (lastNotified && (now - lastNotified) < 3600000) {
    return false;
  }
  
  // 起動直後（lastRecordedWinRate = null）→ skip
  if (state.lastRecordedWinRate === null) {
    return false;
  }
  
  // 下抜け判定: 前回 >= threshold && 今回 < threshold
  if (state.lastRecordedWinRate >= threshold && currentWinRate < threshold) {
    return true;
  }
  
  return false;
}

/**
 * 通知状態の更新
 */
function updateNotificationState(state, threshold, currentWinRate) {
  ensureMonthlyState(state, Date.now());
  state.lastNotifiedAt[threshold] = Date.now();
  state.currentWinRate = currentWinRate;
  state.lastRecordedWinRate = currentWinRate;
  state.lastUpdateTimestamp = new Date().toISOString();
  saveNotifiedState(state);
}

function getCurrentMonthKey(nowTs = Date.now()) {
  const p = getJstDateParts(nowTs);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

function ensureMonthlyState(state, nowTs = Date.now()) {
  const monthKey = getCurrentMonthKey(nowTs);
  if (state.currentMonth !== monthKey) {
    state.currentMonth = monthKey;
    state.monthlyNotificationCount = 0;
    state.limitReachedNotified = false;
    state.lastDailyMorningSentAt = null;
    state.lastDailyEveningSentAt = null;
    state.lastWeeklySentAt = null;
    state.alertCooldowns = {};
  }
  return state;
}

function shouldSendLimitNotice(state) {
  return !state.limitReachedNotified && Number(state.monthlyNotificationCount) >= 95;
}

function canSendByMonthlyLimit(state) {
  if (Number(state.monthlyNotificationCount) >= 95) {
    return false;
  }
  if (Number(state.monthlyNotificationCount) >= 90) {
    console.warn('[LINE_NOTIFY] monthly count over 90, approaching limit');
  }
  return true;
}

async function sendLineText(text, options = {}) {
  const { kind = 'generic', force = false, alertKey = null, cooldownMs = 30 * 60 * 1000 } = options;
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    console.warn('[LINE_NOTIFY] missing LINE env config');
    return false;
  }

  // マスターフラグ（全通知停止）
  if (!LINE_NOTIFY_ENABLED && !force) {
    return false;
  }

  // 種別フラグ
  if (kind === 'trade' && !LINE_NOTIFY_TRADES_ENABLED) {
    return false;
  }
  if (kind === 'winrate' && !LINE_NOTIFY_WINRATE_ENABLED) {
    return false;
  }
  if (kind === 'generic' && !LINE_NOTIFY_GENERIC_ENABLED) {
    return false;
  }
  if (kind === 'alert' && !LINE_NOTIFY_ALERTS_ENABLED) {
    return false;
  }
  if ((kind === 'daily_report' || kind === 'weekly_report') && !LINE_NOTIFY_REPORTS_ENABLED) {
    return false;
  }
  // kind === 'limit_notice' は個別フラグなし（マスターのみ）

  const nowTs = Date.now();
  const state = ensureMonthlyState(loadNotifiedState(), nowTs);

  if (!force) {
    if (!canSendByMonthlyLimit(state)) {
      if (shouldSendLimitNotice(state)) {
        await sendLimitReachedNotice(state, nowTs);
      }
      return false;
    }
  }

  if (kind === 'alert' && alertKey) {
    const lastSent = Number(state.alertCooldowns?.[alertKey] || 0);
    if (lastSent && (nowTs - lastSent) < cooldownMs) {
      return false;
    }
  }

  const payload = {
    to: LINE_USER_ID,
    messages: [{ type: 'text', text }]
  };

  try {
    const res = await axios.post(LINE_PUSH_ENDPOINT, payload, {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    state.monthlyNotificationCount = (state.monthlyNotificationCount || 0) + 1;
    state.lastUpdateTimestamp = new Date().toISOString();
    if (kind === 'alert' && alertKey) {
      state.alertCooldowns = state.alertCooldowns || {};
      state.alertCooldowns[alertKey] = nowTs;
    }
    saveNotifiedState(state);
    console.log(`[LINE_NOTIFY] sent kind=${kind} status=${res.status}`);
    return true;
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.warn(`[LINE_NOTIFY] failed kind=${kind} err=${detail}`);
    return false;
  }
}

async function sendLimitReachedNotice(state, nowTs) {
  const monthKey = state.currentMonth || getCurrentMonthKey(nowTs);
  const text = [
    '⚠️ HL BOT 通知停止',
    'LINE上限に到達しました',
    '',
    `件数 : 95 / 100`,
    `期間 : ${monthKey}`,
    '',
    '※ 月替わりまで通知停止'
  ].join('\n');

  const sent = await sendLineText(text, { kind: 'limit_notice', force: true });
  if (sent) {
    state.limitReachedNotified = true;
    saveNotifiedState(state);
  }
}

/**
 * 勝率マイルストーンチェック（メイン関数・Phase 1 対応）
 * engine/update.js から呼び出される
 */
async function checkWinRateMilestones(totalPnlUsd) {
  try {
    if (!LINE_NOTIFY_ENABLED || !LINE_NOTIFY_WINRATE_ENABLED) {
      return;
    }

    const winRateData = calculateWinRate();
    const currentWinRate = winRateData.total;
    
    // trades がまだない場合はスキップ
    if (winRateData.winCount + winRateData.lossCount === 0) {
      return;
    }
    
    // trades.jsonl を読み込んで metrics 計算（Phase 1）
    const tradesPath = resolveTradesPath();
    let trades = [];
    if (fs.existsSync(tradesPath)) {
      const data = fs.readFileSync(tradesPath, 'utf-8');
      const lines = data.split('\n').filter(l => l.trim());
      
      trades = lines.map(line => {
        try {
          const record = JSON.parse(line);
          return {
            pnl: record.realizedPnlUsd ?? record.pnl ?? 0,
            side: record.side === 'buy' || record.side === 'long' ? 'LONG' : 'SHORT',
            timestamp: record.closedAt || Date.now()
          };
        } catch (err) {
          return null;
        }
      }).filter(t => t !== null && t.pnl !== 0); // pnl=0 除外
    }
    
    const baseEquity = getBaseEquity() || 2000; // fallback
    const metrics = calcDashboardMetrics(trades, baseEquity);
    
    const state = loadNotifiedState();
    const thresholds = [55, 52, 50];
    
    for (const threshold of thresholds) {
      if (shouldNotify(threshold, currentWinRate, state)) {
        const sent = await notifyLineWinRate(winRateData, totalPnlUsd, threshold, metrics);
        if (sent) {
          updateNotificationState(state, threshold, currentWinRate);
        }
      }
    }
    
    // 通知なしでも状態更新（次回判定用）
    state.currentWinRate = currentWinRate;
    state.lastRecordedWinRate = currentWinRate;
    state.lastUpdateTimestamp = new Date().toISOString();
    saveNotifiedState(state);
    
  } catch (err) {
    console.error('[WINRATE] milestone check error:', err.message);
  }
}

function parseTradesForReport() {
  const tradesPath = path.join(process.cwd(), 'logs', 'trades.jsonl');
  if (!fs.existsSync(tradesPath)) return [];
  const data = fs.readFileSync(tradesPath, 'utf-8');
  const lines = data.split('\n').filter(l => l.trim());
  const trades = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const ts = record.timestampExit ?? record.closedAt ?? record.timestamp ?? record.ts ?? null;
      if (!Number.isFinite(ts)) continue;
      const pnl = Number(record.realizedPnlUsd ?? record.pnl ?? 0);
      trades.push({
        ts,
        pnl,
        side: record.side || null
      });
    } catch (_) {
      continue;
    }
  }
  return trades.sort((a, b) => a.ts - b.ts);
}

function computeReportMetrics(trades, baseEquity) {
  const count = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = count > 0 ? (wins.length / count) * 100 : 0;
  const sumWins = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = sumLoss === 0 ? (sumWins > 0 ? Infinity : 0) : sumWins / sumLoss;
  const avgWin = wins.length > 0 ? sumWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(sumLoss / losses.length) : 0;
  const rr = avgLoss === 0 ? (avgWin > 0 ? Infinity : 0) : avgWin / avgLoss;
  const avgPnl = count > 0 ? totalPnl / count : 0;
  const best = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
  const worst = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;

  let equity = baseEquity;
  let peak = equity;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    count,
    winRate,
    pf,
    rr,
    totalPnl,
    avgPnl,
    maxDD,
    best,
    worst
  };
}

function buildDailyReportMessage(label, fromTs, toTs, metrics, equityStart, equityEnd, status = 'NORMAL') {
  const pfText = metrics.pf === Infinity ? '∞' : metrics.pf.toFixed(2);
  const rrText = metrics.rr === Infinity ? '∞' : metrics.rr.toFixed(2);
  return [
    `📊 HL BOT レポート［${label}］`,
    `期間: ${formatJstDateTime(fromTs)} → ${formatJstDateTime(toTs)} (JST)`,
    '',
    `TRADES : ${metrics.count}`,
    `WIN    : ${metrics.winRate.toFixed(1)}%`,
    `PF     : ${pfText}`,
    `RR     : ${rrText}`,
    '',
    `PNL    : ${formatSignedUsdPlain(metrics.totalPnl)}`,
    `AVG    : ${formatSignedUsdPlain(metrics.avgPnl)}`,
    `EQUITY : ${formatUsdPlain(equityStart)} → ${formatUsdPlain(equityEnd)}`,
    `MAX DD : ${formatNegativeUsdPlain(metrics.maxDD)}`,
    '',
    `STATUS : ${status}`
  ].join('\n');
}

function buildWeeklyReportMessage(fromTs, toTs, metrics, equityStart, equityEnd, status = 'NORMAL') {
  const pfText = metrics.pf === Infinity ? '∞' : metrics.pf.toFixed(2);
  const rrText = metrics.rr === Infinity ? '∞' : metrics.rr.toFixed(2);
  return [
    '📊 HL BOT 週次レポート',
    `期間: ${formatJstDate(fromTs)} → ${formatJstDate(toTs)}`,
    '',
    `TRADES : ${metrics.count}`,
    `WIN    : ${metrics.winRate.toFixed(1)}%`,
    `PF     : ${pfText}`,
    `RR     : ${rrText}`,
    '',
    `PNL    : ${formatSignedUsdPlain(metrics.totalPnl)}`,
    `AVG    : ${formatSignedUsdPlain(metrics.avgPnl)}`,
    `EQUITY : ${formatUsdPlain(equityStart)} → ${formatUsdPlain(equityEnd)}`,
    `MAX DD : ${formatNegativeUsdPlain(metrics.maxDD)}`,
    '',
    `BEST   : ${formatSignedUsdPlain(metrics.best)}`,
    `WORST  : ${formatSignedUsdPlain(metrics.worst)}`,
    '',
    `STATUS : ${status}`
  ].join('\n');
}

async function sendDailyReport(label, fromTs, toTs) {
  const state = ensureMonthlyState(loadNotifiedState(), Date.now());
  if (!canSendByMonthlyLimit(state)) {
    if (shouldSendLimitNotice(state)) {
      await sendLimitReachedNotice(state, Date.now());
    }
    return false;
  }

  const allTrades = parseTradesForReport();
  if (allTrades.length === 0) return false;
  const beforeTrades = allTrades.filter(t => t.ts < fromTs);
  const windowTrades = allTrades.filter(t => t.ts >= fromTs && t.ts < toTs);
  if (windowTrades.length === 0) return false;

  const baseEquity = getBaseEquity() || 2000;
  const equityStart = baseEquity + beforeTrades.reduce((s, t) => s + t.pnl, 0);
  const equityEnd = equityStart + windowTrades.reduce((s, t) => s + t.pnl, 0);
  const metrics = computeReportMetrics(windowTrades, equityStart);
  const text = buildDailyReportMessage(label, fromTs, toTs, metrics, equityStart, equityEnd, 'NORMAL');

  const sent = await sendLineText(text, { kind: 'daily_report' });
  if (sent) {
    if (label === '朝') {
      state.lastDailyMorningSentAt = toTs;
    } else {
      state.lastDailyEveningSentAt = toTs;
    }
    saveNotifiedState(state);
  }
  return sent;
}

async function sendWeeklyReport(fromTs, toTs) {
  const state = ensureMonthlyState(loadNotifiedState(), Date.now());
  if (!canSendByMonthlyLimit(state)) {
    if (shouldSendLimitNotice(state)) {
      await sendLimitReachedNotice(state, Date.now());
    }
    return false;
  }

  const allTrades = parseTradesForReport();
  if (allTrades.length === 0) return false;
  const beforeTrades = allTrades.filter(t => t.ts < fromTs);
  const windowTrades = allTrades.filter(t => t.ts >= fromTs && t.ts < toTs);
  if (windowTrades.length === 0) return false;

  const baseEquity = getBaseEquity() || 2000;
  const equityStart = baseEquity + beforeTrades.reduce((s, t) => s + t.pnl, 0);
  const equityEnd = equityStart + windowTrades.reduce((s, t) => s + t.pnl, 0);
  const metrics = computeReportMetrics(windowTrades, equityStart);
  const text = buildWeeklyReportMessage(fromTs, toTs, metrics, equityStart, equityEnd, 'NORMAL');

  const sent = await sendLineText(text, { kind: 'weekly_report' });
  if (sent) {
    state.lastWeeklySentAt = toTs;
    saveNotifiedState(state);
  }
  return sent;
}

/**
 * LINE異常アラート送信（確定フォーマット）
 * 仕様: docs/LINE_ALERT_MESSAGE_SPEC_20260204.md
 * 
 * @param {Object} options - アラートオプション
 * @param {string} options.type - アラートタイプ（大文字スネークケース）
 * @param {string} options.message - メッセージ本文（1-3行）
 * @param {string} options.action - 対応箇所（見るべき対象）
 * @returns {Promise<boolean>} 送信成功可否
 */
async function sendLineAlert({ type, message, action }) {
  const jstTime = formatJstDateTime(Date.now());
  const text = [
    '🚨 HLBOT ALERT',
    '',
    `TYPE    : ${type}`,
    `TIME    : ${jstTime} JST`,
    '',
    'MESSAGE :',
    message,
    '',
    'ACTION  :',
    action
  ].join('\n');
  
  return sendLineText(text, { 
    kind: 'alert', 
    alertKey: type,
    cooldownMs: 30 * 60 * 1000 
  });
}

let lastScheduleCheckAt = 0;

async function checkScheduledLineReports(nowTs = Date.now()) {
  if (!LINE_NOTIFY_ENABLED || !LINE_NOTIFY_REPORTS_ENABLED) {
    return;
  }
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    return;
  }
  if (nowTs - lastScheduleCheckAt < 60 * 1000) {
    return;
  }
  lastScheduleCheckAt = nowTs;

  const state = ensureMonthlyState(loadNotifiedState(), nowTs);
  const parts = getJstDateParts(nowTs);

  const morningTarget = toJstTimestamp(parts.year, parts.month, parts.day, 7, 0);
  if (nowTs >= morningTarget && (!state.lastDailyMorningSentAt || state.lastDailyMorningSentAt < morningTarget)) {
    const fromTs = morningTarget - 12 * 60 * 60 * 1000;
    const sent = await sendDailyReport('朝', fromTs, morningTarget);
    if (sent) {
      state.lastDailyMorningSentAt = morningTarget;
      saveNotifiedState(state);
    }
  }

  const eveningTarget = toJstTimestamp(parts.year, parts.month, parts.day, 19, 0);
  if (nowTs >= eveningTarget && (!state.lastDailyEveningSentAt || state.lastDailyEveningSentAt < eveningTarget)) {
    const fromTs = eveningTarget - 12 * 60 * 60 * 1000;
    const sent = await sendDailyReport('夕', fromTs, eveningTarget);
    if (sent) {
      state.lastDailyEveningSentAt = eveningTarget;
      saveNotifiedState(state);
    }
  }

  const weeklyTarget = toJstTimestamp(parts.year, parts.month, parts.day, 7, 5);
  if (parts.dayOfWeek === 1 && nowTs >= weeklyTarget && (!state.lastWeeklySentAt || state.lastWeeklySentAt < weeklyTarget)) {
    const fromTs = weeklyTarget - 7 * 24 * 60 * 60 * 1000;
    const sent = await sendWeeklyReport(fromTs, weeklyTarget);
    if (sent) {
      state.lastWeeklySentAt = weeklyTarget;
      saveNotifiedState(state);
    }
  }
}

export { 
  notifyLine, 
  checkWinRateMilestones,
  calculateWinRate,
  calculateWinRateCached,
  checkScheduledLineReports,
  sendLineAlert,      // 新インターフェース（推奨）
  sendDailyReport,
  sendWeeklyReport
};
