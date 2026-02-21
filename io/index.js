// io/index.ts
// I/O 層エントリ：IOPacket v2.x の組み立て
// 禁止事項遵守：判断ロジックなし／console/throwなし／他レイヤー改変なし
import path from 'path';
import fs from 'fs';
import { buildIOMetrics } from './calc.js';
import { createLrcTracker, updateLrcState } from './lrc.js';
import { DepthSRAnalyzer } from './depth_v2.js';
import { adaptDepthSRForB } from './depth_sr_adapter.js';
import { DepthSRAggregator } from './depthSR_aggregator.js';
import { createBar15mTracker } from './bar15m.js';
import { createBar1hTracker } from './bar1h.js';
import { createLrcTvTracker } from './lrc_tv.js';
import { fetchBar1hBackfill, nextBackfillDelayMs } from './bar1h_backfill.js';
import { fetchBar15mBackfill, nextBar15mBackfillDelayMs } from './bar15m_backfill.js';
import { getOrCreateTradeFlowTracker } from './tradeFlowTracker.js';
import { loadTradeConfig, getTradeConfig } from '../config/trade.js';
import { getInitialCapitalUsd } from '../config/capital.js';
import { getBaseEquityLiveUsd } from '../config/equity.js';
import { resolveStatePath } from '../config/statePath.js';
import bridgeEmitter from '../core/bridgeEmitter.js';
import { write as writeLog } from '../ws/utils/logger.js';
import { updateHealth, STAGES } from '../core/healthState.js';
import crypto from 'crypto';
// state.ts を想定した最小インターフェイス参照（実体は他ファイル）
// updateMarketState(prev, current): { prev, current }
// ここでは型の厳密化は行わず、I/O層としての連結みを担保する。
// eslintやtsの厳密型は後段で調整可能。
let updateMarketStateFn;
export function bindUpdateMarketState(fn) {
    // 外部(state.ts)から渡してもらう。I/O層からは決して直接編集しない。
    updateMarketStateFn = fn;
}
// Boot time tracking for warmup constraint detection
let bootTimeMs = null;
let bootTimeInitialized = false;
let startupDowntimeMs = null;
let startupProfileInitialized = false;

// decisionId generator
let decisionIdCounter = 0;
function generateDecisionId() {
    decisionIdCounter = (decisionIdCounter + 1) % 1000000;
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex').substring(0, 4);
    return `dec_${ts}_${rand}_${decisionIdCounter}`;
}

function resolveMarkersPath() {
    return path.resolve(process.cwd(), 'logs', 'markers.jsonl');
}

function appendMarkerSafe(row) {
    try {
        const markerPath = resolveMarkersPath();
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.appendFileSync(markerPath, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (_) {}
}

function readLastShutdownTimestamp() {
    try {
        const markerPath = resolveMarkersPath();
        if (!fs.existsSync(markerPath)) return null;
        const raw = fs.readFileSync(markerPath, 'utf8');
        if (!raw || raw.trim().length === 0) return null;
        const lines = raw.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line) continue;
            try {
                const rec = JSON.parse(line);
                if (rec?.type !== 'shutdown') continue;
                const ts = Number(rec?.ts);
                if (Number.isFinite(ts) && ts > 0) return ts;
                const stoppedAt = Date.parse(String(rec?.stopped_at ?? ''));
                if (Number.isFinite(stoppedAt) && stoppedAt > 0) return stoppedAt;
            } catch (_) {}
        }
    } catch (_) {}
    return null;
}

function initializeStartupProfile() {
    if (startupProfileInitialized) return;
    startupProfileInitialized = true;
    const lastShutdownTs = readLastShutdownTimestamp();
    if (Number.isFinite(lastShutdownTs) && lastShutdownTs > 0) {
        startupDowntimeMs = Math.max(0, Date.now() - lastShutdownTs);
    } else {
        startupDowntimeMs = null;
    }
}

function resolveRestartMode(tradeConfig) {
    const cfg = tradeConfig?.startup?.restartAssist ?? {};
    const hotRestartMaxGapMs = Math.max(0, Number(cfg.hotRestartMaxGapMs ?? 180000));
    const warmRestartMaxGapMs = Math.max(hotRestartMaxGapMs, Number(cfg.warmRestartMaxGapMs ?? 1800000));
    if (!Number.isFinite(startupDowntimeMs)) return 'cold';
    if (startupDowntimeMs <= hotRestartMaxGapMs) return 'hot';
    if (startupDowntimeMs <= warmRestartMaxGapMs) return 'warm';
    return 'cold';
}
// A/B strength のテーブル（仕様固定）
const A_TABLE = {
    defend: 0.8,
    normal: 1.5,
    attack: 2.0,
};
function deriveBFromA(a) {
    if (a === A_TABLE.defend)
        return 0.0; // B発動なし
    if (a === A_TABLE.normal)
        return 1.0;
    if (a === A_TABLE.attack)
        return 1.5;
    return 0.0; // 未設定時の安全値
}
// I/O内部で保持する最終パケット（公開はgetIOPacketのみ）
let lastIOPacket = null;
let bar15mTracker = null;
let bar1hTracker = null;
let lrcTvTracker = null;
let lrcATracker = null;
let lrcDTracker = null;
let bar1hAdaptiveRuntime = {
    initialized: false,
    currentLookbackBars: null,
    lastSwitchAtMs: 0,
    weakUntilMs: 0,
    lastReason: 'init'
};
let bar1hBackfillState = {
    enabled: (process.env.BAR1H_BACKFILL_ENABLED ?? '1') !== '0',
    inFlight: false,
    nextRetryAt: 0,
    attempts: 0,
    lastError: null,
    lastSuccessAt: 0,
    lastAddedBars: 0,
    completed: false,
    neededBars: 0,
    currentCount: 0
};
let bar15mBackfillState = {
    enabled: (process.env.BAR15M_BACKFILL_ENABLED ?? '1') !== '0',
    inFlight: false,
    nextRetryAt: 0,
    attempts: 0,
    lastError: null,
    lastSuccessAt: 0,
    lastAddedBars: 0,
    completed: false,
    neededBars: 0,
    currentCount: 0
};
let prevMarketSnapshot = {
    bestBidPx: null,
    bestAskPx: null,
    midPx: null,
    oi: null,
    funding: null,
    premium: null,
    oraclePx: null,
    markPx: null,
    impactBidPx: null,
    impactAskPx: null,
    prevDayPx: null,
    dayNtlVlm: null,
    dayBaseVlm: null,
    lastTradeSide: null,
    lastTradePx: null,
    tradeFlow: null,
    bids: null,
    asks: null,
};
let tradeConfigLoaded = false;
let depthSRAnalyzer = null;  // 遅延初期化 + ホットリロード対応
let depthSRAggregator = null;  // 遅延初期化（config 読み込み後）

function getOrCreateDepthSRAnalyzer() {
  // ← #13修正: インスタンスを保持して毎回新規生成しない
  if (!depthSRAnalyzer) {
    depthSRAnalyzer = new DepthSRAnalyzer();
  }
  return depthSRAnalyzer;
}

function toNumber(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
function normalizeLevels(levels) {
    if (!Array.isArray(levels)) return [];
    return levels
        .map(l => {
        const price = toNumber(l?.px ?? l?.price);
        const size = toNumber(l?.sz ?? l?.size);
        return price != null && size != null && size > 0 ? { price, size } : null;
    })
        .filter(v => v !== null);
}
function computeDepthSR(current, scaleHint = null) {
    const midPx = Number(current?.midPx ?? NaN);
    const snapshot = {
        timestamp: Date.now(),
        bids: normalizeLevels(current?.bids ?? []),
        asks: normalizeLevels(current?.asks ?? []),
    };
    
    // 現行 DepthSR を計算（フォールバック用）
    // ホットリロード対応: getOrCreateDepthSRAnalyzer() で最新インスタンスを取得
    const analyzer = getOrCreateDepthSRAnalyzer();
    const depthSRv2 = analyzer.onDepthSnapshot(snapshot, midPx, scaleHint ?? undefined);
    
    // Aggregator が有効な場合
    if (depthSRAggregator?.config?.enabled) {
        const ts = snapshot.timestamp;
        const bids = snapshot.bids;
        const asks = snapshot.asks;
        
        // バッファに追加
        depthSRAggregator.addDepthSnapshot(ts, bids, asks);
        
        // 集計実行（タイミング制御あり）
        depthSRAggregator.runAggregation(ts, midPx);
        
        // 集計版を取得（独立した呼び出し）
        const aggregatedSR = depthSRAggregator.getAggregatedDepthSR();
        
        // ready 判定：aggregator が成功したら使用、失敗したら depthSRv2 を fallback
        return aggregatedSR.ready ? aggregatedSR : depthSRv2;
    }
    
    // Aggregator 無効の場合は現行版をそのまま返す
    return depthSRv2;
}

function toFiniteNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function resolveTopDownBars(tradeConfig) {
    const cfg = tradeConfig?.topDownModel ?? {};
    const enabled = cfg?.enabled === true;
    const profileKey = String(cfg?.activeProfile ?? '').trim();
    const profile = profileKey ? (cfg?.profiles?.[profileKey] ?? null) : null;
    const aBarsRaw = profile?.aBars ?? cfg?.aBars;
    const bBarsRaw = profile?.bBars ?? cfg?.bBars;
    const aBars = Math.max(2, Math.floor(toFiniteNumber(aBarsRaw, NaN) ?? NaN));
    const bBars = Math.max(2, Math.floor(toFiniteNumber(bBarsRaw, NaN) ?? NaN));
    return {
        enabled,
        profileKey: profileKey || null,
        aBars: Number.isFinite(aBars) ? aBars : null,
        bBars: Number.isFinite(bBars) ? bBars : null,
    };
}

function scheduleBar1hBackfillIfNeeded(current, tradeConfig, neededBars) {
    if (!bar1hBackfillState.enabled || !bar1hTracker) return;

    const requiredBars = Math.max(2, Number(neededBars ?? 0) || 0);
    const currentCount = bar1hTracker.getCloseArray(requiredBars).length;
    bar1hBackfillState.neededBars = requiredBars;
    bar1hBackfillState.currentCount = currentCount;
    if (currentCount >= requiredBars) {
        if (!bar1hBackfillState.completed) {
            bar1hBackfillState.completed = true;
            appendMarkerSafe({
                ts: Date.now(),
                type: 'bar1h_backfill_ready',
                neededBars: requiredBars,
                currentCount,
                attempts: bar1hBackfillState.attempts
            });
        }
        return;
    }

    const now = Date.now();
    if (bar1hBackfillState.inFlight) return;
    if (now < bar1hBackfillState.nextRetryAt) return;

    bar1hBackfillState.inFlight = true;
    const attempt = bar1hBackfillState.attempts + 1;
    const coin = current?.coin ?? current?.symbol ?? tradeConfig?.symbols?.[0] ?? 'BTC';

    fetchBar1hBackfill({
        coin,
        neededBars: requiredBars
    })
        .then((result) => {
            const success = result?.ok === true;
            if (success) {
                const merged = bar1hTracker.mergeBackfillCandles(result.candles, Date.now());
                const newCount = bar1hTracker.getCloseArray(requiredBars).length;
                const stillInsufficient = newCount < requiredBars;
                bar1hBackfillState.attempts = attempt;
                bar1hBackfillState.lastError = null;
                bar1hBackfillState.lastSuccessAt = Date.now();
                bar1hBackfillState.lastAddedBars = merged.addedBars;
                bar1hBackfillState.completed = !stillInsufficient;
                bar1hBackfillState.currentCount = newCount;
                bar1hBackfillState.nextRetryAt = Date.now() + nextBackfillDelayMs({
                    attempt,
                    retryAfterMs: result?.retryAfterMs,
                    success: true,
                    stillInsufficient
                });

                appendMarkerSafe({
                    ts: Date.now(),
                    type: 'bar1h_backfill_success',
                    attempt,
                    coin,
                    neededBars: requiredBars,
                    currentCount: newCount,
                    addedBars: merged.addedBars,
                    adoptedCurrent: merged.adoptedCurrent,
                    stillInsufficient
                });
            } else {
                bar1hBackfillState.attempts = attempt;
                bar1hBackfillState.lastError = result?.error ?? 'unknown';
                bar1hBackfillState.nextRetryAt = Date.now() + nextBackfillDelayMs({
                    attempt,
                    retryAfterMs: result?.retryAfterMs,
                    success: false
                });
                appendMarkerSafe({
                    ts: Date.now(),
                    type: 'bar1h_backfill_failed',
                    attempt,
                    coin,
                    neededBars: requiredBars,
                    currentCount,
                    error: bar1hBackfillState.lastError,
                    retryAt: bar1hBackfillState.nextRetryAt
                });
            }
        })
        .catch((err) => {
            bar1hBackfillState.attempts = attempt;
            bar1hBackfillState.lastError = err?.message ?? 'unknown';
            bar1hBackfillState.nextRetryAt = Date.now() + nextBackfillDelayMs({ attempt, success: false });
            appendMarkerSafe({
                ts: Date.now(),
                type: 'bar1h_backfill_exception',
                attempt,
                neededBars: requiredBars,
                currentCount,
                error: bar1hBackfillState.lastError,
                retryAt: bar1hBackfillState.nextRetryAt
            });
        })
        .finally(() => {
            bar1hBackfillState.inFlight = false;
        });
}

function scheduleBar15mBackfillIfNeeded(current, tradeConfig, neededBars) {
    if (!bar15mBackfillState.enabled || !bar15mTracker) return;

    const requiredBars = Math.max(2, Number(neededBars ?? 0) || 0);
    const currentCount = bar15mTracker.getCloseArray(requiredBars).length;
    bar15mBackfillState.neededBars = requiredBars;
    bar15mBackfillState.currentCount = currentCount;
    if (currentCount >= requiredBars) {
        if (!bar15mBackfillState.completed) {
            bar15mBackfillState.completed = true;
            appendMarkerSafe({
                ts: Date.now(),
                type: 'bar15m_backfill_ready',
                neededBars: requiredBars,
                currentCount,
                attempts: bar15mBackfillState.attempts
            });
        }
        return;
    }

    const now = Date.now();
    if (bar15mBackfillState.inFlight) return;
    if (now < bar15mBackfillState.nextRetryAt) return;

    bar15mBackfillState.inFlight = true;
    const attempt = bar15mBackfillState.attempts + 1;
    const coin = current?.coin ?? current?.symbol ?? tradeConfig?.symbols?.[0] ?? 'BTC';

    fetchBar15mBackfill({
        coin,
        neededBars: requiredBars
    })
        .then((result) => {
            const success = result?.ok === true;
            if (success) {
                const merged = bar15mTracker.mergeBackfillCandles(result.candles, Date.now());
                const newCount = bar15mTracker.getCloseArray(requiredBars).length;
                const stillInsufficient = newCount < requiredBars;
                bar15mBackfillState.attempts = attempt;
                bar15mBackfillState.lastError = null;
                bar15mBackfillState.lastSuccessAt = Date.now();
                bar15mBackfillState.lastAddedBars = merged.addedBars;
                bar15mBackfillState.completed = !stillInsufficient;
                bar15mBackfillState.currentCount = newCount;
                bar15mBackfillState.nextRetryAt = Date.now() + nextBar15mBackfillDelayMs({
                    attempt,
                    retryAfterMs: result?.retryAfterMs,
                    success: true,
                    stillInsufficient
                });

                appendMarkerSafe({
                    ts: Date.now(),
                    type: 'bar15m_backfill_success',
                    attempt,
                    coin,
                    neededBars: requiredBars,
                    currentCount: newCount,
                    addedBars: merged.addedBars,
                    adoptedCurrent: merged.adoptedCurrent,
                    stillInsufficient
                });
            } else {
                bar15mBackfillState.attempts = attempt;
                bar15mBackfillState.lastError = result?.error ?? 'unknown';
                bar15mBackfillState.nextRetryAt = Date.now() + nextBar15mBackfillDelayMs({
                    attempt,
                    retryAfterMs: result?.retryAfterMs,
                    success: false
                });
                appendMarkerSafe({
                    ts: Date.now(),
                    type: 'bar15m_backfill_failed',
                    attempt,
                    coin,
                    neededBars: requiredBars,
                    currentCount,
                    error: bar15mBackfillState.lastError,
                    retryAt: bar15mBackfillState.nextRetryAt
                });
            }
        })
        .catch((err) => {
            bar15mBackfillState.attempts = attempt;
            bar15mBackfillState.lastError = err?.message ?? 'unknown';
            bar15mBackfillState.nextRetryAt = Date.now() + nextBar15mBackfillDelayMs({ attempt, success: false });
            appendMarkerSafe({
                ts: Date.now(),
                type: 'bar15m_backfill_exception',
                attempt,
                neededBars: requiredBars,
                currentCount,
                error: bar15mBackfillState.lastError,
                retryAt: bar15mBackfillState.nextRetryAt
            });
        })
        .finally(() => {
            bar15mBackfillState.inFlight = false;
        });
}

function extractTradesFromPacket(packet) {
    if (Array.isArray(packet)) {
        return packet.filter(t => t && typeof t === 'object');
    }
    if (packet?.channel === 'trades' && packet && typeof packet === 'object') {
        return [packet];
    }
    return [];
}

function evaluateBar1hAdaptive(bar1hState, tradeConfig, nowMs) {
    const baseCfg = tradeConfig?.bar1h ?? {};
    const adaptiveCfg = baseCfg?.adaptive ?? {};
    const enabled = adaptiveCfg?.enabled === true;
    const startLookbackBars = Math.max(1, Math.floor(toFiniteNumber(adaptiveCfg?.startLookbackBars, 3) ?? 3));
    const expandedLookbackBars = Math.max(startLookbackBars, Math.floor(toFiniteNumber(adaptiveCfg?.expandedLookbackBars, 6) ?? 6));
    const expandStepBars = Math.max(1, Math.floor(toFiniteNumber(adaptiveCfg?.expandStepBars, 1) ?? 1));
    const lowSpanUsd = Math.max(1, toFiniteNumber(adaptiveCfg?.lowSpanUsd, 900) ?? 900);
    const highSpanUsd = Math.max(lowSpanUsd + 1, toFiniteNumber(adaptiveCfg?.highSpanUsd, 1200) ?? 1200);
    const minFinalSpanUsd = Math.max(1, toFiniteNumber(adaptiveCfg?.minFinalSpanUsd, lowSpanUsd) ?? lowSpanUsd);
    const switchCooldownMs = Math.max(0, Math.floor(toFiniteNumber(adaptiveCfg?.switchCooldownMs, 1800000) ?? 1800000));
    const weakOrderMsAfterSwitch = Math.max(0, Math.floor(toFiniteNumber(adaptiveCfg?.weakOrderMsAfterSwitch, 1800000) ?? 1800000));

    const currentSpanUsd = Number.isFinite(bar1hState?.high) && Number.isFinite(bar1hState?.low)
        ? Math.max(0, bar1hState.high - bar1hState.low)
        : null;

    const routeDesiredLookback = Math.max(1, Math.floor(toFiniteNumber(baseCfg?.lookbackBars, startLookbackBars) ?? startLookbackBars));

    if (!enabled) {
        const nextLookback = routeDesiredLookback;
        const shouldApply = !bar1hAdaptiveRuntime.initialized || bar1hAdaptiveRuntime.currentLookbackBars !== nextLookback;
        if (shouldApply && bar1hTracker) {
            bar1hTracker.updateConfig({ ...baseCfg, lookbackBars: nextLookback });
        }
        bar1hAdaptiveRuntime = {
            initialized: true,
            currentLookbackBars: nextLookback,
            lastSwitchAtMs: nowMs,
            weakUntilMs: 0,
            lastReason: 'disabled'
        };
        return {
            enabled: false,
            switchingActive: false,
            currentLookbackBars: nextLookback,
            currentSpanUsd,
            floorMet: Number.isFinite(currentSpanUsd) ? currentSpanUsd >= minFinalSpanUsd : false,
            lowSpanUsd,
            highSpanUsd,
            minFinalSpanUsd,
            weakUntilMs: 0,
            lastSwitchAtMs: bar1hAdaptiveRuntime.lastSwitchAtMs,
            lastReason: 'disabled'
        };
    }

    if (!bar1hAdaptiveRuntime.initialized) {
        if (bar1hTracker) {
            bar1hTracker.updateConfig({ ...baseCfg, lookbackBars: startLookbackBars });
        }
        bar1hAdaptiveRuntime.initialized = true;
        bar1hAdaptiveRuntime.currentLookbackBars = startLookbackBars;
        bar1hAdaptiveRuntime.lastSwitchAtMs = nowMs;
        bar1hAdaptiveRuntime.weakUntilMs = 0;
        bar1hAdaptiveRuntime.lastReason = 'startup';
    }

    const currentLookback = Math.max(1, Math.floor(toFiniteNumber(bar1hAdaptiveRuntime.currentLookbackBars, startLookbackBars) ?? startLookbackBars));
    const cooldownActive = (nowMs - bar1hAdaptiveRuntime.lastSwitchAtMs) < switchCooldownMs;
    let nextLookback = currentLookback;
    let reason = bar1hAdaptiveRuntime.lastReason || 'hold';

    if (!cooldownActive && Number.isFinite(currentSpanUsd)) {
        if (currentSpanUsd < minFinalSpanUsd && currentLookback < expandedLookbackBars) {
            nextLookback = Math.min(expandedLookbackBars, currentLookback + expandStepBars);
            reason = 'expand_span_floor';
        } else if (currentLookback === startLookbackBars && currentSpanUsd < lowSpanUsd) {
            nextLookback = Math.min(expandedLookbackBars, currentLookback + expandStepBars);
            reason = 'expand_span_low';
        } else if (currentLookback === expandedLookbackBars && currentSpanUsd > highSpanUsd) {
            nextLookback = Math.max(startLookbackBars, currentLookback - expandStepBars);
            reason = 'shrink_span_high';
        } else if (currentLookback > startLookbackBars && currentSpanUsd > highSpanUsd) {
            nextLookback = Math.max(startLookbackBars, currentLookback - expandStepBars);
            reason = 'shrink_span_high';
        } else {
            reason = 'hold';
        }
    } else if (cooldownActive) {
        reason = 'cooldown';
    }

    if (nextLookback !== currentLookback) {
        if (bar1hTracker) {
            bar1hTracker.updateConfig({ ...baseCfg, lookbackBars: nextLookback });
        }
        bar1hAdaptiveRuntime.currentLookbackBars = nextLookback;
        bar1hAdaptiveRuntime.lastSwitchAtMs = nowMs;
        bar1hAdaptiveRuntime.weakUntilMs = nowMs + weakOrderMsAfterSwitch;
        bar1hAdaptiveRuntime.lastReason = reason;
        appendMarkerSafe({
            ts: nowMs,
            type: 'bar1h_adaptive_switch',
            fromLookbackBars: currentLookback,
            toLookbackBars: nextLookback,
            spanUsd: Number.isFinite(currentSpanUsd) ? currentSpanUsd : null,
            lowSpanUsd,
            highSpanUsd,
            minFinalSpanUsd,
            expandStepBars,
            weakOrderMsAfterSwitch,
            switchCooldownMs,
            reason
        });
    } else {
        bar1hAdaptiveRuntime.lastReason = reason;
    }

    const switchingActive = nowMs <= bar1hAdaptiveRuntime.weakUntilMs;
    const floorMet = Number.isFinite(currentSpanUsd) ? currentSpanUsd >= minFinalSpanUsd : false;
    return {
        enabled: true,
        switchingActive,
        currentLookbackBars: bar1hAdaptiveRuntime.currentLookbackBars,
        currentSpanUsd,
        floorMet,
        lowSpanUsd,
        highSpanUsd,
        minFinalSpanUsd,
        weakUntilMs: bar1hAdaptiveRuntime.weakUntilMs,
        lastSwitchAtMs: bar1hAdaptiveRuntime.lastSwitchAtMs,
        lastReason: bar1hAdaptiveRuntime.lastReason
    };
}
// イベント受け取り（Normalizeからのraw相当をcurrentへ反映する役割のみ）
export function handleEvent(packet, opts) {
    try {
        updateHealth(STAGES.IO);
    }
    catch (err) {
        console.error('[IO] updateHealth failed', err);
    }
    if (!tradeConfigLoaded) {
        loadTradeConfig();
        tradeConfigLoaded = true;
    }
    
    // Aggregator 初期化（1回のみ）
    if (!depthSRAggregator) {
        const tradeConfig = getTradeConfig();
        const srAggConfig = tradeConfig?.srAggregate ?? { enabled: false };
        depthSRAggregator = new DepthSRAggregator(srAggConfig);
    } else {
        // 設定変更時の hot reload
        const tradeConfig = getTradeConfig();
        const srAggConfig = tradeConfig?.srAggregate ?? { enabled: false };
        depthSRAggregator.updateConfig(srAggConfig);
    }
    const tradeFlowTracker = getOrCreateTradeFlowTracker(getTradeConfig()?.tradeFlow ?? {});
    const trades = extractTradesFromPacket(packet);
    let packetLastTradeSide = null;
    let packetLastTradePx = null;
    if (trades.length > 0) {
        for (const trade of trades) {
            tradeFlowTracker.addTrade(trade);
            if (trade?.side) packetLastTradeSide = trade.side;
            if (Number.isFinite(Number(trade?.px))) packetLastTradePx = Number(trade.px);
        }
    }
    const oiFromPacket = toFiniteNumber(
      Array.isArray(packet) ? null : packet?.oi,
      null
    );
    if (Number.isFinite(oiFromPacket)) {
      const oiTs = toFiniteNumber(
        Array.isArray(packet) ? null : packet?.ts,
        Date.now()
      );
      tradeFlowTracker.updateOi(oiFromPacket, oiTs);
    }
    const tradeFlowState = tradeFlowTracker.getState();

    // MarketStateの更新（prev/currentを流す）。index.tsは生成と連結のみ。
    const curRaw = Array.isArray(packet) ? {} : (packet ?? {});
    const current = {
        ...curRaw,
        bestBidPx: curRaw.bestBidPx ?? prevMarketSnapshot.bestBidPx,
        bestAskPx: curRaw.bestAskPx ?? prevMarketSnapshot.bestAskPx,
        midPx: curRaw.midPx ?? prevMarketSnapshot.midPx,
        oi: curRaw.oi ?? prevMarketSnapshot.oi,
        funding: curRaw.funding ?? prevMarketSnapshot.funding,
        premium: curRaw.premium ?? prevMarketSnapshot.premium,
        oraclePx: curRaw.oraclePx ?? prevMarketSnapshot.oraclePx,
        markPx: curRaw.markPx ?? prevMarketSnapshot.markPx,
        impactBidPx: curRaw.impactBidPx ?? prevMarketSnapshot.impactBidPx,
        impactAskPx: curRaw.impactAskPx ?? prevMarketSnapshot.impactAskPx,
        prevDayPx: curRaw.prevDayPx ?? prevMarketSnapshot.prevDayPx,
        dayNtlVlm: curRaw.dayNtlVlm ?? prevMarketSnapshot.dayNtlVlm,
        dayBaseVlm: curRaw.dayBaseVlm ?? prevMarketSnapshot.dayBaseVlm,
        lastTradeSide: packetLastTradeSide ?? curRaw.side ?? curRaw.lastTradeSide ?? prevMarketSnapshot.lastTradeSide,
        lastTradePx: packetLastTradePx ?? curRaw.px ?? curRaw.lastTradePx ?? prevMarketSnapshot.lastTradePx,
        tradeFlow: tradeFlowState ?? prevMarketSnapshot.tradeFlow,
        bids: curRaw.bids ?? prevMarketSnapshot.bids,
        asks: curRaw.asks ?? prevMarketSnapshot.asks,
    };
    const prev = {
        bestBidPx: prevMarketSnapshot.bestBidPx,
        bestAskPx: prevMarketSnapshot.bestAskPx,
        midPx: prevMarketSnapshot.midPx,
        oi: prevMarketSnapshot.oi,
        funding: prevMarketSnapshot.funding,
        premium: prevMarketSnapshot.premium,
        oraclePx: prevMarketSnapshot.oraclePx,
        markPx: prevMarketSnapshot.markPx,
        impactBidPx: prevMarketSnapshot.impactBidPx,
        impactAskPx: prevMarketSnapshot.impactAskPx,
        prevDayPx: prevMarketSnapshot.prevDayPx,
        dayNtlVlm: prevMarketSnapshot.dayNtlVlm,
        dayBaseVlm: prevMarketSnapshot.dayBaseVlm,
        lastTradeSide: prevMarketSnapshot.lastTradeSide,
        lastTradePx: prevMarketSnapshot.lastTradePx,
        tradeFlow: prevMarketSnapshot.tradeFlow,
        bids: prevMarketSnapshot.bids,
        asks: prevMarketSnapshot.asks,
    };
    if (!updateMarketStateFn) {
        // 状態関数未バインドの場合は最小構造で流す（判断はしない）
        const marketState = { prev, current };
        const ioMetrics = buildIOMetrics(marketState);
        const A = typeof opts?.A === 'number' ? opts.A : (opts?.A ? A_TABLE[opts.A] : A_TABLE.normal);
        const B = deriveBFromA(A);
        const tradeConfig = getTradeConfig();
        
        // Update IO state (bar trackers, LRC, depth SR) - common logic
        const ioState = updateIOState(current, tradeConfig, tradeFlowState);
        
        lastIOPacket = assembleIOPacket(marketState, ioMetrics, { A, B }, ioState);
        prevMarketSnapshot.bestBidPx = current?.bestBidPx ?? prevMarketSnapshot.bestBidPx;
        prevMarketSnapshot.bestAskPx = current?.bestAskPx ?? prevMarketSnapshot.bestAskPx;
        prevMarketSnapshot.midPx = current?.midPx ?? prevMarketSnapshot.midPx;
        prevMarketSnapshot.oi = current?.oi ?? prevMarketSnapshot.oi;
        prevMarketSnapshot.funding = current?.funding ?? prevMarketSnapshot.funding;
        prevMarketSnapshot.premium = current?.premium ?? prevMarketSnapshot.premium;
        prevMarketSnapshot.oraclePx = current?.oraclePx ?? prevMarketSnapshot.oraclePx;
        prevMarketSnapshot.markPx = current?.markPx ?? prevMarketSnapshot.markPx;
        prevMarketSnapshot.impactBidPx = current?.impactBidPx ?? prevMarketSnapshot.impactBidPx;
        prevMarketSnapshot.impactAskPx = current?.impactAskPx ?? prevMarketSnapshot.impactAskPx;
        prevMarketSnapshot.prevDayPx = current?.prevDayPx ?? prevMarketSnapshot.prevDayPx;
        prevMarketSnapshot.dayNtlVlm = current?.dayNtlVlm ?? prevMarketSnapshot.dayNtlVlm;
        prevMarketSnapshot.dayBaseVlm = current?.dayBaseVlm ?? prevMarketSnapshot.dayBaseVlm;
        prevMarketSnapshot.lastTradeSide = current?.lastTradeSide ?? prevMarketSnapshot.lastTradeSide;
        prevMarketSnapshot.lastTradePx = current?.lastTradePx ?? prevMarketSnapshot.lastTradePx;
        prevMarketSnapshot.tradeFlow = current?.tradeFlow ?? prevMarketSnapshot.tradeFlow;
        prevMarketSnapshot.bids = current?.bids ?? prevMarketSnapshot.bids;
        prevMarketSnapshot.asks = current?.asks ?? prevMarketSnapshot.asks;
        emitIODebug(lastIOPacket);
        if (process.env.TEST_MODE === '1' && !globalThis.__runtimeActive) {
            testEngineHook(lastIOPacket).catch((err) => {
                console.error('[TEST_ENGINE_HOOK] unhandled error', err);
            });
        }
        return;
    }
    const ms = updateMarketStateFn(prev, current);
    
    // 市場データ新鮮度判定用の時刻を記録（問題2修正）
    if (typeof global.engineState === 'object' && global.engineState) {
      global.engineState.lastMarketAtMs = Date.now();
    }
    
    const ioMetrics = buildIOMetrics(ms);
    const A = typeof opts?.A === 'number' ? opts.A : (opts?.A ? A_TABLE[opts.A] : A_TABLE.normal);
    const B = deriveBFromA(A);
    const tradeConfig = getTradeConfig();
    
    // Update IO state (bar trackers, LRC, depth SR) - common logic
    const ioState = updateIOState(current, tradeConfig, tradeFlowState);
    
    lastIOPacket = assembleIOPacket(ms, ioMetrics, { A, B }, ioState);
    prevMarketSnapshot.bestBidPx = current?.bestBidPx ?? prevMarketSnapshot.bestBidPx;
    prevMarketSnapshot.bestAskPx = current?.bestAskPx ?? prevMarketSnapshot.bestAskPx;
    prevMarketSnapshot.midPx = current?.midPx ?? prevMarketSnapshot.midPx;
    prevMarketSnapshot.oi = current?.oi ?? prevMarketSnapshot.oi;
    prevMarketSnapshot.funding = current?.funding ?? prevMarketSnapshot.funding;
    prevMarketSnapshot.premium = current?.premium ?? prevMarketSnapshot.premium;
    prevMarketSnapshot.oraclePx = current?.oraclePx ?? prevMarketSnapshot.oraclePx;
    prevMarketSnapshot.markPx = current?.markPx ?? prevMarketSnapshot.markPx;
    prevMarketSnapshot.impactBidPx = current?.impactBidPx ?? prevMarketSnapshot.impactBidPx;
    prevMarketSnapshot.impactAskPx = current?.impactAskPx ?? prevMarketSnapshot.impactAskPx;
    prevMarketSnapshot.prevDayPx = current?.prevDayPx ?? prevMarketSnapshot.prevDayPx;
    prevMarketSnapshot.dayNtlVlm = current?.dayNtlVlm ?? prevMarketSnapshot.dayNtlVlm;
    prevMarketSnapshot.dayBaseVlm = current?.dayBaseVlm ?? prevMarketSnapshot.dayBaseVlm;
    prevMarketSnapshot.lastTradeSide = current?.lastTradeSide ?? prevMarketSnapshot.lastTradeSide;
    prevMarketSnapshot.lastTradePx = current?.lastTradePx ?? prevMarketSnapshot.lastTradePx;
    prevMarketSnapshot.tradeFlow = current?.tradeFlow ?? prevMarketSnapshot.tradeFlow;
    prevMarketSnapshot.bids = current?.bids ?? prevMarketSnapshot.bids;
    prevMarketSnapshot.asks = current?.asks ?? prevMarketSnapshot.asks;
    emitIODebug(lastIOPacket);
    // ────────────────────────────────────────
    // TEST Engine Integration Point (env opt-in)
    // ────────────────────────────────────────
    if (process.env.TEST_MODE === '1' && !globalThis.__runtimeActive) {
        testEngineHook(lastIOPacket).catch((err) => {
            console.error('[TEST_ENGINE_HOOK] unhandled error', err);
        });
    }
}
/**
 * Update IO state: common logic for bar trackers, LRC, and depth SR
 * Extracted from duplicated code in handleTickInput
 */
function updateIOState(current, tradeConfig, tradeFlowState = null) {
    const topDownBars = resolveTopDownBars(tradeConfig);
    const effectiveB15mLen = topDownBars.enabled && Number.isFinite(topDownBars.bBars)
        ? topDownBars.bBars
        : Number(tradeConfig?.lrc?.len ?? 100);
    const lrcAConfig = tradeConfig?.lrcA ?? tradeConfig?.lrc ?? {};
    const effectiveA1hLen = topDownBars.enabled && Number.isFinite(topDownBars.aBars)
        ? topDownBars.aBars
        : Number(lrcAConfig?.len ?? tradeConfig?.lrc?.len ?? 100);

    // Bar15m トラッカー初期化
    if (!bar15mTracker) {
        bar15mTracker = createBar15mTracker();
    }
    
    // LRC_TV トラッカー初期化
    if (!lrcTvTracker) {
        lrcTvTracker = createLrcTvTracker({
            len: effectiveB15mLen,
            devlen: tradeConfig.lrc.devlen,
            k: tradeConfig.lrc.k,
        });
    } else {
        lrcTvTracker.config = {
            len: effectiveB15mLen,
            devlen: tradeConfig.lrc.devlen,
            k: tradeConfig.lrc.k,
        };
    }
    // A専用の広域LRCトラッカー（1h closeベース）
    if (!lrcATracker) {
        lrcATracker = createLrcTvTracker({
            len: effectiveA1hLen,
            devlen: lrcAConfig.devlen ?? tradeConfig.lrc.devlen,
            k: lrcAConfig.k ?? tradeConfig.lrc.k,
        });
    } else {
        lrcATracker.config = {
            len: effectiveA1hLen,
            devlen: lrcAConfig.devlen ?? tradeConfig.lrc.devlen,
            k: lrcAConfig.k ?? tradeConfig.lrc.k,
        };
    }
    // A専用の日足レベルLRCトラッカー（bar1h closeを高次窓で観測）
    if (!lrcDTracker) {
        const lrcDConfig = tradeConfig?.lrcD ?? {};
        const lrcABase = tradeConfig?.lrcA ?? tradeConfig?.lrc ?? {};
        lrcDTracker = createLrcTvTracker({
            len: lrcDConfig.len ?? 24,
            devlen: lrcDConfig.devlen ?? lrcABase.devlen ?? tradeConfig.lrc.devlen,
            k: lrcDConfig.k ?? lrcABase.k ?? tradeConfig.lrc.k,
        });
    }
    
    // Bar1h トラッカー初期化（Phase A）
    if (!bar1hTracker) {
        bar1hTracker = createBar1hTracker(tradeConfig?.bar1h);
        if (process.env.TEST_MODE === '1') {
            console.warn('[IO] TEST_MODE=1: A-GATE will pass with 1 bar (bar1h will continue reading up to 3 bars for accuracy)');
        }
    }
    
    const lrcInput = {
        midPx: current?.midPx ?? null,
        lastTradePx: current?.lastTradePx ?? null,
    };
    
    // Bar15m更新
    bar15mTracker.update(Date.now(), lrcInput.midPx, 'midPx');
    scheduleBar15mBackfillIfNeeded(current, tradeConfig, Math.max(2, effectiveB15mLen + 1));
    const closeArray = bar15mTracker.getCloseArray(Math.max(2, effectiveB15mLen + 1));
    
    // Bar1h更新（Phase A）
    // Use market data timestamp (current.ts) for DATA_STALE detection
    const marketTimestamp = current?.ts ?? Date.now();
    bar1hTracker.update(Date.now(), lrcInput.midPx, 'midPx');
    scheduleBar1hBackfillIfNeeded(current, tradeConfig, Math.max(2, effectiveA1hLen + 1));
    const bar1hState = bar1hTracker?.getState?.() ?? null;
    const bar1hAdaptiveState = evaluateBar1hAdaptive(bar1hState, tradeConfig, Date.now());
    
    // LRC_TV更新（closeArrayを入力）
    const lrcTvState = lrcTvTracker.updateFromCloseArray(closeArray);
    // LRC_A更新（bar1h close配列を入力）
    const lrcALen = Number(effectiveA1hLen);
    const bar1hCloseArray = bar1hTracker?.getCloseArray?.(Math.max(2, lrcALen + 1)) ?? [];
    const lrcAState = lrcATracker.updateFromCloseArray(bar1hCloseArray);
    // LRC_D更新（日足レベル視野：bar1h close配列を長窓で観測）
    const lrcDLen = Number(tradeConfig?.lrcD?.len ?? 24);
    const bar1hCloseArrayForDaily = bar1hTracker?.getCloseArray?.(Math.max(2, lrcDLen + 1)) ?? [];
    const lrcDState = lrcDTracker.updateFromCloseArray(bar1hCloseArrayForDaily);
    if (lrcTvState && lrcTvState.ready) {
        writeLog({
            ts: Date.now(),
            tag: 'LRC_TV',
            channelTop: lrcTvState.channelTop,
            channelBottom: lrcTvState.channelBottom,
            channelWidth: lrcTvState.channelTop - lrcTvState.channelBottom,
            slope: lrcTvState.slope,
            trend: lrcTvState.trendState,
        });
    }
    if (lrcAState && lrcAState.ready) {
        writeLog({
            ts: Date.now(),
            tag: 'LRC_A',
            channelTop: lrcAState.channelTop,
            channelBottom: lrcAState.channelBottom,
            channelWidth: lrcAState.channelTop - lrcAState.channelBottom,
            slope: lrcAState.slope,
            trend: lrcAState.trendState,
        });
    }
    if (lrcDState && lrcDState.ready) {
        writeLog({
            ts: Date.now(),
            tag: 'LRC_D',
            channelTop: lrcDState.channelTop,
            channelBottom: lrcDState.channelBottom,
            channelWidth: lrcDState.channelTop - lrcDState.channelBottom,
            slope: lrcDState.slope,
            trend: lrcDState.trendState,
        });
    }
    
    // LRC状態更新
    const lrcState = updateLrcState(lrcInput, {
        len: tradeConfig.lrc.len,
        devlen: tradeConfig.lrc.devlen,
        k: tradeConfig.lrc.k,
        slopeThresholdsByLen: tradeConfig.slopeThresholdsByLen,
    });
    
    // Bar15m状態取得
    const bar15mStateRaw = bar15mTracker?.getState?.() ?? null;
    const bar15mRecentBars = bar15mTracker?.getRecentBars?.(160, true) ?? [];
    const bar15mState = bar15mStateRaw
        ? {
            ...bar15mStateRaw,
            bars: bar15mRecentBars
        }
        : {
            ready: false,
            barCount: 0,
            high: 0,
            low: 0,
            mid: 0,
            bars: []
        };

    // Depth SR計算（B15M幅ヒントを注入してスケール連動）
    const lrcTvTop = Number(lrcTvState?.channelTop);
    const lrcTvBottom = Number(lrcTvState?.channelBottom);
    const lrcTvWidthUsd = (Number.isFinite(lrcTvTop) && Number.isFinite(lrcTvBottom) && lrcTvTop > lrcTvBottom)
        ? (lrcTvTop - lrcTvBottom)
        : null;
    const bar15mWidthUsd = (Number.isFinite(Number(bar15mState?.high)) && Number.isFinite(Number(bar15mState?.low)) && Number(bar15mState.high) > Number(bar15mState.low))
        ? (Number(bar15mState.high) - Number(bar15mState.low))
        : null;
    const depthScaleHint = {
        channelWidthUsd: Number.isFinite(Number(lrcTvWidthUsd))
            ? Number(lrcTvWidthUsd)
            : (Number.isFinite(Number(bar15mWidthUsd)) ? Number(bar15mWidthUsd) : null),
        source: Number.isFinite(Number(lrcTvWidthUsd)) ? 'lrc_tv_channel' : 'bar15m_range_fallback'
    };
    const depthSRv2 = computeDepthSR(current, depthScaleHint);
    const depthSR = adaptDepthSRForB(depthSRv2);

    const nowMs = Date.now();
    const bar1hBackfill = {
        enabled: bar1hBackfillState.enabled,
        inFlight: bar1hBackfillState.inFlight,
        completed: bar1hBackfillState.completed,
        attempts: bar1hBackfillState.attempts,
        neededBars: bar1hBackfillState.neededBars,
        currentCount: bar1hBackfillState.currentCount,
        remainingBars: Math.max(0, (bar1hBackfillState.neededBars || 0) - (bar1hBackfillState.currentCount || 0)),
        lastError: bar1hBackfillState.lastError,
        lastSuccessAt: bar1hBackfillState.lastSuccessAt || null,
        lastAddedBars: bar1hBackfillState.lastAddedBars,
        nextRetryAt: bar1hBackfillState.nextRetryAt || 0,
        nextRetryInMs: Math.max(0, (bar1hBackfillState.nextRetryAt || 0) - nowMs)
    };
    const bar15mBackfill = {
        enabled: bar15mBackfillState.enabled,
        inFlight: bar15mBackfillState.inFlight,
        completed: bar15mBackfillState.completed,
        attempts: bar15mBackfillState.attempts,
        neededBars: bar15mBackfillState.neededBars,
        currentCount: bar15mBackfillState.currentCount,
        remainingBars: Math.max(0, (bar15mBackfillState.neededBars || 0) - (bar15mBackfillState.currentCount || 0)),
        lastError: bar15mBackfillState.lastError,
        lastSuccessAt: bar15mBackfillState.lastSuccessAt || null,
        lastAddedBars: bar15mBackfillState.lastAddedBars,
        nextRetryAt: bar15mBackfillState.nextRetryAt || 0,
        nextRetryInMs: Math.max(0, (bar15mBackfillState.nextRetryAt || 0) - nowMs)
    };
    
    // Add lastUpdateTime for DATA_STALE diagnosis (use market data timestamp)
    const lrcStateWithTime = lrcState ? { ...lrcState, lastUpdateTime: marketTimestamp } : null;
    const lrcTvStateWithTime = lrcTvState ? { ...lrcTvState, lastUpdateTime: marketTimestamp } : null;
    const lrcAStateWithTime = lrcAState ? { ...lrcAState, lastUpdateTime: marketTimestamp } : null;
    const lrcDStateWithTime = lrcDState ? { ...lrcDState, lastUpdateTime: marketTimestamp } : null;
    const bar1hStateWithTime = bar1hState ? { ...bar1hState, lastUpdateTime: marketTimestamp } : null;

    return {
        lrcState: lrcStateWithTime,
        lrcTvState: lrcTvStateWithTime,
        lrcAState: lrcAStateWithTime,
        lrcDState: lrcDStateWithTime,
        depthSR,
        tradeFlow: tradeFlowState ?? null,
        bar15mState,
        bar1hState: bar1hStateWithTime,
        bar1hAdaptiveState,
        bar1hBackfill,
        bar15mBackfill
    };
}
function assembleIOPacket(marketState, ioMetrics, strength, extras) {
    // IOPacket v2.x 構造を正確に組み立てる（判断ロジックは一切書かない）
    
    // Boot time tracking: Initialize on first call
    if (!bootTimeInitialized) {
        bootTimeMs = Date.now();
        bootTimeInitialized = true;
        initializeStartupProfile();
    }
    
    // Calculate elapsed milliseconds since boot
    const elapsedMs = bootTimeMs ? Date.now() - bootTimeMs : 0;
    
    // Warmup constraint generation: 30 seconds window after boot
    const constraints = [];
    if (elapsedMs < 30000) {
        constraints.push('warmup');
    }
    const tradeConfig = getTradeConfig();
    const restartAssistEnabled = tradeConfig?.startup?.restartAssist?.enabled !== false;
    const restartMode = resolveRestartMode(tradeConfig);
    if (restartAssistEnabled) {
        constraints.push(`restart_${restartMode}`);
    }
    if (extras?.bar1hAdaptiveState?.switchingActive === true) {
        constraints.push('bar1h_adaptive_switching');
    }
    if (extras?.bar1hAdaptiveState?.enabled === true && extras?.bar1hAdaptiveState?.floorMet === false) {
        constraints.push('bar1h_span_floor_unmet');
    }
    
    // Calculate dataFreshness and freshnessHint for runtime safety checks
    const now = Date.now();
    const MAX_DATA_AGE_MS = 60000; // 60秒
    const bar1hLastUpdate = extras?.bar1hState?.lastUpdateTime ?? 0;
    const lrcLastUpdate = extras?.lrcState?.lastUpdateTime ?? 0;
    const bar1hReady = extras?.bar1hState?.ready ?? false;
    
    let dataFreshness = 'OK';
    let freshnessHint = null;
    
    if (!bar1hReady) {
        // bar1h 準備中（起動後約4時間）
        freshnessHint = 'WARMUP_BAR1H';
    }
    
    // データが60秒以上更新されていない場合は STALE
    const bar1hAgeMs = bar1hLastUpdate > 0 ? now - bar1hLastUpdate : null;
    const lrcAgeMs = lrcLastUpdate > 0 ? now - lrcLastUpdate : null;
    
    if ((bar1hAgeMs !== null && bar1hAgeMs > MAX_DATA_AGE_MS) || 
        (lrcAgeMs !== null && lrcAgeMs > MAX_DATA_AGE_MS)) {
        dataFreshness = 'STALE';
        freshnessHint = 'DATA_STALE';
    }
    
    return {
        timestamp: Date.now(),
        decisionId: generateDecisionId(),
        entryTs: Date.now(),
        marketState: {
            current: marketState.current,
            prev: marketState.prev,
            warn: null,
            error: null,
            fatal: null,
            freeze: false,
        },
        ioMetrics: {
            cRaw: ioMetrics?.cRaw ?? null,
            c: ioMetrics?.c ?? null,
            cPrev: ioMetrics?.cPrev ?? null,
            zone: ioMetrics?.zone ?? null,
            isNearTop: !!ioMetrics?.isNearTop,
            isNearBottom: !!ioMetrics?.isNearBottom,
            diffs: ioMetrics?.diffs ?? { midPx: 0, oi: 0, bestBid: 0, bestAsk: 0, lastTradePx: 0 },
            lrcState: extras?.lrcState ?? null,
            lrcTvState: extras?.lrcTvState ?? null,
            lrcAState: extras?.lrcAState ?? null,
            lrcDState: extras?.lrcDState ?? null,
            depthSR: extras?.depthSR ?? null,
            tradeFlow: extras?.tradeFlow ?? null,
            bar15mState: extras?.bar15mState ?? null,
            bar1hState: extras?.bar1hState ?? null,
            bar1hAdaptiveState: extras?.bar1hAdaptiveState ?? null,
            bar1hBackfill: extras?.bar1hBackfill ?? null,
            bar15mBackfill: extras?.bar15mBackfill ?? null,
            elapsedMs,
            constraints,
            startupProfile: {
                enabled: restartAssistEnabled,
                mode: restartMode,
                downtimeMs: Number.isFinite(startupDowntimeMs) ? startupDowntimeMs : null,
            },
            dataFreshness,        // ← 追加
            freshnessHint,        // ← 追加
            bar1hAgeMs,           // ← 追加（診断用）
            lrcAgeMs,             // ← 追加（診断用）
        },
        strength: {
            A: strength.A,
            B: strength.B,
            firepower: {
                rank: 'normal',
                factor: 1.0,
            },
        },
    };
}
function emitIODebug(packet) {
    if (!packet)
        return;
    try {
        const cur = packet?.marketState?.current ?? {};
        const digest = {
            mid: cur?.midPx ?? null,
            oi: cur?.oi ?? null,
            coin: cur?.coin ?? cur?.symbol ?? null,
            ts: packet.timestamp ?? Date.now(),
            side: cur?.lastTradeSide ?? null,
            lastTradePx: cur?.lastTradePx ?? null,
            bestBid: cur?.bestBidPx ?? null,
            bestAsk: cur?.bestAskPx ?? null,
            flowPressure: Number(cur?.tradeFlow?.flowPressure ?? 0)
        };
        bridgeEmitter.emit('debug-packet', { layer: 'io', data: digest, ts: Date.now() });
    }
    catch (err) {
        console.error('[IO] emitIODebug failed', err);
    }
}
function emitIODebugError(message) {
    try {
        bridgeEmitter.emit('debug-error', { layer: 'io', message, ts: Date.now() });
    }
    catch (err) {
        console.error('[IO] emitIODebugError failed', err);
    }
}
// 公開関数：現在の IOPacket を返す（外部が参照する唯一の窓口）
export function getIOPacket() {
    return lastIOPacket;
}
// Executor へ渡す最小・安全構造に整形して返す（判定ロジックは一切なし）
export function getExecutorPayload() {
    if (!lastIOPacket)
        return null;
    const ts = lastIOPacket.timestamp ?? Date.now();
    const strength = {
        A: Number(lastIOPacket?.strength?.A ?? 0),
        B: Number(lastIOPacket?.strength?.B ?? 0),
    };
    const io = lastIOPacket.ioMetrics ?? {};
    // market: Executorが必要とする最小セットのみ抽出
    const cur = lastIOPacket?.marketState?.current ?? {};
    const market = {
        midPx: cur?.midPx ?? null,
        bestBid: cur?.bestBidPx ?? null,
        bestAsk: cur?.bestAskPx ?? null,
        oi: cur?.oi ?? null,
        funding: cur?.funding ?? null,
        premium: cur?.premium ?? null,
        oraclePx: cur?.oraclePx ?? null,
        markPx: cur?.markPx ?? null,
        impactBidPx: cur?.impactBidPx ?? null,
        impactAskPx: cur?.impactAskPx ?? null,
        prevDayPx: cur?.prevDayPx ?? null,
        dayNtlVlm: cur?.dayNtlVlm ?? null,
        dayBaseVlm: cur?.dayBaseVlm ?? null,
        lastTradeSide: cur?.lastTradeSide ?? null,
        lastTradePx: cur?.lastTradePx ?? null,
        tradeFlow: io?.tradeFlow ?? cur?.tradeFlow ?? null,
        bids: cur?.bids ?? null,
        asks: cur?.asks ?? null,
    };
    const mode = process.env.MODE === 'live' ? 'live' : 'test';
    const accountEquity = mode === 'live' ? getBaseEquityLiveUsd() : getInitialCapitalUsd();
    const tradeConfig = getTradeConfig();
    const payload = {
        timestamp: ts,
        strength,
        ioMetrics: {
            cRaw: io?.cRaw ?? null,
            c: io?.c ?? null,
            cPrev: io?.cPrev ?? null,
            zone: (io?.zone ?? null),
            isNearTop: !!io?.isNearTop,
            isNearBottom: !!io?.isNearBottom,
            lrcState: io?.lrcState ?? null,
            lrcTvState: io?.lrcTvState ?? null,
            lrcAState: io?.lrcAState ?? null,
            lrcDState: io?.lrcDState ?? null,
            depthSR: io?.depthSR ?? null,
            tradeFlow: io?.tradeFlow ?? null,
            bar15mState: io?.bar15mState ?? null,
            bar1hState: io?.bar1hState ?? null,
            bar1hAdaptiveState: io?.bar1hAdaptiveState ?? null,
            diffs: {
                midPx: Number(io?.diffs?.midPx ?? 0),
                oi: Number(io?.diffs?.oi ?? 0),
                bestBid: Number(io?.diffs?.bestBid ?? 0),
                bestAsk: Number(io?.diffs?.bestAsk ?? 0),
                lastTradePx: Number(io?.diffs?.lastTradePx ?? 0),
            },
            elapsedMs: io?.elapsedMs ?? null,
            dataFreshness: io?.dataFreshness ?? null,
            freshnessHint: io?.freshnessHint ?? null,
            bar1hAgeMs: io?.bar1hAgeMs ?? null,
            lrcAgeMs: io?.lrcAgeMs ?? null,
            // P3修正: constraints を ExecutorPayload に含める
            constraints: io?.constraints ?? [],
        },
        market,
        accountEquity: accountEquity ?? null,
        engineState: global?.engineState ?? null,
        openPosition: global?.engineState?.openPosition ?? null,
        stateStore: global?.engineState?.stateStore ?? null,
        riskAllocation: tradeConfig?.riskAllocation ?? { enabled: false, maxPerTradeUsd: 400 },
    };
    return payload;
}
// ────────────────────────────────────────
// TEST Engine Hook (v1.0)
// ────────────────────────────────────────
import { decideTrade } from '../logic/index.js';
import { createInitialState } from '../engine/state.js';
import { loadEngineState, saveEngineState } from '../engine/stateStore.js';
import { updateEngine } from '../engine/update.js';
import { buildTestPacket } from '../engine/packet.js';
// TEST Engine state パス: TEST_MODE 優先で固定パス使用（MODE に依存しない）
const TEST_STATE_PATH = () => {
  const envOverride = process.env.ENGINE_STATE_PATH;
  if (envOverride && envOverride.trim().length > 0) {
    return path.resolve(process.cwd(), envOverride.trim());
  }
  // TEST_MODE 固定で engine_state.TEST.json を使用（MODE の影響を受けない）
  return path.join(process.cwd(), 'ws', 'engine_state.TEST.json');
};
let testEngineState = loadEngineState(createInitialState, TEST_STATE_PATH());
/**
 * testEngineHook
 * I/O 更新直後に Logic → TEST Engine を実行し、UI にパケット送信
 */
async function testEngineHook(ioPacket) {
    if (!ioPacket || !testEngineState)
        return;
    // ExecutorPayload 形式に変換
    const basePayload = getExecutorPayload();
    if (!basePayload)
        return;
    basePayload.engineState = testEngineState ?? null;
    basePayload.openPosition = testEngineState?.openPosition ?? null;
    basePayload.stateStore = testEngineState?.stateStore ?? null;
    // Logic 実行
    const decision = decideTrade(basePayload);
    if (process.env.LOGIC_ONLY === '1')
        return;
    // TEST用オーダー生成（STEP1: 生成のみ、どこにも送らない）
    const { createTestOrder } = (await import('../test/createTestOrder.js'));
    const testOrder = createTestOrder(decision.side, basePayload.market.midPx, basePayload.timestamp);
    console.log('[TEST-ORDER]', testOrder);
    // STEP2: TEST判定関数を呼び出し、結果をconsole.log
    const { evaluateTestTrade } = (await import('../test/evaluateTestTrade.js'));
    const testResult = evaluateTestTrade(testOrder);
    console.log('[TEST-RESULT]', testResult);
    // STEP3: WebUIへ6項目のみ送信（ws/utils/logger.jsのwriteを利用）
    const logger = await import('../ws/utils/logger.js');
    const payload = {
        ts: testOrder.ts,
        side: testOrder.side,
        entryPrice: testOrder.entryPrice,
        exitPrice: testResult.exitPrice,
        pnl: testResult.pnl,
        result: testResult.result
    };
    logger.write(payload);
    // TEST-Result-Observation: 永続保存（重複防止付き）
    logger.persistTestResult(payload);
    console.log('[TEST-EMIT]', payload);
    // TEST Engine 更新
    testEngineState = updateEngine(testEngineState, basePayload.market, decision, Date.now());
    saveEngineState(testEngineState, TEST_STATE_PATH());
    // TEST Packet 生成
    const testPacket = buildTestPacket(testEngineState);
    // UI に送信
    publishTestPacket(testPacket);
}
/**
 * publishTestPacket
 * TEST Packet を BridgeEmitter 経由で Terminal UI に送信
 */
function publishTestPacket(packet) {
    bridgeEmitter.emit('test-packet', packet);
}
// TEST Engine のリセット（必要に応じて外部から呼び出し可能）

// TEST Engineのstatsを取得するgetter
export function getTestEngineStats() {
    if (!testEngineState || !testEngineState.stats) return null;
    return testEngineState.stats;
}

export function resetTestEngine() {
    testEngineState = createInitialState();
}

/**
 * updateIOConfigForHotReload
 * コンフィグ変更時に IO層内のトラッカー設定を動的に更新
 * 
 * @param {Object} newConfig - 新しいトレード設定
 */
export function updateIOConfigForHotReload(newConfig) {
    const topDownBars = resolveTopDownBars(newConfig);
    const effectiveB15mLen = topDownBars.enabled && Number.isFinite(topDownBars.bBars)
        ? topDownBars.bBars
        : Number(newConfig?.lrc?.len ?? 100);
    const lrcAConfig = newConfig?.lrcA ?? newConfig?.lrc ?? {};
    const effectiveA1hLen = topDownBars.enabled && Number.isFinite(topDownBars.aBars)
        ? topDownBars.aBars
        : Number(lrcAConfig?.len ?? newConfig?.lrc?.len ?? 100);

    // bar1h の lookbackBars 設定を更新
    if (bar1hTracker && newConfig?.bar1h) {
        bar1hTracker.updateConfig(newConfig.bar1h);
    }
    if (lrcTvTracker && newConfig?.lrc) {
        lrcTvTracker.config = {
            len: effectiveB15mLen,
            devlen: newConfig.lrc.devlen,
            k: newConfig.lrc.k,
        };
    }
    if (lrcATracker) {
        if (lrcAConfig) {
            lrcATracker.config = {
                len: effectiveA1hLen,
                devlen: lrcAConfig.devlen,
                k: lrcAConfig.k,
            };
        }
    }
    if (lrcDTracker) {
        const lrcDConfig = newConfig?.lrcD;
        const lrcABase = newConfig?.lrcA ?? newConfig?.lrc;
        if (lrcDConfig || lrcABase) {
            lrcDTracker.config = {
                len: lrcDConfig?.len ?? 24,
                devlen: lrcDConfig?.devlen ?? lrcABase?.devlen,
                k: lrcDConfig?.k ?? lrcABase?.k,
            };
        }
    }
}
