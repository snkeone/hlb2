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
let prevMarketSnapshot = {
    bestBidPx: null,
    bestAskPx: null,
    midPx: null,
    oi: null,
    lastTradeSide: null,
    lastTradePx: null,
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
function computeDepthSR(current) {
    const midPx = Number(current?.midPx ?? NaN);
    const snapshot = {
        timestamp: Date.now(),
        bids: normalizeLevels(current?.bids ?? []),
        asks: normalizeLevels(current?.asks ?? []),
    };
    
    // 現行 DepthSR を計算（フォールバック用）
    // ホットリロード対応: getOrCreateDepthSRAnalyzer() で最新インスタンスを取得
    const analyzer = getOrCreateDepthSRAnalyzer();
    const depthSRv2 = analyzer.onDepthSnapshot(snapshot, midPx);
    
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
    // MarketStateの更新（prev/currentを流す）。index.tsは生成と連結のみ。
    const curRaw = packet ?? {};
    const current = {
        ...curRaw,
        bestBidPx: curRaw.bestBidPx ?? prevMarketSnapshot.bestBidPx,
        bestAskPx: curRaw.bestAskPx ?? prevMarketSnapshot.bestAskPx,
        midPx: curRaw.midPx ?? prevMarketSnapshot.midPx,
        oi: curRaw.oi ?? prevMarketSnapshot.oi,
        lastTradeSide: curRaw.side ?? curRaw.lastTradeSide ?? prevMarketSnapshot.lastTradeSide,
        lastTradePx: curRaw.px ?? curRaw.lastTradePx ?? prevMarketSnapshot.lastTradePx,
        bids: curRaw.bids ?? prevMarketSnapshot.bids,
        asks: curRaw.asks ?? prevMarketSnapshot.asks,
    };
    const prev = {
        bestBidPx: prevMarketSnapshot.bestBidPx,
        bestAskPx: prevMarketSnapshot.bestAskPx,
        midPx: prevMarketSnapshot.midPx,
        oi: prevMarketSnapshot.oi,
        lastTradeSide: prevMarketSnapshot.lastTradeSide,
        lastTradePx: prevMarketSnapshot.lastTradePx,
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
        const ioState = updateIOState(current, tradeConfig);
        
        lastIOPacket = assembleIOPacket(marketState, ioMetrics, { A, B }, ioState);
        prevMarketSnapshot.bestBidPx = current?.bestBidPx ?? prevMarketSnapshot.bestBidPx;
        prevMarketSnapshot.bestAskPx = current?.bestAskPx ?? prevMarketSnapshot.bestAskPx;
        prevMarketSnapshot.midPx = current?.midPx ?? prevMarketSnapshot.midPx;
        prevMarketSnapshot.oi = current?.oi ?? prevMarketSnapshot.oi;
        prevMarketSnapshot.lastTradeSide = current?.lastTradeSide ?? prevMarketSnapshot.lastTradeSide;
        prevMarketSnapshot.lastTradePx = current?.lastTradePx ?? prevMarketSnapshot.lastTradePx;
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
    const ioState = updateIOState(current, tradeConfig);
    
    lastIOPacket = assembleIOPacket(ms, ioMetrics, { A, B }, ioState);
    prevMarketSnapshot.bestBidPx = current?.bestBidPx ?? prevMarketSnapshot.bestBidPx;
    prevMarketSnapshot.bestAskPx = current?.bestAskPx ?? prevMarketSnapshot.bestAskPx;
    prevMarketSnapshot.midPx = current?.midPx ?? prevMarketSnapshot.midPx;
    prevMarketSnapshot.oi = current?.oi ?? prevMarketSnapshot.oi;
    prevMarketSnapshot.lastTradeSide = current?.lastTradeSide ?? prevMarketSnapshot.lastTradeSide;
    prevMarketSnapshot.lastTradePx = current?.lastTradePx ?? prevMarketSnapshot.lastTradePx;
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
function updateIOState(current, tradeConfig) {
    // Bar15m トラッカー初期化
    if (!bar15mTracker) {
        bar15mTracker = createBar15mTracker();
    }
    
    // LRC_TV トラッカー初期化
    if (!lrcTvTracker) {
        lrcTvTracker = createLrcTvTracker({
            len: tradeConfig.lrc.len,
            devlen: tradeConfig.lrc.devlen,
            k: tradeConfig.lrc.k,
        });
    }
    if (!lrcATracker) {
        const lrcAConfig = tradeConfig?.lrcA ?? tradeConfig?.lrc ?? {};
        lrcATracker = createLrcTvTracker({
            len: lrcAConfig.len ?? tradeConfig.lrc.len,
            devlen: lrcAConfig.devlen ?? tradeConfig.lrc.devlen,
            k: lrcAConfig.k ?? tradeConfig.lrc.k,
        });
    }
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
    }
    
    const lrcInput = {
        midPx: current?.midPx ?? null,
        lastTradePx: current?.lastTradePx ?? null,
    };
    
    // Bar15m更新
    bar15mTracker.update(Date.now(), lrcInput.midPx, 'midPx');
    const closeArray = bar15mTracker.getCloseArray(tradeConfig.lrc.len + 1);
    
    // Bar1h更新（Phase A）
    // Use market data timestamp (current.ts) for DATA_STALE detection
    const marketTimestamp = current?.ts ?? Date.now();
    bar1hTracker.update(Date.now(), lrcInput.midPx, 'midPx');
    const bar1hState = bar1hTracker?.getState?.() ?? null;
    const bar1hAdaptiveState = evaluateBar1hAdaptive(bar1hState, tradeConfig, Date.now());
    
    // LRC_TV更新（closeArrayを入力）
    const lrcTvState = lrcTvTracker.updateFromCloseArray(closeArray);
    const lrcALen = Number(tradeConfig?.lrcA?.len ?? tradeConfig?.lrc?.len ?? 100);
    const bar1hCloseArray = bar1hTracker?.getCloseArray?.(Math.max(2, lrcALen + 1)) ?? [];
    const lrcAState = lrcATracker.updateFromCloseArray(bar1hCloseArray);
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
    
    // Depth SR計算
    const depthSRv2 = computeDepthSR(current);
    const depthSR = adaptDepthSRForB(depthSRv2);
    
    // Bar15m状態取得
    const bar15mState = bar15mTracker?.getState?.() ?? null;
    
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
        bar15mState,
        bar1hState: bar1hStateWithTime,
        bar1hAdaptiveState
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
            depthSR: extras?.depthSR ?? null,
            bar15mState: extras?.bar15mState ?? null,
            bar1hState: extras?.bar1hState ?? null,
            bar1hAdaptiveState: extras?.bar1hAdaptiveState ?? null,
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
            bestAsk: cur?.bestAskPx ?? null
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
        lastTradeSide: cur?.lastTradeSide ?? null,
        lastTradePx: cur?.lastTradePx ?? null,
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
            depthSR: io?.depthSR ?? null,
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
    // bar1h の lookbackBars 設定を更新
    if (bar1hTracker && newConfig?.bar1h) {
        bar1hTracker.updateConfig(newConfig.bar1h);
    }
    if (lrcTvTracker && newConfig?.lrc) {
        lrcTvTracker.config = {
            len: newConfig.lrc.len,
            devlen: newConfig.lrc.devlen,
            k: newConfig.lrc.k,
        };
    }
    if (lrcATracker) {
        const lrcAConfig = newConfig?.lrcA ?? newConfig?.lrc;
        if (lrcAConfig) {
            lrcATracker.config = {
                len: lrcAConfig.len,
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
