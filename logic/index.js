// @ts-nocheck
// logic/index.ts
// Logic層 - A/Bロジックによるトレーディング判定
// 純粋関数：副作用なし、状態保持なし、外部依存なし
import bridgeEmitter from '../core/bridgeEmitter.js';
import { STOP_REASONS } from '../core/stopReasons.js';
import { getTradeConfig, resolveB1SnapshotRefreshSetting } from '../config/trade.js';
import { setDecisionTraceSnapshot } from '../core/decisionTraceCache.js';
import fs from 'fs';
import path from 'path';
import { decideTradeA } from './decision_a.js';
import { generateHigherTfStructure } from './decision_b0.js';
import { generateStructure } from './decision_b1.js';
import { decideTradeB2 } from './decision_b2.js';
import { buildStructuralSrClusterView } from './sr_cluster_bridge.js';
import { createMetaGateState, evaluateMetaGate } from './meta_gate.js';
import { REASON_CODE, resolveReasonCode } from './reasonCodes.js';
import { write as writeLog } from '../ws/utils/logger.js';

// Phase 3: StructureSnapshot 状態保持（b1/b2呼び出しフロー用）
let currentStructureSnapshot = null;
let currentB0Snapshot = null;
let lastPositionStatus = null; // 'open' | 'closed'
let currentStructureSnapshotSeq = 0;
let currentSrClusterView = null;
let currentSrClusterViewCreatedAt = 0;
let currentSrClusterViewSnapshotHash = null;
let lastB1RefreshAt = 0;
let metaGateState = createMetaGateState();

function clamp01(value, fallback = 0.5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

function normalizeBias(raw) {
    const v = String(raw ?? '').toUpperCase();
    return v === 'UP' || v === 'DOWN' || v === 'RANGE' ? v : 'RANGE';
}

function trendStrengthToScore(raw) {
    const v = String(raw ?? '').toLowerCase();
    if (v === 'strong') return 0.8;
    if (v === 'weak') return 0.35;
    if (v === 'normal') return 0.6;
    return 0.5;
}

function slopeToScore(raw, fallback = 0.5) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clamp01(Math.abs(n), fallback);
}

function mapAReason(rawReason, allow) {
    if (allow) return 'ready';
    const txt = String(rawReason ?? '').toLowerCase();
    if (txt.includes('bar1h') || txt.includes('warmup')) return 'bar1h_not_ready';
    if (txt.includes('daily')) return 'bar_daily_not_ready';
    if (txt.includes('arena')) return 'no_arena';
    if (txt.includes('data not ready')) return 'bar1h_not_ready';
    return 'not_ready';
}

function normalizeB2RejectReason(rawReason) {
    const reason = String(rawReason ?? '').toLowerCase();
    if (!reason) return 'execution_invalid';
    if (reason.includes('no_local_channel') || reason.includes('no structure') || reason.includes('invalid structure')) {
        return 'no_local_channel';
    }
    if (reason.includes('no_near_sr') || reason.includes('no tp') || reason.includes('no structural tp')) {
        return 'no_near_sr';
    }
    if (reason.includes('edge_negative') || reason.includes('net_edge') || reason.includes('tp distance too short')) {
        return 'edge_negative';
    }
    return 'execution_invalid';
}

function pickFirstReasonCandidate(candidates) {
    for (const candidate of candidates) {
        const text = String(candidate?.value ?? '').trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        if (lower === 'unknown' || lower === 'none' || lower === 'null' || lower === 'undefined') continue;
        return {
            reason: text,
            source: candidate?.source ?? 'unknown'
        };
    }
    return {
        reason: '',
        source: 'fallback_empty'
    };
}

function resolveB2RawReason(bResult) {
    const phase4 = bResult?.phase4 ?? {};
    const executionQuality = phase4?.executionQuality ?? {};
    const executionInputs = bResult?.executionInputs ?? {};

    const direct = pickFirstReasonCandidate([
        { source: 'bResult.reason', value: bResult?.reason },
        { source: 'bResult.reasonRaw', value: bResult?.reasonRaw },
        { source: 'bResult.reasonCode', value: bResult?.reasonCode },
        { source: 'phase4.executionQuality.reason', value: executionQuality?.reason },
        { source: 'phase4.flowGate.reason', value: phase4?.flowGate?.reason },
        { source: 'phase4.ctxGate.reason', value: phase4?.ctxGate?.reason },
        { source: 'phase4.oiTrapGate.reason', value: phase4?.oiTrapGate?.reason },
        { source: 'phase4.startupGuard.reason', value: phase4?.startupGuard?.reason },
        { source: 'phase4.feeEdgeGuard.reason', value: phase4?.feeEdgeGuard?.reason },
        { source: 'phase4.tpSource', value: phase4?.tpSource },
        { source: 'phase4.rejectedTpSource', value: phase4?.rejectedTpSource }
    ]);

    if (direct.reason) {
        return direct;
    }

    const rawEntryQualityScore = Number(executionInputs?.rawEntryQualityScore);
    const minEntryQuality = Number(executionInputs?.minEntryQuality);
    if (Number.isFinite(rawEntryQualityScore)
        && Number.isFinite(minEntryQuality)
        && rawEntryQualityScore < minEntryQuality) {
        return {
            reason: 'execution_quality_below_min',
            source: 'executionInputs.rawEntryQualityScore'
        };
    }

    return {
        reason: 'execution_invalid',
        source: 'fallback_execution_invalid'
    };
}

function normalizeAResult(rawA, payload) {
    const regime = normalizeBias(rawA?.regime);
    const allow = rawA?.allow === true;
    const ioMetrics = payload?.ioMetrics ?? {};
    const lrcDState = ioMetrics?.lrcDState ?? null;
    const lrcAState = ioMetrics?.lrcAState ?? null;
    const lrcTvState = ioMetrics?.lrcTvState ?? null;
    const arena = rawA?.arena ?? null;
    const top = Number(arena?.channelTop);
    const bottom = Number(arena?.channelBottom);
    const mid = Number(arena?.mid);
    const arena1h = (Number.isFinite(top) && Number.isFinite(bottom) && top > bottom)
        ? {
            top,
            bottom,
            mid: Number.isFinite(mid) ? mid : (top + bottom) / 2
        }
        : null;
    const dailyTop = Number(lrcDState?.channelTop);
    const dailyBottom = Number(lrcDState?.channelBottom);
    const dailyMid = Number(lrcDState?.channelMid);
    const dailyArena = (Number.isFinite(dailyTop) && Number.isFinite(dailyBottom) && dailyTop > dailyBottom)
        ? {
            top: dailyTop,
            bottom: dailyBottom,
            mid: Number.isFinite(dailyMid) ? dailyMid : (dailyTop + dailyBottom) / 2
        }
        : null;
    const strengthFromGate = trendStrengthToScore(rawA?.trend_strength);
    const lrcSlopeAbs = Math.abs(Number(lrcAState?.normalizedSlope ?? ioMetrics?.lrcState?.normalizedSlope ?? NaN));
    const inferredStrength = Number.isFinite(lrcSlopeAbs) ? Math.min(1, lrcSlopeAbs) : strengthFromGate;
    const score = clamp01(inferredStrength, strengthFromGate);
    const dailyBias = normalizeBias(
        rawA?.dailyBias ??
        lrcDState?.trendState ??
        lrcDState?.trend ??
        lrcAState?.trendState ??
        lrcAState?.trend ??
        regime
    );
    const h1Bias = normalizeBias(
        rawA?.h1Bias ??
        lrcAState?.trendState ??
        lrcAState?.trend ??
        lrcTvState?.trendState ??
        lrcTvState?.trend ??
        regime
    );
    const dailyStrength = clamp01(
        Number.isFinite(Number(rawA?.dailyStrength))
            ? Number(rawA.dailyStrength)
            : slopeToScore(lrcDState?.normalizedSlope, score),
        score
    );
    const h1Strength = clamp01(
        Number.isFinite(Number(rawA?.h1Strength))
            ? Number(rawA.h1Strength)
            : slopeToScore(lrcAState?.normalizedSlope ?? lrcTvState?.normalizedSlope, score),
        score
    );
    return {
        // New A contract fields
        dailyBias,
        dailyStrength,
        h1Bias,
        h1Strength,
        arena1h,
        dailyArena,
        fallbackUsed: rawA?.fallbackUsed === true,
        fallbackSource: rawA?.fallbackSource ?? 'PRIMARY',
        biasRoute: rawA?.biasRoute ?? null,
        dailyTrendSource: rawA?.dailyTrendSource ?? null,
        h1TrendSource: rawA?.h1TrendSource ?? null,
        biasFallbackUsed: rawA?.biasFallbackUsed === true,
        aValid: allow,
        aReason: mapAReason(rawA?.reason, allow),
        aTrendAngle: {
            dailySlope: Number.isFinite(Number(lrcDState?.slope)) ? Number(lrcDState.slope) : null,
            h1Slope: Number.isFinite(Number(lrcAState?.slope)) ? Number(lrcAState.slope) : null
        },
        // Legacy fields (compatibility)
        regime: rawA?.regime ?? 'NONE',
        regimeLabel: rawA?.regimeLabel ?? rawA?.regime ?? 'NONE',
        side: rawA?.side ?? null,
        zone: rawA?.zone ?? null,
        trend_strength: rawA?.trend_strength ?? null,
        arena: rawA?.arena ?? null,
        allow,
        reason: rawA?.reason ?? (allow ? 'A: ready' : 'A: not ready'),
        constraints: Array.isArray(rawA?.constraints) ? rawA.constraints : [],
        _gateDiag: rawA?._gateDiag ?? null
    };
}

function logLogicError(reason, err) {
    try {
        console.error(JSON.stringify({
            type: 'error',
            component: 'logic/index',
            reason,
            message: err?.message || String(err),
            stack: err?.stack || null
        }));
    }
    catch (e) {
        console.error('[LOGIC] logLogicError failed', e);
    }
}

// ─────────────────────────
// A Gate 診断：rate limiting 状態
// ─────────────────────────
const aGateState = {
  lastReason: null,
  lastDiagLog: 0
};
const A_GATE_LOG_INTERVAL_MS = 5000; // 5秒に1回

/**
 * decideTrade
 * ExecutorPayload を受け取り、A/Bロジックで side/size/reason を決定
 * 
 * フロー:
 * 1. Global Safety チェック
 * 2. Aロジック（俯瞰判定）
 * 3. Aが許可した場合、Bロジック（売買判断）
 * 4. 結果を Decision として返却
 * 
 * @param payload ExecutorPayload (I/O層からの入力)
 * @returns TradingDecisionPayload (side/size/reason)
 */
export function decideTrade(payload) {
    // [A1-4] Date.now 単一取得ポリシー：入口でのみ取得し以降は payload.timestamp を参照
    const ts = Date.now();
    payload.timestamp = ts;
    const { ioMetrics, strength } = payload;
    if (!ioMetrics || typeof ioMetrics !== 'object') {
        const aResult = normalizeAResult({
            regime: 'NONE',
            arena: null,
            allow: false,
            constraints: ['NO_METRICS'],
            reason: 'A: metrics unavailable'
        }, payload);
        return emitDecision({
            side: 'none',
            size: 0.0,
            reason: aResult.reason,
            source: 'A'
        }, payload, { aResult, bResult: null });
    }
    const { c: rawC, cPrev, zone, lrcState, depthSR } = ioMetrics;
    const safeStrength = strength || {};
    const { A, B } = safeStrength;
    const tradeConfig = getTradeConfig();
    const c = Number(rawC);
    ioMetrics.c = c;
    const isExtremeC = Number.isFinite(c) && Math.abs(c) >= 0.97;
    const firepower = lrcState ? resolveFirepower(lrcState, tradeConfig, isExtremeC) : null;
    payload.strength = { ...safeStrength, firepower };
    
    // ────────────────────────
    // Global Safety: 即座に none を返す条件
    // ────────────────────────
    if (!Number.isFinite(c)) {
        const aResult = normalizeAResult({
            regime: 'NONE',
            arena: null,
            allow: false,
            constraints: ['NO_C'],
            reason: 'A: no valid c'
        }, payload);
        return emitDecision({
            side: 'none',
            size: 0.0,
            reason: STOP_REASONS.SKIP_NO_C,
            source: 'A'
        }, payload, { aResult, bResult: null });
    }

    let metaGate;
    try {
        metaGate = evaluateMetaGate(payload, metaGateState, ts);
        metaGateState = metaGate?.nextState ?? metaGateState;
    } catch (err) {
        logLogicError('evaluateMetaGate', err);
        metaGate = {
            allow: false,
            reason: 'META: evaluation error',
            score: null,
            diagnostics: { code: 'META_EVAL_ERROR', message: err?.message ?? String(err) },
            nextState: metaGateState
        };
    }
    if (!metaGate.allow) {
        const aResult = normalizeAResult({
            regime: 'NONE',
            arena: null,
            allow: false,
            constraints: ['meta_toxic_flow'],
            reason: 'A: meta toxic flow'
        }, payload);
        return emitDecision({
            side: 'none',
            size: 0.0,
            reason: metaGate.reason,
            source: 'META',
            context: {
                aResult,
                bResult: null,
                metaGate: {
                    allow: metaGate.allow,
                    reason: metaGate.reason,
                    score: metaGate.score,
                    diagnostics: metaGate.diagnostics
                }
            }
        }, payload, { aResult, bResult: null, metaGate });
    }
    
    // ────────────────────────
    // A ロジック（俯瞰判定）
    // ────────────────────────
    // Note: mid chop チェック (abs(c) < 0.20) は decision_a.js 内で実施
    //       bar1h チェックを優先するため、ここでの Early return は削除
    const rawAResult = decideTradeA(payload);
    const aResult = normalizeAResult(rawAResult, payload);
    
    // ────────────────────────
    // Phase 3: b1 構造生成・保持フロー
    // ────────────────────────
    // B1はA.allowに依存せず常時評価。
    // 更新トリガー:
    // - 経過時間 >= b1.snapshotRefreshSec（0なら毎tick）
    // - midが現railsを逸脱
    // - 現在spanとlrcTv spanの乖離が閾値を超過
    const positionStatus = resolvePositionStatus(payload);
    if (positionStatus === 'closed' && lastPositionStatus === 'open') {
        // exit完了 → snapshotを破棄
        currentStructureSnapshot = null;
        currentB0Snapshot = null;
        currentSrClusterView = null;
        currentSrClusterViewCreatedAt = 0;
        currentSrClusterViewSnapshotHash = null;
        lastB1RefreshAt = 0;
    }
    lastPositionStatus = positionStatus;

    const b1Refresh = resolveB1SnapshotRefreshSetting(tradeConfig);
    const refreshMs = b1Refresh.ms;
    const b1Cfg = tradeConfig?.b1 ?? {};
    const rebuildCfg = b1Cfg?.rebuild ?? {};
    const railsBreakBufferUsd = Math.max(0, Number(rebuildCfg?.railsBreakBufferUsd ?? 0));
    const spanChangeRatioThreshold = Math.max(0, Number(rebuildCfg?.spanChangeRatioThreshold ?? 0.12));
    const ageMs = Number.isFinite(lastB1RefreshAt)
        ? ((ts - lastB1RefreshAt) < 0 ? Number.POSITIVE_INFINITY : (ts - lastB1RefreshAt))
        : Number.POSITIVE_INFINITY;
    const triggerByTime = !currentStructureSnapshot || refreshMs === 0 || ageMs >= refreshMs;
    const midPx = Number(payload?.market?.midPx);
    const railUpper = Number(currentStructureSnapshot?.rails?.upper);
    const railLower = Number(currentStructureSnapshot?.rails?.lower);
    const triggerByRailsBreak = !!currentStructureSnapshot
        && Number.isFinite(midPx)
        && Number.isFinite(railUpper)
        && Number.isFinite(railLower)
        && (midPx > (railUpper + railsBreakBufferUsd) || midPx < (railLower - railsBreakBufferUsd));
    const currentSpanUsd = Number(currentStructureSnapshot?.spanUsd);
    const observedTop = Number(ioMetrics?.lrcTvState?.channelTop);
    const observedBottom = Number(ioMetrics?.lrcTvState?.channelBottom);
    const observedSpanUsd = (Number.isFinite(observedTop) && Number.isFinite(observedBottom) && observedTop > observedBottom)
        ? (observedTop - observedBottom)
        : null;
    const spanChangeRatio = (Number.isFinite(currentSpanUsd) && currentSpanUsd > 0 && Number.isFinite(observedSpanUsd))
        ? Math.abs(observedSpanUsd - currentSpanUsd) / currentSpanUsd
        : 0;
    const triggerBySpanChange = !!currentStructureSnapshot && spanChangeRatio >= spanChangeRatioThreshold;
    const shouldRefresh = triggerByTime || triggerByRailsBreak || triggerBySpanChange;
    if (shouldRefresh) {
        currentB0Snapshot = generateHigherTfStructure(payload, aResult, tradeConfig);
        currentStructureSnapshot = generateStructure(payload, aResult, currentB0Snapshot);
        if (currentStructureSnapshot) {
            currentStructureSnapshotSeq += 1;
            currentStructureSnapshot.snapshotSeq = currentStructureSnapshotSeq;
        }
        currentSrClusterView = null;
        currentSrClusterViewCreatedAt = 0;
        currentSrClusterViewSnapshotHash = null;
        lastB1RefreshAt = ts;
    }

    if (!aResult.allow) {
        // A Gate 診断ログ（rate limited）
        emitAGateDiag(aResult, payload);

        return emitDecision({
            side: 'none',
            size: 0.0,
            reason: aResult.reason,
            source: 'A',
            context: {
                aResult,
                bResult: null,
                metaGate: {
                    allow: metaGate.allow,
                    reason: metaGate.reason,
                    score: metaGate.score,
                    diagnostics: metaGate.diagnostics
                }
            }
        }, payload, { aResult, bResult: null, metaGate });
    }
    // B1構造が欠けるケースでも、最終判定は B2 に集約する
    // （B2内で no_depth_sr / no_structure を統一評価）
    
    // ────────────────────────
    // B ロジック（売買判断）
    // ────────────────────────
    const clusterCfg = tradeConfig?.b2Upgrade?.srClusterBridge ?? {};
    const clusterTtlMs = Math.max(0, Number(clusterCfg.cacheTtlMs ?? 0));
    const clusterDriftUsd = Math.max(0, Number(clusterCfg.invalidateMidDriftUsd ?? 0));
    const clusterBaseMid = Number(currentSrClusterView?.baseMidPrice);
    const currentMid = Number(payload?.market?.midPx);
    const midDriftUsd = (Number.isFinite(clusterBaseMid) && Number.isFinite(currentMid))
      ? Math.abs(currentMid - clusterBaseMid)
      : Number.POSITIVE_INFINITY;
    const withinDrift = clusterDriftUsd <= 0 || (Number.isFinite(midDriftUsd) && midDriftUsd <= clusterDriftUsd);
    const snapshotHash = String(currentStructureSnapshot?.hash ?? '');
    const canReuseCluster = !!currentSrClusterView
      && clusterTtlMs > 0
      && withinDrift
      && snapshotHash.length > 0
      && currentSrClusterViewSnapshotHash === snapshotHash
      && (ts - currentSrClusterViewCreatedAt) >= 0
      && (ts - currentSrClusterViewCreatedAt) <= clusterTtlMs;
    const srClusterView = canReuseCluster
      ? currentSrClusterView
      : buildStructuralSrClusterView(payload, aResult, currentStructureSnapshot, tradeConfig);
    if (!canReuseCluster) {
      currentSrClusterView = srClusterView ?? null;
      currentSrClusterViewCreatedAt = ts;
      currentSrClusterViewSnapshotHash = snapshotHash || null;
    }
        const b2StructureSnapshot = currentStructureSnapshot
            ? {
                    ...currentStructureSnapshot,
                    candidates: [],
                    _legacy: {
                        ...(currentStructureSnapshot?._legacy ?? {}),
                        candidateCount: 0
                    }
                }
            : currentStructureSnapshot;
        const bResult = decideTradeB2(payload, aResult, b2StructureSnapshot, srClusterView);
    
  if (bResult.side === 'none') {
        const rawBReason = resolveB2RawReason(bResult);
        const normalizedBReason = normalizeB2RejectReason(bResult.reason);
        const bResultForTrace = {
            ...bResult,
            reason: normalizedBReason,
            diagnostics: {
                ...(bResult?.diagnostics ?? {}),
                rawReason: rawBReason.reason,
                rawReasonSource: rawBReason.source
            }
        };
    return emitDecision({
      side: 'none',
      size: 0.0,
            reason: normalizedBReason,
        reasonCode: resolveReasonCode(normalizedBReason, REASON_CODE.STATE_HOLD),
      source: 'B',
        context: {
            aResult,
            b0Result: currentB0Snapshot,
                        bResult: bResultForTrace,
            metaGate: {
                    allow: metaGate.allow,
                    reason: metaGate.reason,
          score: metaGate.score,
          diagnostics: metaGate.diagnostics
        }
      },
      structureSnapshot: currentStructureSnapshot ? {
        basis: currentStructureSnapshot.basis,
        structureSource: currentStructureSnapshot.structureSource ?? null,
        structureQuality: currentStructureSnapshot.structureQuality ?? null,
        span: currentStructureSnapshot.spanUsd,
                channelSlope: currentStructureSnapshot?._legacy?.channelSlope ?? null,
        created: currentStructureSnapshot.createdAt,
        hash: currentStructureSnapshot.hash,
        version: currentStructureSnapshot.version,
        snapshotSeq: currentStructureSnapshot.snapshotSeq ?? null
      } : null
        }, payload, { aResult, bResult: bResultForTrace, metaGate });
  }
  
  // ────────────────────────
  // B 決定を返却
  // ────────────────────────
  return emitDecision({
    side: bResult.side,
    size: bResult.size || 0.0,
    notionalUsd: bResult.notionalUsd ?? null,
    firepower: bResult.firepower ?? null,
    sizeFactors: bResult.sizeFactors ?? null,
    entryProfile: bResult.entryProfile ?? null,
    reason: bResult.reason,
    reasonCode: resolveReasonCode(
      bResult.reason,
            bResult?.side === 'none' ? REASON_CODE.STATE_HOLD : REASON_CODE.ENTRY_ALLOWED
    ),
    source: 'B',
    // エントリー時の構造距離を保持（出口クランプ用）
    structuralDistanceUsd: bResult.structuralDistanceUsd ?? null,
    structuralPairType: bResult.structuralPairType ?? null,
    expectedUsd: bResult.expectedUsd ?? null,
    // SL距離比計算に必須（engine/update.jsでエントリー条件として要求）
    tpPx: bResult.tpPx ?? null,
    tpDistanceUsd: bResult.tpDistanceUsd ?? null,
    // B2 Phase情報の受け渡し（engine側のentryContext生成に使用）
    phase1: bResult.phase1 ?? null,
    phase2: bResult.phase2 ?? null,
    phase4: bResult.phase4 ?? null,
    tpSource: bResult.tpSource ?? null,
    tpLadder: bResult.tpLadder ?? null,
    ladderAttack: bResult.ladderAttack ?? null,
    orbit: bResult.orbit ?? null,
      context: {
        aResult,
        b0Result: currentB0Snapshot,
        bResult,
        metaGate: {
                allow: metaGate.allow,
                reason: metaGate.reason,
        score: metaGate.score,
        diagnostics: metaGate.diagnostics
      }
    },
    structureSnapshot: currentStructureSnapshot ? {
      basis: currentStructureSnapshot.basis,
      structureSource: currentStructureSnapshot.structureSource ?? null,
      structureQuality: currentStructureSnapshot.structureQuality ?? null,
      span: currentStructureSnapshot.spanUsd,
            channelSlope: currentStructureSnapshot?._legacy?.channelSlope ?? null,
      created: currentStructureSnapshot.createdAt,
      hash: currentStructureSnapshot.hash,
      version: currentStructureSnapshot.version,
      snapshotSeq: currentStructureSnapshot.snapshotSeq ?? null
    } : null
  }, payload, { aResult, bResult, metaGate });
}
function emitDecision(decision, payload, context = {}) {
  emitLogicDebug(decision, payload);
  emitDecisionTrace(decision, payload, context);
    return decision;
}
function emitLogicDebug(decision, payload) {
    try {
        const { ioMetrics, strength } = payload;
        const c = ioMetrics?.c;
        const cPrev = ioMetrics?.cPrev;
        const zone = ioMetrics?.zone ?? 'unknown';
        const lrcState = ioMetrics?.lrcState ?? null;
        const depthSR = ioMetrics?.depthSR ?? null;
        const A = strength?.A;
        const B = strength?.B;
        const mid = resolveMidPx(payload);
        const oi = resolveOi(payload);
        const bestBid = resolveBestBid(payload);
        const bestAsk = resolveBestAsk(payload);
        const accountEquity = resolveAccountEquity(payload);
        const isExtremeC = Number.isFinite(c) && Math.abs(c) >= 0.97;
        const firepower = lrcState ? resolveFirepower(lrcState, getTradeConfig(), isExtremeC) : null;
        const side = (decision?.side ?? 'none').toUpperCase();
        const size = decision?.size ?? 0;
        const rawSafety = decision?.reason?.startsWith('safety_') ? 'HALT' : 'NORMAL';
        const safety = debounceSafety(rawSafety);
        const rawReason = decision?.reason ?? 'NA';
        const reason = side !== 'NONE' && rawReason === 'safety_mid_chop'
            ? 'NONE'
            : shortenReason(rawReason);
        const tsValue = payload?.timestamp;
        const ts = formatTime(tsValue);
        if (!shouldEmitDecision(side, size, rawReason, zone, safety)) {
            return;
        }
        const trendState = lrcState?.trendState ?? 'unknown';
        const ns = lrcState?.normalizedSlope ?? null;
        const fpRank = firepower?.rank ?? 'na';
        const bandLabel = resolveBandLabel(depthSR, bestBid, bestAsk, mid);
        const depthLabel = resolveDepthReadyLabel(depthSR);
        const ratio = extractRatioFromReason(rawReason);
        const line = `[LOGIC] ts=${ts} side=${side} size=${formatNum(size)} ratio=${formatNum(ratio)} trend=${trendState} ns=${formatNum(ns)} band=${bandLabel} depth=${depthLabel} fp=${fpRank} zone=${zone} bid=${formatRaw(bestBid)} ask=${formatRaw(bestAsk)} c=${formatNum(c)} prev=${formatNum(cPrev)} A=${formatNum(A)} B=${formatNum(B)} safety=${safety} reason=${reason} mid=${formatRaw(mid)} oi=${formatRaw(oi)}`;
        bridgeEmitter.emit('debug-packet', {
            layer: 'logic',
            ts: tsValue,
            data: {
                decision: decision?.side ?? 'none',
                reason: decision?.reason ?? 'unknown',
                firepower: Number.isFinite(Number(decision?.firepower)) ? Number(decision.firepower) : null,
                size: decision?.size ?? 0,
                ts: tsValue,
                zone,
                c,
                cPrev,
                A,
                B,
                mid,
                oi,
                bestBid,
                bestAsk,
                lrcState,
                depthSR,
                accountEquity,
                firepower,
                safety,
                line
            }
        });
    }
    catch (err) {
        logLogicError('emitLogicDebug', err);
    }
}

function emitDecisionTrace(decision, payload, context = {}) {
    try {
        const ts = payload?.timestamp;
        const decisionId = payload?.decisionId ?? 'unknown';
        const entryTs = payload?.entryTs ?? ts;
        const aResult = context?.aResult ?? null;
        const bResult = context?.bResult ?? null;
        const b0Result = context?.b0Result ?? null;
        const metaGate = context?.metaGate ?? null;
        const engineState = payload?.engineState ?? null;
        const ioMetrics = payload?.ioMetrics ?? null;
        const depthSR = ioMetrics?.depthSR ?? null;
        const mid = resolveMidPx(payload);
        const bestBid = resolveBestBid(payload);
        const bestAsk = resolveBestAsk(payload);
        const strength = payload?.strength ?? {};
        const appliedFirepowerRank = strength?.firepower?.rank ?? 'unknown';
        const appliedFirepowerFactor = strength?.firepower?.factor ?? null;
        const b1SnapshotRefresh = resolveB1SnapshotRefreshSetting(getTradeConfig());
        const legacyKeysEnabled = getTradeConfig()?.compatibility?.legacyKeysEnabled !== false;
        
        // c と isExtremeC を追加（firepower 急変の原因特定用）
        const c = ioMetrics?.c ?? null;
        const cPrev = ioMetrics?.cPrev ?? null;
        const isExtremeC = Number.isFinite(c) && Math.abs(c) >= 0.97;
        const spreadBps = (Number.isFinite(mid) && mid > 0 && Number.isFinite(bestBid) && Number.isFinite(bestAsk))
            ? ((bestAsk - bestBid) / mid) * 10000
            : null;
        const velocityBps = (Number.isFinite(mid) && mid > 0)
            ? Math.abs(Number(ioMetrics?.diffs?.midPx ?? 0)) / mid * 10000
            : null;
        const cShock = (Number.isFinite(c) && Number.isFinite(cPrev))
            ? Math.abs(c - cPrev)
            : null;
        const lrcTvTop = Number(ioMetrics?.lrcTvState?.channelTop);
        const lrcTvBottom = Number(ioMetrics?.lrcTvState?.channelBottom);
        const lrcTvWidthUsd = (Number.isFinite(lrcTvTop) && Number.isFinite(lrcTvBottom) && lrcTvTop > lrcTvBottom)
            ? (lrcTvTop - lrcTvBottom)
            : null;
        const bar15mHigh = Number(ioMetrics?.bar15mState?.high);
        const bar15mLow = Number(ioMetrics?.bar15mState?.low);
        const bar15mWidthUsd = (Number.isFinite(bar15mHigh) && Number.isFinite(bar15mLow) && bar15mHigh > bar15mLow)
            ? (bar15mHigh - bar15mLow)
            : null;
        const b15mWideUsd = Number.isFinite(lrcTvWidthUsd) ? lrcTvWidthUsd : bar15mWidthUsd;
        const b15mWideSource = Number.isFinite(lrcTvWidthUsd)
            ? 'lrc_tv_channel'
            : (Number.isFinite(bar15mWidthUsd) ? 'bar15m_range_fallback' : 'unavailable');
        
        // Data freshness diagnosis (DATA_STALE vs WARMUP)
        const MAX_DATA_AGE_MS = 60000; // 60s
        const now = Date.now();
        const bar1hLastUpdate = ioMetrics?.bar1hState?.lastUpdateTime ?? 0;
        const lrcLastUpdate = ioMetrics?.lrcState?.lastUpdateTime ?? 0;
        const bar1hAgeMs = bar1hLastUpdate > 0 ? now - bar1hLastUpdate : null;
        const lrcAgeMs = lrcLastUpdate > 0 ? now - lrcLastUpdate : null;
        const bar1hReady = ioMetrics?.bar1hState?.ready ?? false;
        
        let dataFreshness = 'OK';
        let freshnessHint = null;
        
        if (!bar1hReady) {
            freshnessHint = 'WARMUP_BAR1H';
        } else if ((bar1hAgeMs !== null && bar1hAgeMs > MAX_DATA_AGE_MS) || 
                   (lrcAgeMs !== null && lrcAgeMs > MAX_DATA_AGE_MS)) {
            dataFreshness = 'STALE';
            freshnessHint = 'DATA_STALE';
        }
        
        // exitContext の生成（exit が実際に起きた場合のみ）
        // 仕様: decision.side === 'none' かつ openPosition !== null のときのみ exitContext を付与
        // 理由: exit 機会を逃した tick（hold）と区別するため
        let exitContext = null;
        if (engineState?.openPosition && (!decision?.side || decision.side === 'none')) {
            const pos = engineState.openPosition;
            const midPx = payload?.market?.midPx ?? mid;
            const tpPx = Number(pos.tpPx);
            const slPx = Number(pos.slPx);
            const elapsedMs = ts - pos.entryTs;
            
            // TP/SL 到達フラグ
            const isLong = pos.side === 'buy';
            const tpReached = Number.isFinite(tpPx) && tpPx > 0 && ((isLong && midPx >= tpPx) || (!isLong && midPx <= tpPx));
            const slReached = Number.isFinite(slPx) && slPx > 0 && ((isLong && midPx <= slPx) || (!isLong && midPx >= slPx));
            
            // TP/SL までの残り距離
            const tpDistanceUsd = Number.isFinite(tpPx) && Number.isFinite(midPx) ? Math.abs(tpPx - midPx) : null;
            const slDistanceUsd = Number.isFinite(slPx) && Number.isFinite(midPx) ? Math.abs(slPx - midPx) : null;
            
            // exit トリガーの判定（engine で実際に exit した reason を見ることが正）
            // ここでは「どの条件で exit 候補が出ていたか」を記録
            let exitTrigger = null;
            if (tpReached) exitTrigger = 'tp';
            else if (slReached) exitTrigger = 'sl';
            else exitTrigger = 'timeout'; // または other
            
            exitContext = {
                openPosition: {
                    side: pos.side,
                    entryPx: pos.entryPx,
                    size: pos.size,
                    entryTs: pos.entryTs,
                    tpPx: tpPx,
                    slPx: slPx
                },
                decisionSide: decision?.side ?? 'none',  // 実際には 'none' のはず
                tpReached,
                slReached,
                tpDistanceUsd,
                slDistanceUsd,
                exitTrigger,
                midPx,
                elapsedMs
            };
        }
        
        const bReason = bResult?.reason ?? null;
        const phase4 = bResult?.phase4 ?? null;
        const phase2 = bResult?.phase2 ?? null;
        const phase2Position = phase2?.position ?? null;
        const spanUsdTrace = Number.isFinite(Number(phase2Position?.spanUsd))
            ? Number(phase2Position.spanUsd)
            : null;
        const distToUpperTrace = Number.isFinite(Number(phase2Position?.distToUpper))
            ? Number(phase2Position.distToUpper)
            : null;
        const distToLowerTrace = Number.isFinite(Number(phase2Position?.distToLower))
            ? Number(phase2Position.distToLower)
            : null;
        const derivedChannelT = (Number.isFinite(spanUsdTrace) && spanUsdTrace > 0 && Number.isFinite(distToUpperTrace) && Number.isFinite(distToLowerTrace))
            ? Math.max(0, Math.min(1, 1 - ((2 * Math.min(Math.max(0, distToUpperTrace), Math.max(0, distToLowerTrace))) / spanUsdTrace)))
            : null;
        const executionQualityDiag = phase4?.executionQuality ?? null;
        const rawEntryQualityScoreTrace = Number.isFinite(Number(executionQualityDiag?.rawEntryQualityScore))
            ? Number(executionQualityDiag.rawEntryQualityScore)
            : null;
        const entryWeightTrace = Number.isFinite(Number(executionQualityDiag?.entryWeight))
            ? Number(executionQualityDiag.entryWeight)
            : null;
        const effectiveEntryQualityScoreTrace = Number.isFinite(Number(executionQualityDiag?.effectiveEntryQualityScore))
            ? Number(executionQualityDiag.effectiveEntryQualityScore)
            : null;
        const entryQualityScoreTrace = Number.isFinite(Number(executionQualityDiag?.entryQualityScore))
            ? Number(executionQualityDiag.entryQualityScore)
            : null;
        const minEntryQualityTrace = Number.isFinite(Number(executionQualityDiag?.minEntryQuality))
            ? Number(executionQualityDiag.minEntryQuality)
            : null;
        const scoreDeltaTrace = Number.isFinite(Number(executionQualityDiag?.scoreDelta))
            ? Number(executionQualityDiag.scoreDelta)
            : null;
        const flowGateDiag = phase4?.flowGate ?? null;
        const execDiag = phase4?.executionSignals ?? null;
        const feeDiag = phase4?.feeEdgeGuard ?? null;
        const aGateDiag = aResult?._gateDiag ?? {};
        const reasonRawTrace = bResult?.diagnostics?.rawReason ?? bResult?.reason ?? null;
        const reasonRawSourceTrace = bResult?.diagnostics?.rawReasonSource
            ?? (reasonRawTrace ? 'bResult.reason' : null);
        const blockerCategory = (() => {
            if (!bReason) return null;
            if (bReason.includes('flow hostile') || bReason.includes('flow gate')) return 'flow_gate';
            if (bReason.includes('low execution quality')) return 'execution_quality';
            if (bReason.includes('net_edge_below_min')) return 'fee_edge';
            if (bReason.includes('no structural path')) return 'structure_path';
            if (bReason.includes('impact spread')) return 'impact';
            if (bReason.includes('startup no-order') || bReason.includes('A stable')) return 'startup_guard';
            if (bReason.includes('entry allowed')) return 'entry_allowed';
            return 'other';
        })();
        const flowState = ioMetrics?.tradeFlow ?? null;
        const skippedSnapshot = payload?.skippedSnapshot ?? null;
        const traceTs = Number.isFinite(Number(payload?.timestamp)) ? Number(payload.timestamp) : Date.now();
        const tracePayload = {
            type: 'decision_trace',
            ts: traceTs,
            payload: {
                decisionId,
                entryTs,
                ts,
                engineState: engineState ? {
                    safety: engineState.safety ?? null,
                    openPosition: engineState.openPosition ?? null
                } : null,
                decision: decision ? {
                    side: decision.side ?? null,
                    size: decision.size ?? null,
                    reason: decision.reason ?? null,
                    reasonCode: resolveReasonCode(
                        decision.reason,
                        decision?.side === 'none' ? REASON_CODE.STATE_HOLD : REASON_CODE.ENTRY_ALLOWED
                    ),
                    reasonRaw: decision.reason ?? null,
                    source: decision.source ?? null
                } : null,
                appliedFirepowerRank,
                appliedFirepowerFactor,
                b1SnapshotRefreshSec: b1SnapshotRefresh.sec,
                b1SnapshotRefreshSource: b1SnapshotRefresh.source,
                c,
                isExtremeC,
                ioMetrics: ioMetrics ? {
                    elapsedMs: ioMetrics.elapsedMs ?? null,
                    constraints: ioMetrics.constraints ?? [],
                    lrcState: ioMetrics.lrcState ?? null,
                    lrcTvState: ioMetrics.lrcTvState ?? null,
                    depthSR: ioMetrics.depthSR ?? null,
                    bar1hState: ioMetrics.bar1hState ?? null,
                    bar15mState: ioMetrics.bar15mState ?? null,
                    b15mWidthDiag: {
                        b15mWideUsd,
                        source: b15mWideSource,
                        lrcTvTop: Number.isFinite(lrcTvTop) ? lrcTvTop : null,
                        lrcTvBottom: Number.isFinite(lrcTvBottom) ? lrcTvBottom : null,
                        lrcTvWidthUsd,
                        bar15mHigh: Number.isFinite(bar15mHigh) ? bar15mHigh : null,
                        bar15mLow: Number.isFinite(bar15mLow) ? bar15mLow : null,
                        bar15mWidthUsd
                    },
                    bar1hAgeMs,
                    lrcAgeMs,
                    dataFreshness,
                    freshnessHint
                } : null,
                frequency_metrics: skippedSnapshot ? {
                    evaluated: Number.isFinite(Number(skippedSnapshot?.evaluated)) ? Number(skippedSnapshot.evaluated) : 0,
                    entered: Number.isFinite(Number(skippedSnapshot?.entered)) ? Number(skippedSnapshot.entered) : 0,
                    entry_rate: Number.isFinite(Number(skippedSnapshot?.entryRate))
                        ? Number(skippedSnapshot.entryRate)
                        : (Number.isFinite(Number(skippedSnapshot?.evaluated)) && Number(skippedSnapshot.evaluated) > 0
                            ? Number(skippedSnapshot.entered ?? 0) / Number(skippedSnapshot.evaluated)
                            : 0),
                    entry_rate_pct: Number.isFinite(Number(skippedSnapshot?.entryRatePct))
                        ? Number(skippedSnapshot.entryRatePct)
                        : null,
                    skipped_total: Number.isFinite(Number(skippedSnapshot?.skippedTotal)) ? Number(skippedSnapshot.skippedTotal) : null
                } : null,
                context: {
                    b1SnapshotRefreshSec: b1SnapshotRefresh.sec,
                    b1SnapshotRefreshSource: b1SnapshotRefresh.source,
                    aResult: aResult ? {
                        dailyBias: aResult.dailyBias ?? null,
                        dailyStrength: aResult.dailyStrength ?? null,
                        h1Bias: aResult.h1Bias ?? null,
                        h1Strength: aResult.h1Strength ?? null,
                        arena1h: aResult.arena1h ?? null,
                        dailyArena: aResult.dailyArena ?? null,
                        aTrendAngle: aResult.aTrendAngle ?? null,
                        aValid: aResult.aValid ?? null,
                        aReason: aResult.aReason ?? null,
                        ...(legacyKeysEnabled ? {
                            regime: aResult.regime ?? null,
                            regimeLabel: aResult.regimeLabel ?? aResult.regime ?? null,
                            side: aResult.side ?? null,
                            zone: aResult.zone ?? null,
                            trend_strength: aResult.trend_strength ?? null,
                            arena: aResult.arena ?? null,
                            allow: aResult.allow ?? null,
                            reason: aResult.reason ?? null,
                            constraints: aResult.constraints ?? [],
                            _gateDiag: aResult._gateDiag ?? null
                        } : {})
                    } : null,
                    b0Result: b0Result ? {
                        source: b0Result.source ?? null,
                        mergeDistanceUsd: b0Result.mergeDistanceUsd ?? null,
                        dailyArenaBufferUsd: b0Result.dailyArenaBufferUsd ?? null,
                        createdAt: b0Result.createdAt ?? null,
                        candidateCount: Array.isArray(b0Result.candidates) ? b0Result.candidates.length : 0,
                        candidates: Array.isArray(b0Result.candidates) ? b0Result.candidates : []
                    } : null,
                    bResult: bResult ? {
                        side: bResult.side ?? null,
                        reasonCode: bResult.reasonCode ?? resolveReasonCode(
                            bResult.reason,
                            bResult?.side === 'none' ? REASON_CODE.STATE_HOLD : REASON_CODE.ENTRY_ALLOWED
                        ),
                        reasonRaw: reasonRawTrace,
                        reasonRawSource: reasonRawSourceTrace,
                        b1Block: bResult.b1Block ? {
                            code: bResult.b1Block.code ?? null,
                            reason: bResult.b1Block.reason ?? null,
                            message: bResult.b1Block.message ?? bResult.b1Block.reason ?? null,
                            inclusionRatio: Number.isFinite(Number(bResult.b1Block.inclusionRatio))
                                ? Number(bResult.b1Block.inclusionRatio)
                                : null,
                            minInclusionRatio: Number.isFinite(Number(bResult.b1Block.minInclusionRatio))
                                ? Number(bResult.b1Block.minInclusionRatio)
                                : null,
                            b0CandidateCount: Number.isFinite(Number(bResult.b1Block.b0CandidateCount))
                                ? Number(bResult.b1Block.b0CandidateCount)
                                : null,
                            depthSpanUsd: Number.isFinite(Number(bResult.b1Block.depthSpanUsd))
                                ? Number(bResult.b1Block.depthSpanUsd)
                                : null,
                            minDepthSpanUsd: Number.isFinite(Number(bResult.b1Block.minDepthSpanUsd))
                                ? Number(bResult.b1Block.minDepthSpanUsd)
                                : null
                        } : null,
                        firepower: bResult.firepower ?? 1.0,             // ← 新規追加（デフォルト 1.0）
                        mapClusterCount: Number.isFinite(Number(bResult?.mapClusterCount))
                            ? Number(bResult.mapClusterCount)
                            : (Number.isFinite(Number(bResult?.phase1?.srClusters?.count))
                                ? Number(bResult.phase1.srClusters.count)
                                : null),
                        mapStrength: Number.isFinite(Number(bResult?.mapStrength))
                            ? Number(bResult.mapStrength)
                            : (Number.isFinite(Number(bResult?.phase1?.srClusters?.mapStrength))
                                ? Number(bResult.phase1.srClusters.mapStrength)
                                : null),
                        sizeFactors: bResult.sizeFactors ?? null,
                        entryProfile: bResult.entryProfile ?? null,
                        reason: bResult.reason ?? null,
                        zone: bResult.zone ?? null,
                        state: bResult.state ?? null,
                    tpSource: bResult.tpSource ?? null,
                    tpPhase: bResult.tpPhase ?? null,
                    tpLadder: bResult.tpLadder ?? null,
                    rejectedTpSource: bResult.phase4?.rejectedTpSource ?? null,
                    midPrice: bResult.midPrice ?? resolveMidPx(payload) ?? null,
                    supportPrice: bResult.supportPrice ?? null,
                    resistancePrice: bResult.resistancePrice ?? null,
                    distToSupport: bResult.distToSupport ?? null,
                    distToResistance: bResult.distToResistance ?? null,
                    bandLower: bResult.bandLower ?? null,
                    bandUpper: bResult.bandUpper ?? null,
                    structuralDistanceUsd: bResult.structuralDistanceUsd ?? null,
                    structuralPairType: bResult.structuralPairType ?? null,
                    distanceReason: bResult.distanceReason ?? null,
                        tpPx: bResult.tpPx ?? null,
                        tpDistanceUsd: bResult.tpDistanceUsd ?? null,
                            expectedUsd: bResult.expectedUsd ?? null,
                            executionInputs: {
                                spanUsd: spanUsdTrace,
                                distToUpper: distToUpperTrace,
                                distToLower: distToLowerTrace,
                                channelT: derivedChannelT,
                                rawEntryQualityScore: rawEntryQualityScoreTrace,
                                entryWeight: entryWeightTrace,
                                effectiveEntryQualityScore: effectiveEntryQualityScoreTrace,
                                entryQualityScore: entryQualityScoreTrace,
                                minEntryQuality: minEntryQualityTrace,
                                scoreDelta: scoreDeltaTrace
                            },
                        phase1: bResult.phase1 ? {
                            srClusters: bResult.phase1.srClusters ?? null,
                            bRegime: bResult.phase1.bRegime ?? null
                        } : null,
                        phase2: bResult.phase2 ? {
                            atEdge: bResult.phase2.atEdge ?? null,
                                srReferences: bResult.phase2.srReferences ?? bResult.phase2.srReference ?? null,
                                position: bResult.phase2.position ? {
                                    mid: Number.isFinite(Number(bResult.phase2.position?.mid)) ? Number(bResult.phase2.position.mid) : null,
                                    channelUpper: Number.isFinite(Number(bResult.phase2.position?.channelUpper)) ? Number(bResult.phase2.position.channelUpper) : null,
                                    channelLower: Number.isFinite(Number(bResult.phase2.position?.channelLower)) ? Number(bResult.phase2.position.channelLower) : null,
                                    channelCenter: Number.isFinite(Number(bResult.phase2.position?.channelCenter)) ? Number(bResult.phase2.position.channelCenter) : null,
                                    distToUpper: Number.isFinite(Number(bResult.phase2.position?.distToUpper)) ? Number(bResult.phase2.position.distToUpper) : null,
                                    distToLower: Number.isFinite(Number(bResult.phase2.position?.distToLower)) ? Number(bResult.phase2.position.distToLower) : null,
                                    spanUsd: Number.isFinite(Number(bResult.phase2.position?.spanUsd)) ? Number(bResult.phase2.position.spanUsd) : null,
                                    channelT: derivedChannelT
                                } : null,
                            srReferenceClusterGate: bResult.phase2.srReferenceClusterGate ?? null,
                            containmentGate: bResult.phase2.containmentGate ?? null
                        } : null,
                        phase4: bResult.phase4 ? {
                        decidedSide: bResult.phase4.decidedSide ?? null,
                        startupGuard: bResult.phase4.startupGuard ?? null,
                        flowGate: bResult.phase4.flowGate ?? null,
                        ctxGate: bResult.phase4.ctxGate ?? null,
                        oiTrapGate: bResult.phase4.oiTrapGate ?? null,
                        tpBandDiagnostics: bResult.phase4.tpBandDiagnostics ?? null,
                        executionSignals: bResult.phase4.executionSignals ?? null,
                        executionQuality: bResult.phase4.executionQuality ?? null,
                        executionModel: bResult.phase4.executionModel ?? null,
                        wsSize: bResult.phase4.wsSize ?? null,
                        feeEdgeGuard: bResult.phase4.feeEdgeGuard ?? null,
                        tpSource: bResult.phase4.tpSource ?? null,
                        tpLadder: bResult.phase4.tpLadder ?? null,
                            rejectedTpSource: bResult.phase4.rejectedTpSource ?? null
                        } : null
                    } : null,
                    compatLegacyKeysEnabled: legacyKeysEnabled,
                    diagnostics: {
                        blockerCategory,
                        reason: bReason,
                        rawReason: reasonRawTrace,
                        rawReasonSource: reasonRawSourceTrace,
                        decidedSide: phase4?.decidedSide ?? null,
                        aPositionRatio: Number.isFinite(Number(aGateDiag?.positionRatio)) ? Number(aGateDiag.positionRatio) : null,
                        aGateCode: aGateDiag?.code ?? null,
                        aReadiness: {
                            lrcAReady: aGateDiag?.lrcAReady ?? null,
                            lrcTvReady: aGateDiag?.lrcTvReady ?? null,
                            depthReady: aGateDiag?.depthReady ?? null,
                            bar1hReady
                        },
                        flow: {
                            windowMs: flowGateDiag?.windowMs ?? null,
                            tradeCount: flowGateDiag?.tradeCount ?? flowState?.tradeCount ?? null,
                            flowPressure: Number.isFinite(Number(flowGateDiag?.flowPressure))
                                ? Number(flowGateDiag.flowPressure)
                                : (Number.isFinite(Number(flowState?.flowPressure)) ? Number(flowState.flowPressure) : null),
                            hostileThreshold: Number.isFinite(Number(flowGateDiag?.hostileThreshold))
                                ? Number(flowGateDiag.hostileThreshold)
                                : null
                        },
                        executionQuality: execDiag ? {
                            entryQualityScore: execDiag.entryQualityScore ?? null,
                            edgeScore: execDiag.edgeScore ?? null,
                            spreadScore: execDiag.spreadScore ?? null,
                            velocityScore: execDiag.velocityScore ?? null,
                            shockScore: execDiag.shockScore ?? null,
                            rawEntryQualityScore: rawEntryQualityScoreTrace,
                            entryWeight: entryWeightTrace,
                            effectiveEntryQualityScore: effectiveEntryQualityScoreTrace,
                            channelT: derivedChannelT,
                            minEntryQuality: minEntryQualityTrace,
                            scoreDelta: scoreDeltaTrace
                        } : (executionQualityDiag ? {
                            entryQualityScore: entryQualityScoreTrace,
                            edgeScore: null,
                            spreadScore: null,
                            velocityScore: null,
                            shockScore: null,
                            rawEntryQualityScore: rawEntryQualityScoreTrace,
                            entryWeight: entryWeightTrace,
                            effectiveEntryQualityScore: effectiveEntryQualityScoreTrace,
                            channelT: Number.isFinite(Number(executionQualityDiag?.channelT))
                                ? Number(executionQualityDiag.channelT)
                                : derivedChannelT,
                            minEntryQuality: minEntryQualityTrace,
                            scoreDelta: scoreDeltaTrace
                        } : null),
                        feeEdge: feeDiag ? {
                            estimatedGrossUsd: feeDiag.estimatedGrossUsd ?? null,
                            estimatedFeeUsd: feeDiag.estimatedFeeUsd ?? null,
                            estimatedNetUsd: feeDiag.estimatedNetUsd ?? null,
                            minNetUsd: feeDiag.minNetUsd ?? null,
                            estimatedNetPer100: feeDiag.estimatedNetPer100 ?? null,
                            minNetPer100: feeDiag.minNetPer100 ?? null
                        } : null
                    },
                    metaGate: metaGate ? {
                        allow: metaGate.allow ?? null,
                        reason: metaGate.reason ?? null,
                        score: metaGate.score ?? null,
                        diagnostics: metaGate.diagnostics ?? null
                    } : null,
                    marketMicro: {
                        spreadBps,
                        velocityBps,
                        cShock
                    },
                depthSR: depthSR ? {
                    ready: depthSR.ready ?? null,
                    supportCenter: depthSR.supportCenter ?? null,
                    resistanceCenter: depthSR.resistanceCenter ?? null,
                    asymmetryRatio: depthSR.asymmetryRatio ?? null,
                    srAgg: depthSR.srAgg ?? null,  // 集計SR診断情報
                    srDiag: depthSR.srDiag ?? null,  // Phase A: 帯診断（落とし理由）
                    srScale: depthSR.srScale ?? null
                    } : null,
                    // Phase 3: StructureSnapshot 情報をログに追加
                    structureSnapshot: currentStructureSnapshot ? {
                        version: currentStructureSnapshot.version ?? null,
                        snapshotSeq: currentStructureSnapshot.snapshotSeq ?? null,
                        hash: currentStructureSnapshot.hash ?? null,
                        basis: currentStructureSnapshot.basis ?? null,
                        structureSource: currentStructureSnapshot.structureSource ?? null,
                        structureQuality: currentStructureSnapshot.structureQuality ?? null,
                        spanUsd: currentStructureSnapshot.spanUsd ?? null,
                        channelSlope: currentStructureSnapshot?._legacy?.channelSlope ?? null,
                        rails: currentStructureSnapshot.rails ?? null,
                        createdAt: currentStructureSnapshot.createdAt ?? null
                    } : null,
                    bar1h: ioMetrics?.bar1hState ?? null,
                    bar15m: ioMetrics?.bar15mState ?? null,
                    b15mWidthDiag: {
                        b15mWideUsd,
                        source: b15mWideSource,
                        lrcTvWidthUsd,
                        bar15mWidthUsd
                    },
                    mid
                },
                exitContext  // ← Priority 1: exit 判定時のコンテキスト情報
            }
        };
        writeLog(tracePayload);
        setDecisionTraceSnapshot(tracePayload.payload);
    }
    catch (err) {
        logLogicError('emitDecisionTrace', err);
    }
}

function classifyB1StructureBlock(payload, aResult, b0Snapshot, tradeConfig) {
    const ioMetrics = payload?.ioMetrics ?? {};
    const mid = Number(payload?.market?.midPx ?? payload?.marketState?.current?.midPx ?? NaN);
    if (!Number.isFinite(mid) || mid <= 0) {
        return { code: 'NO_MID', reason: 'mid unavailable' };
    }

    const aTop = Number(aResult?.arena?.channelTop);
    const aBottom = Number(aResult?.arena?.channelBottom);
    if (!Number.isFinite(aTop) || !Number.isFinite(aBottom) || aTop <= aBottom) {
        return { code: 'NO_A_ARENA', reason: 'A arena unavailable' };
    }

    const b15m = ioMetrics?.lrcTvState ?? {};
    if (b15m?.ready !== true) {
        return { code: 'B15M_NOT_READY', reason: '15m channel not ready' };
    }

    const bTop = Number(b15m?.channelTop);
    const bBottom = Number(b15m?.channelBottom);
    if (!Number.isFinite(bTop) || !Number.isFinite(bBottom) || bTop <= bBottom) {
        return { code: 'B15M_INVALID_CHANNEL', reason: '15m channel invalid' };
    }

    const overlapTop = Math.min(aTop, bTop);
    const overlapBottom = Math.max(aBottom, bBottom);
    const overlapWidth = Math.max(0, overlapTop - overlapBottom);
    const bWidth = bTop - bBottom;
    const inclusionRatio = bWidth > 0 ? overlapWidth / bWidth : 0;
    const minInclusionRatio = Math.max(0.1, Math.min(1.0, Number(tradeConfig?.b2Upgrade?.containmentGate?.minInclusionRatio ?? 0.7)));
    if (inclusionRatio < minInclusionRatio) {
        return {
            code: 'CONTAINMENT_LOW',
            reason: '15m channel not contained in A arena',
            inclusionRatio,
            minInclusionRatio
        };
    }

    if (ioMetrics?.depthSR?.ready !== true) {
        return { code: 'DEPTH_NOT_READY', reason: 'depth SR not ready' };
    }

    const supportCenter = Number(ioMetrics?.depthSR?.supportCenter);
    const resistanceCenter = Number(ioMetrics?.depthSR?.resistanceCenter);
    if (Number.isFinite(supportCenter) && Number.isFinite(resistanceCenter) && resistanceCenter > supportCenter) {
        const lrcTvTop = Number(ioMetrics?.lrcTvState?.channelTop);
        const lrcTvBottom = Number(ioMetrics?.lrcTvState?.channelBottom);
        const b15mWidth = (Number.isFinite(lrcTvTop) && Number.isFinite(lrcTvBottom) && lrcTvTop > lrcTvBottom)
            ? (lrcTvTop - lrcTvBottom)
            : null;
        const b1Cfg = tradeConfig?.b1?.structureRecognition ?? {};
        const fixedMin = Math.max(0, Number(b1Cfg.minDepthSpanUsd ?? 100));
        const ratio = Math.max(0, Number(b1Cfg.minDepthSpanRatioOfB15m ?? 0.03));
        const capUsd = Math.max(fixedMin, Number(b1Cfg.minDepthSpanCapUsd ?? 220));
        const minDepthSpanUsd = Number.isFinite(b15mWidth) && b15mWidth > 0
            ? Math.min(capUsd, Math.max(fixedMin, b15mWidth * ratio))
            : fixedMin;
        const depthSpanUsd = resistanceCenter - supportCenter;
        if (depthSpanUsd < minDepthSpanUsd) {
            return {
                code: 'DEPTH_SPAN_TOO_NARROW',
                reason: 'depth SR span below dynamic threshold',
                depthSpanUsd,
                minDepthSpanUsd
            };
        }
    }

    const b0Candidates = Array.isArray(b0Snapshot?.candidates) ? b0Snapshot.candidates : [];
    if (b0Candidates.length < 2) {
        return { code: 'B0_CANDIDATES_LOW', reason: 'B0 candidates insufficient', b0CandidateCount: b0Candidates.length };
    }

    return {
        code: 'B1_UNKNOWN',
        reason: 'B1 structure not formed by rails/candidate validation',
        b0CandidateCount: b0Candidates.length
    };
}
const lastDecisionSnapshot = {
    side: null,
    size: null,
    reason: null,
    zone: null,
    safety: null
};
function shouldEmitDecision(side, size, reason, zone, safety) {
    if (lastDecisionSnapshot.side === side &&
        lastDecisionSnapshot.size === size &&
        lastDecisionSnapshot.reason === reason &&
        lastDecisionSnapshot.zone === zone &&
        lastDecisionSnapshot.safety === safety) {
        return false;
    }
    lastDecisionSnapshot.side = side;
    lastDecisionSnapshot.size = size;
    lastDecisionSnapshot.reason = reason;
    lastDecisionSnapshot.zone = zone;
    lastDecisionSnapshot.safety = safety;
    return true;
}
const SAFETY_HOLD_TICKS = 3;
const safetyHoldState = {
    value: null,
    hold: 0
};
function debounceSafety(nextSafety) {
    if (!safetyHoldState.value) {
        safetyHoldState.value = nextSafety;
        safetyHoldState.hold = SAFETY_HOLD_TICKS;
        return nextSafety;
    }
    if (nextSafety !== safetyHoldState.value) {
        if (safetyHoldState.hold > 0) {
            safetyHoldState.hold -= 1;
            return safetyHoldState.value;
        }
        safetyHoldState.value = nextSafety;
        safetyHoldState.hold = SAFETY_HOLD_TICKS;
        return nextSafety;
    }
    if (safetyHoldState.hold > 0) {
        safetyHoldState.hold -= 1;
    }
    return safetyHoldState.value;
}

// ─────────────────────────
// A Gate 診断ログ出力（rate limited）
// ─────────────────────────
function emitAGateDiag(aResult, payload) {
    try {
        const nowMs = payload?.timestamp;
        const { _gateDiag } = aResult;
        if (!_gateDiag) return; // 診断情報なければ無視
        
        const { code } = _gateDiag;
        if (!Number.isFinite(nowMs)) return;
        const shouldLog = code !== aGateState.lastReason 
            || (nowMs - aGateState.lastDiagLog) >= A_GATE_LOG_INTERVAL_MS;
        
        if (!shouldLog) return; // rate limited
        
        aGateState.lastReason = code;
        aGateState.lastDiagLog = nowMs;
        
        // 必須値の抽出
        const { ioMetrics, marketState, timestamp } = payload;
        const { lrcState, bar15mState } = ioMetrics || {};
        const marketCurrent = marketState?.current || {};
        const nowTime = nowMs;
        const lastMarketAtMs = Number.isFinite(timestamp) ? timestamp : nowTime;
        if (!Number.isFinite(nowTime) || !Number.isFinite(lastMarketAtMs)) return;
        const marketAgeMs = nowTime - lastMarketAtMs;
        const midPrice = marketCurrent.midPx 
            || bar15mState?.mid 
            || (bar15mState ? (bar15mState.high + bar15mState.low) / 2 : 0);
        
        const lrcReady = lrcState?.ready ? 1 : 0;
        const bar15mReady = bar15mState?.ready ? 1 : 0;
        const bar15mHigh = bar15mState?.high || 0;
        const bar15mLow = bar15mState?.low || 0;
        
        // 1行ログ
        const diag = `[A_GATE] reason=${code} ageMs=${marketAgeMs} lrcReady=${lrcReady} bar15mReady=${bar15mReady} mid=${formatNum(midPrice)} hi=${formatNum(bar15mHigh)} lo=${formatNum(bar15mLow)}`;
        console.warn(diag);
    } catch (err) {
        console.error('[A_GATE] emitAGateDiag failed', err);
    }
}

function resolveMidPx(payload) {
    const fromMarket = payload?.market?.midPx ?? null;
    if (typeof fromMarket === 'number' && Number.isFinite(fromMarket))
        return fromMarket;
    const fromState = payload?.marketState?.current?.midPx ?? null;
    return typeof fromState === 'number' && Number.isFinite(fromState) ? fromState : null;
}
function resolveOi(payload) {
    const fromMarket = payload?.market?.oi ?? null;
    if (typeof fromMarket === 'number' && Number.isFinite(fromMarket))
        return fromMarket;
    const fromState = payload?.marketState?.current?.oi ?? null;
    return typeof fromState === 'number' && Number.isFinite(fromState) ? fromState : null;
}
function resolveBestBid(payload) {
    const fromMarket = payload?.market?.bestBid ?? null;
    if (typeof fromMarket === 'number' && Number.isFinite(fromMarket))
        return fromMarket;
    const fromState = payload?.marketState?.current?.bestBidPx ?? null;
    return typeof fromState === 'number' && Number.isFinite(fromState) ? fromState : null;
}
function resolveBestAsk(payload) {
    const fromMarket = payload?.market?.bestAsk ?? null;
    if (typeof fromMarket === 'number' && Number.isFinite(fromMarket))
        return fromMarket;
    const fromState = payload?.marketState?.current?.bestAskPx ?? null;
    return typeof fromState === 'number' && Number.isFinite(fromState) ? fromState : null;
}
function resolveOpenPositionSide(payload) {
    const direct = payload?.openPosition?.side ?? null;
    const fromState = payload?.engineState?.openPosition?.side ?? null;
    const fromMarketState = payload?.marketState?.current?.openPosition?.side ?? null;
    const fromRootState = payload?.state?.openPosition?.side ?? null;
    const side = direct ?? fromState ?? fromMarketState ?? fromRootState ?? null;
    if (side === 'buy' || side === 'sell')
        return side;
    return null;
}
function isSameSide(openSide, decisionSide) {
    if (!openSide || !decisionSide)
        return false;
    return openSide === decisionSide;
}
function formatBandId(band) {
    if (!band || !Number.isFinite(band.binId))
        return 'NA';
    return String(band.binId);
}
const LOGIC_LOG_PATH = path.resolve(process.cwd(), 'logs', 'logic.log');
function logAnchorDecision(audit) {
    try {
        fs.mkdirSync(path.dirname(LOGIC_LOG_PATH), { recursive: true });
        const record = {
            ts: audit.ts ?? audit.timestamp ?? null,
            logic: audit.logic ?? 'A',
            channelUpper: audit.channelUpper ?? null,
            channelLower: audit.channelLower ?? null,
            trend: audit.trend ?? null,
            requiredSide: audit.requiredSide ?? null,
            candidateCount: audit.candidateCount ?? null,
            anchorPrice: audit.anchorPrice ?? null,
            anchorDepth: audit.anchorDepth ?? null,
            anchorDistance: audit.anchorDistance ?? null,
            anchorSide: audit.anchorSide ?? null,
            anchorDepthRank: audit.anchorDepthRank ?? null,
            anchorDistanceRank: audit.anchorDistanceRank ?? null,
            chosenReason: audit.chosenReason ?? null,
            entryAnchorPrice: audit.entryAnchorPrice ?? null,
            entryAnchorDepth: audit.entryAnchorDepth ?? null,
            entryAnchorDistance: audit.entryAnchorDistance ?? null,
            entryAnchorSide: audit.entryAnchorSide ?? null,
            entryAnchorDepthRank: audit.entryAnchorDepthRank ?? null,
            entryAnchorDistanceRank: audit.entryAnchorDistanceRank ?? null,
            entryChosenReason: audit.entryChosenReason ?? null,
            exitAnchorPrice: audit.exitAnchorPrice ?? null,
            exitAnchorDepth: audit.exitAnchorDepth ?? null,
            exitAnchorDistance: audit.exitAnchorDistance ?? null,
            exitAnchorSide: audit.exitAnchorSide ?? null,
            exitAnchorDepthRank: audit.exitAnchorDepthRank ?? null,
            exitAnchorDistanceRank: audit.exitAnchorDistanceRank ?? null,
            exitChosenReason: audit.exitChosenReason ?? null,
            anchorDistance: audit.anchorDistance ?? null,
            anchorMaxDistance: audit.anchorMaxDistance ?? null,
            channelWidth: audit.channelWidth ?? null,
            distanceRatioA: audit.distanceRatioA ?? null,
            reason: audit.reason ?? null
        };
        if (audit.rejectReasons) {
            record.rejectReasons = audit.rejectReasons;
        }
        fs.appendFileSync(LOGIC_LOG_PATH, `[LOGIC_ANCHOR] ${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    }
    catch (_) {
        // NOTE: debugログ追加のみ。ロジック挙動は変更しない。
    }
}
function logExpectancySkip(audit) {
    try {
        fs.mkdirSync(path.dirname(LOGIC_LOG_PATH), { recursive: true });
        const extra = formatAuditExtras({
            plannedExitBand: audit.plannedExitBand ?? null,
            plannedExitAnchorPrice: audit.plannedExitAnchorPrice ?? null,
            plannedExitAnchorDepth: audit.plannedExitAnchorDepth ?? null,
            plannedExitDistanceToBoundary: audit.plannedExitDistanceToBoundary ?? null,
            expectedUsdRaw: audit.expectedUsdRaw ?? null,
            plannedExitSource: audit.plannedExitSource ?? null,
            channelWidth: audit.channelWidth ?? null
        });
        const line = `[LOGIC_AUDIT] decision=none reason=skip_low_expectancy entry=${formatRaw(audit.entryPx)} plannedExit=${formatRaw(audit.plannedExitPx ?? null)} expectedUsd=${formatNum(audit.expectedUsd)} expectedUsdRaw=${formatNum(audit.expectedUsdRaw ?? null)} minExpectedUsd=${formatNum(audit.minExpectedUsd)} size=${formatSize(audit.size)} band=${audit.bandLabel ?? 'none'} trend=${audit.trend ?? 'unknown'}${extra}`;
        fs.appendFileSync(LOGIC_LOG_PATH, `${line}\n`, { encoding: 'utf8' });
    }
    catch (_) {
        // NOTE: debugログ追加のみ。ロジック挙動は変更しない。
    }
}
function logDistanceSkip(audit) {
    try {
        fs.mkdirSync(path.dirname(LOGIC_LOG_PATH), { recursive: true });
        const extra = formatAuditExtras({
            plannedExitBand: audit.plannedExitBand ?? null,
            plannedExitAnchorPrice: audit.plannedExitAnchorPrice ?? null,
            plannedExitAnchorDepth: audit.plannedExitAnchorDepth ?? null,
            plannedExitDistanceToBoundary: audit.plannedExitDistanceToBoundary ?? null,
            expectedUsdRaw: audit.expectedUsdRaw ?? null,
            plannedExitSource: audit.plannedExitSource ?? null,
            channelWidth: audit.channelWidth ?? null
        });
        const line = `[LOGIC_AUDIT] decision=none reason=skip_short_distance entry=${formatRaw(audit.entryPx)} plannedExit=${formatRaw(audit.plannedExitPx ?? null)} distanceUsd=${formatNum(audit.distanceUsd)} minBandDistanceUsd=${formatNum(audit.minBandDistanceUsd)}${extra}`;
        fs.appendFileSync(LOGIC_LOG_PATH, `${line}\n`, { encoding: 'utf8' });
    }
    catch (_) {
        // NOTE: debugログ追加のみ。ロジック挙動は変更しない。
    }
}
function logRangeSkip(audit) {
    try {
        fs.mkdirSync(path.dirname(LOGIC_LOG_PATH), { recursive: true });
        const line = `[LOGIC_AUDIT] decision=none reason=skip_range_too_small rangeUsd=${formatNum(audit.rangeUsd)} minRangeUsd=${formatNum(audit.minRangeUsd)} lookbackMin=${formatNum(audit.lookbackMin)}`;
        fs.appendFileSync(LOGIC_LOG_PATH, `${line}\n`, { encoding: 'utf8' });
    }
    catch (_) {
        // NOTE: debugログ追加のみ。ロジック挙動は変更しない。
    }
}
function shouldLogForAudit(reason) {
    if (!reason)
        return false;
    return reason.startsWith('A_lrc_') || reason.startsWith('B_lrc_') || reason.startsWith('B_scalp_') || reason.startsWith('B_anchor_') || reason === 'same_side_guard' || reason === 'same_side_guard_soft';
}
function resolveAccountEquity(payload) {
    const equity = payload?.accountEquity;
    return typeof equity === 'number' && Number.isFinite(equity) ? equity : null;
}
function resolveChannelUpper(lrcState) {
    const top = lrcState?.channelTop ?? null;
    return typeof top === 'number' && Number.isFinite(top) ? top : null;
}
function resolveChannelLower(lrcState) {
    const bottom = lrcState?.channelBottom ?? null;
    return typeof bottom === 'number' && Number.isFinite(bottom) ? bottom : null;
}
function getFirepowerFactor(lrcState, tradeConfig) {
    const normalized = typeof lrcState?.normalizedSlope === 'number' ? lrcState.normalizedSlope : null;
    // slopeThresholdsByLen から default を取得（len 不要）
    const thresholdsByLen = tradeConfig?.slopeThresholdsByLen || {};
    const thresholds = thresholdsByLen.default || { flat: 1.0, normal: 2.0 };
    const flat = Number(thresholds.flat ?? 1.0);
    const normal = Number(thresholds.normal ?? 2.0);
    const mid = flat + (normal - flat) / 2;
    // ← Ver3修正: micro tier 廃止、rank は weak/normal/STRONG の3段階のみ
    // normalized が null や flat 未満の場合は weak に丸める
    let rank = 'weak';  // ← デフォルトを micro から weak に変更
    if (normalized == null || !Number.isFinite(normalized)) {
        rank = 'weak';  // ← 計算失敗時は weak（0 ではなく 0.75）
    }
    else if (normalized < flat) {
        rank = 'weak';  // ← 弱い傾きも weak に統一
    }
    else if (normalized < mid) {
        rank = 'weak';
    }
    else if (normalized < normal) {
        rank = 'normal';
    }
    else {
        rank = 'STRONG';
    }
    const weakFallback = Number(tradeConfig?.firepower?.weak ?? 0.75);
    const factor = Number(tradeConfig?.firepower?.[rank] ?? weakFallback);
    return { rank, factor };
}
function resolveFirepower(lrcState, tradeConfig, isExtremeC) {
    const base = getFirepowerFactor(lrcState, tradeConfig);
    // ← Ver3修正: isExtremeC 時の micro 返却を削除（micro tier 廃止）
    // 代わりに weak を最小値として返す
    if (!isExtremeC)
        return base;
    // extreme c の場合も weak を返す（最小値は weak）
    const weakFactor = Number(tradeConfig?.firepower?.weak ?? 0.75);
    return { rank: 'weak', factor: weakFactor };
}
function formatNum(val) {
    if (typeof val !== 'number' || Number.isNaN(val))
        return 'NA';
    return val.toFixed(2);
}
function formatSize(val) {
    if (typeof val !== 'number' || Number.isNaN(val))
        return 'NA';
    return val.toFixed(4);
}
function formatAuditNum(val) {
    if (typeof val !== 'number' || !Number.isFinite(val))
        return 'NA';
    return val.toFixed(6);
}
function formatAuditExtras(extra) {
    if (!extra)
        return '';
    const parts = [];
    if (extra.plannedExitBand) {
        parts.push(`plannedExitBand=${extra.plannedExitBand}`);
    }
    if (Number.isFinite(extra.plannedExitAnchorPrice)) {
        parts.push(`plannedExitAnchorPrice=${formatRaw(extra.plannedExitAnchorPrice)}`);
    }
    if (Number.isFinite(extra.plannedExitAnchorDepth)) {
        parts.push(`plannedExitAnchorDepth=${formatNum(extra.plannedExitAnchorDepth)}`);
    }
    if (Number.isFinite(extra.plannedExitDistanceToBoundary)) {
        parts.push(`plannedExitDistanceToBoundary=${formatNum(extra.plannedExitDistanceToBoundary)}`);
    }
    if (Number.isFinite(extra.expectedUsdRaw)) {
        parts.push(`expectedUsdRaw=${formatNum(extra.expectedUsdRaw)}`);
    }
    if (Number.isFinite(extra.expectedUsdAfterFee)) {
        parts.push(`expectedUsdAfterFee=${formatNum(extra.expectedUsdAfterFee)}`);
    }
    if (Number.isFinite(extra.expectedUsdAfterClamp)) {
        parts.push(`expectedUsdAfterClamp=${formatNum(extra.expectedUsdAfterClamp)}`);
    }
    if (Number.isFinite(extra.finalExpectedUsd)) {
        parts.push(`finalExpectedUsd=${formatNum(extra.finalExpectedUsd)}`);
    }
    if (extra.plannedExitSource) {
        parts.push(`plannedExitSource=${extra.plannedExitSource}`);
    }
    if (Number.isFinite(extra.channelWidth)) {
        parts.push(`channelWidth=${formatNum(extra.channelWidth)}`);
    }
    if (typeof extra.sameSide === 'boolean') {
        parts.push(`sameSide=${extra.sameSide}`);
    }
    if (Number.isFinite(extra.sameSidePenalty)) {
        parts.push(`sameSidePenalty=${formatNum(extra.sameSidePenalty)}`);
    }
    if (Number.isFinite(extra.sizeBefore)) {
        parts.push(`sizeBefore=${formatSize(extra.sizeBefore)}`);
    }
    if (Number.isFinite(extra.sizeAfter)) {
        parts.push(`sizeAfter=${formatSize(extra.sizeAfter)}`);
    }
    return parts.length ? ` ${parts.join(' ')}` : '';
}
function extractRatioFromReason(reason) {
    if (!reason)
        return null;
    const match = reason.match(/ratio=([0-9.]+)/);
    if (!match)
        return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}
function resolveBandLabel(depthSR, bestBid, bestAsk, midPx) {
    if (!depthSR || !depthSR.ready)
        return 'awaiting';
    
    // 新形式対応
    const support = depthSR.supportCenter
        ? [depthSR.supportLower, depthSR.supportUpper]
        : null;
    const resistance = depthSR.resistanceCenter
        ? [depthSR.resistanceLower, depthSR.resistanceUpper]
        : null;
    
    // 旧形式対応（fallback）
    const supportFallback = depthSR.primarySupport?.priceRange;
    const resistanceFallback = depthSR.primaryResistance?.priceRange;
    
    const supportRange = support || supportFallback;
    const resistanceRange = resistance || resistanceFallback;
    
    const supportRef = Number.isFinite(bestBid) ? bestBid : midPx;
    const resistanceRef = Number.isFinite(bestAsk) ? bestAsk : midPx;
    
    const inSupport = Array.isArray(supportRange) &&
        Number.isFinite(supportRef) &&
        supportRef >= Math.min(...supportRange) &&
        supportRef <= Math.max(...supportRange);
    const inResistance = Array.isArray(resistanceRange) &&
        Number.isFinite(resistanceRef) &&
        resistanceRef >= Math.min(...resistanceRange) &&
        resistanceRef <= Math.max(...resistanceRange);
    
    if (inSupport) {
        return `support`;
    }
    if (inResistance) {
        return `resist`;
    }
    return 'range';
}
function resolveDepthReadyLabel(depthSR) {
    if (!depthSR || !depthSR.ready)
        return 'awaiting';
    
    // 新形式
    const newFormatCount = (depthSR.supportCenter ? 1 : 0) + (depthSR.resistanceCenter ? 1 : 0);
    
    // 旧形式（fallback）
    const supportCount = Array.isArray(depthSR.supportBands)
        ? depthSR.supportBands.length
        : 0;
    const resistanceCount = Array.isArray(depthSR.resistanceBands)
        ? depthSR.resistanceBands.length
        : 0;
    
    const totalCount = Math.max(newFormatCount, supportCount + resistanceCount);
    
    return `depth_${totalCount}`;
}
function resolveMinBandDistanceUsd(tradeConfig) {
    const raw = Number(tradeConfig?.minBandDistanceUsd ?? 0);
    if (!Number.isFinite(raw))
        return 0;
    return Math.max(0, raw);
}
function resolveRangeFilter(tradeConfig) {
    const filter = tradeConfig?.rangeFilter ?? {};
    const lookbackMin = Number(filter.lookbackMin ?? 0);
    const minRangeUsd = Number(filter.minRangeUsd ?? 0);
    const lookbackClamped = Number.isFinite(lookbackMin) && lookbackMin > 0 ? Math.floor(lookbackMin) : 0;
    const minRangeClamped = Number.isFinite(minRangeUsd) && minRangeUsd > 0 ? minRangeUsd : 0;
    const windowMs = lookbackClamped > 0 ? lookbackClamped * 60 * 1000 : 0;
    return {
        lookbackMin: lookbackClamped,
        minRangeUsd: minRangeClamped,
        windowMs,
        enabled: windowMs > 0 && minRangeClamped > 0
    };
}
function formatRaw(val) {
    if (typeof val !== 'number' || Number.isNaN(val))
        return 'NA';
    return String(val);
}
function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}
function shortenReason(reason) {
    if (!reason)
        return 'NA';
    if (reason === 'A: data not ready')
        return 'A_NOT_READY';
    if (reason === 'A: bar1h not ready')
        return 'A_NOT_READY_BAR1H';
    if (reason === 'A: mid chop zone')
        return 'A_MID_CHOP';
    if (reason === 'A: no valid c')
        return 'A_NO_C';
    if (reason.startsWith('A_logic_bottom'))
        return 'A_bottom';
    if (reason.startsWith('A_logic_top'))
        return 'A_top';
    if (reason.startsWith('B_logic_mid_revert_up'))
        return 'B_mid_up';
    if (reason.startsWith('B_logic_mid_revert_down'))
        return 'B_mid_down';
    if (reason === 'safety_mid_chop')
        return 'S_mid';
    if (reason === 'safety_extreme_c')
        return 'S_extreme';
    if (reason === STOP_REASONS.SKIP_NO_LRC)
        return 'SKIP_LRC';
    if (reason === STOP_REASONS.SKIP_NO_DEPTH)
        return 'SKIP_DEPTH';
    if (reason === STOP_REASONS.SKIP_NO_EQUITY)
        return 'SKIP_EQUITY';
    if (reason === STOP_REASONS.SKIP_NO_PRICE)
        return 'SKIP_PRICE';
    if (reason === STOP_REASONS.SKIP_NO_CHANNEL)
        return 'SKIP_CHANNEL';
    if (reason === 'no_logic_match')
        return 'NONE';
    return reason.split(' ')[0];
}

// Phase 3: ポジション状態を判定（snapshot保持ルール用）
function resolvePositionStatus(payload) {
    if (payload?.engineState?.openPosition) return 'open';
    if (payload?.openPosition) return 'open';
    const stateStore = payload?.stateStore;
    const positions = stateStore?.positions ?? [];
    return positions && positions.length > 0 ? 'open' : 'closed';
}
