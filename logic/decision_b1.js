/**
 * logic/decision_b1.js
 * 
 * B ロジック層1（b1）: 構造選定モジュール
 * Ver3 実装版
 * 
 * 責務:
 * - depthSR から有力な SR 群を選定（最大6本、偶数原則）
 * - 上下レール（rails）を決定
 * - StructureSnapshot を生成（version/hash含む）
 * - 構造固定性を維持（positionOpen中は再生成しない）
 * 
 * 呼び出し元: logic/index.js (A.allow=true時 + exit時)
 * 呼び出し先: なし（純粋な計算関数）
 * 
 * 依存: depthSR, lrc, arena, bar1h, config
 */

import crypto from 'crypto';
import { getTradeConfig } from '../config/trade.js';

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveBarRange(state) {
  const high = toNumber(state?.high);
  const low = toNumber(state?.low);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return null;
  }
  return { high, low, span: high - low };
}

function resolveChannelRange(state) {
  const top = toNumber(state?.channelTop);
  const bottom = toNumber(state?.channelBottom);
  if (Number.isFinite(top) && Number.isFinite(bottom) && top > bottom) {
    return { high: top, low: bottom, span: top - bottom };
  }
  return null;
}

function resolveBArenaRange(aResult) {
  const topA = toNumber(aResult?.arena?.channelTop);
  const bottomA = toNumber(aResult?.arena?.channelBottom);
  if (Number.isFinite(topA) && Number.isFinite(bottomA) && topA > bottomA) {
    return { high: topA, low: bottomA, span: topA - bottomA, source: 'a_arena_1h' };
  }
  return null;
}

function resolveMinDepthSpanUsd(ioMetrics, tradeConfig = getTradeConfig()) {
  const cfg = tradeConfig?.b1?.structureRecognition ?? {};
  const fixedMin = Math.max(0, Number(cfg.minDepthSpanUsd ?? 100));
  const ratio = Math.max(0, Number(cfg.minDepthSpanRatioOfB15m ?? 0.03));
  const capUsd = Math.max(fixedMin, Number(cfg.minDepthSpanCapUsd ?? 220));

  const lrcTvTop = toNumber(ioMetrics?.lrcTvState?.channelTop);
  const lrcTvBottom = toNumber(ioMetrics?.lrcTvState?.channelBottom);
  const b15mWidth = (Number.isFinite(lrcTvTop) && Number.isFinite(lrcTvBottom) && lrcTvTop > lrcTvBottom)
    ? (lrcTvTop - lrcTvBottom)
    : null;

  if (!Number.isFinite(b15mWidth) || b15mWidth <= 0) {
    return fixedMin;
  }

  const dynamicMin = Math.max(fixedMin, b15mWidth * ratio);
  return Math.min(capUsd, dynamicMin);
}

function filterCandidatesByRange(candidates, range, bufferUsd = 0) {
  if (!Array.isArray(candidates) || !range) return candidates ?? [];
  const buffer = Math.max(0, Number(bufferUsd ?? 0));
  const low = range.low - buffer;
  const high = range.high + buffer;
  return candidates.filter(c => Number.isFinite(c?.price) && c.price >= low && c.price <= high);
}

function normalizeCandidate(candidate) {
  const price = toNumber(candidate?.price);
  const typeRaw = String(candidate?.type ?? '').toLowerCase();
  const type = typeRaw === 'support' || typeRaw === 'resistance' ? typeRaw : null;
  if (!Number.isFinite(price) || !type) return null;
  return {
    price,
    type,
    thickness: Math.max(0, Number(candidate?.thickness ?? 0)),
    notionalUsd: Math.max(0, Number(candidate?.notionalUsd ?? 0)),
  };
}

function computeOverlapRatio(channelRange, arenaRange) {
  if (!channelRange || !arenaRange) return null;
  const channelWidth = channelRange.high - channelRange.low;
  if (!Number.isFinite(channelWidth) || channelWidth <= 0) return null;
  const overlapLow = Math.max(channelRange.low, arenaRange.low);
  const overlapHigh = Math.min(channelRange.high, arenaRange.high);
  const overlapWidth = Math.max(0, overlapHigh - overlapLow);
  return overlapWidth / channelWidth;
}

/**
 * StructureSnapshot 生成メイン関数
 * 
 * @param {Object} payload - IOパケット
 * @param {Object} aResult - A判定結果（allow/reason/gateInfo）
 * @returns {Object|null} StructureSnapshot or null
 */
function generateStructure(payload, aResult, b0Result = null) {
  // Note: A.allow チェックは logic/index.js で実施済み（二重チェック不要）
  //       この関数は A.allow=true の時のみ呼ばれる

  const { ioMetrics = {}, market = {} } = payload;
  const lrcTvState = ioMetrics?.lrcTvState ?? {};
  const mid = market?.midPx ?? null;
  const tradeConfig = getTradeConfig();
  const b1Cfg = tradeConfig?.b1 ?? {};
  const minOverlapRatio = clamp(Number(b1Cfg?.minOverlapRatio ?? 0.7), 0, 1);

  // ガード: mid が null なら生成しない
  if (!Number.isFinite(mid)) {
    return null;
  }

  const bChannelRange = resolveChannelRange(lrcTvState);
  if (!bChannelRange) {
    return null;
  }
  const bChannelSlope = toNumber(lrcTvState?.slope);
  const aArena = aResult?.arena ?? null;
  const aArenaRange = resolveBArenaRange(aResult);
  const bArenaRange = aArenaRange ?? bChannelRange;
  const useAArena = !!aArenaRange;

  const overlapRatio = useAArena ? computeOverlapRatio(bChannelRange, bArenaRange) : 1;
  if (useAArena && (!Number.isFinite(overlapRatio) || overlapRatio < minOverlapRatio)) {
    return null;
  }

  const rails = {
    upper: bChannelRange.high,
    lower: bChannelRange.low,
  };
  if (!Number.isFinite(rails.upper) || !Number.isFinite(rails.lower) || rails.upper <= rails.lower) {
    return null;
  }

  // ステップ4: StructureSnapshot を生成
  const snapshot = {
    // 構造の根拠
    basis: 'b1_overlap',
    structureSource: 'lrc_tv_overlap',
    structureQuality: 1,

    // 上下のレール（TPターゲット）
    rails: {
      upper: rails.upper,
      lower: rails.lower,
    },

    // SRはB2専用。B1では候補を保持しない
    candidates: [],

    // 上下レール間の概算距離
    spanUsd: rails.upper - rails.lower,

    // 生成時刻（UNIX timestamp ms）
    createdAt: Date.now(),

    // 同一構造の識別子
    version: 1,
    hash: null,  // 後で計算

    // Ver2互換情報（診断用）
    _legacy: {
      regime: aResult?.regime ?? 'NONE',
      basis: 'b1_overlap',
      b0Source: b0Result?.source ?? null,
      candidateCount: 0,
      overlapRatio,
      minOverlapRatio,
      pass: true,
      arenaSource: useAArena ? 'a_arena_1h' : 'b_channel_fallback',
      channelUpper: bChannelRange.high,
      channelLower: bChannelRange.low,
      channelSlope: bChannelSlope,
    },
  };

  // hash を計算
  snapshot.hash = computeStructureHash(snapshot.rails, snapshot.candidates);

  return snapshot;
}

/**
 * 構造認識: 4条件の評価
 * 
 * 重要: SR本数は評価軸ではない（Part 6.7）。
 * 0本（チャネルのみ）/ 1本（SR+EDGE）/ 2本以上（SR群）すべてが正規。
 * 
 * この関数は depthSR 自体が上下の構造を持っているかを判定。
 * candidates の本数は評価しない。
 * 候補が少ない場合は calculateRails で arena/チャネルから補完。
 * 
 * @returns {boolean} 上下の SR 構造が存在するか
 */
function evaluateStructureRecognition(candidates, depthSR, mid, regime, options = {}) {
  if (!depthSR) {
    return false;
  }

  // 新形式: supportCenter/resistanceCenter を優先
  let topSupport, topResistance;
  if (Number.isFinite(depthSR.supportCenter) && Number.isFinite(depthSR.resistanceCenter)) {
    topSupport = depthSR.supportCenter;
    topResistance = depthSR.resistanceCenter;
  } else {
    // 後方互換: 古い形式の配列を確認
    const supportBands = depthSR.support ?? [];
    const resistanceBands = depthSR.resistance ?? [];

    if (supportBands.length === 0 || resistanceBands.length === 0) {
      return false;
    }

    topSupport = supportBands[0];
    topResistance = resistanceBands[0];
  }

  // 条件1: 単発反応ではない（反復性）
  // → support と resistance の両方が存在するか
  if (!Number.isFinite(topSupport) || !Number.isFinite(topResistance)) {
    return false;
  }

  // 条件2: 上下広がりがある（分離度）
  // → support と resistance が十分に離れているか（少なくとも100USD）
  const minDepthSpanUsd = Math.max(1, Number(options?.minDepthSpanUsd ?? 100));
  if (topResistance - topSupport < minDepthSpanUsd) {
    return false;  // レンジが狭すぎる
  }

  // 条件4: 直近価格依存排除
  // → mid が支持線/抵抗線の直近5% 内にあってはいけない
  const rangeBetween = topResistance - topSupport;
  const minRelevantDistance = 0.05 * rangeBetween;
  if (minRelevantDistance > 0) {
    const distToSupport = Math.abs(mid - topSupport);
    const distToResistance = Math.abs(mid - topResistance);
    const distToNearest = Math.min(distToSupport, distToResistance);
    if (distToNearest < minRelevantDistance) {
      return false;  // 直近すぎる
    }
  }

  // 条件3: 往復が成立する形（Part 6.8）
  // 「depthSR の支持線・抵抗線の組合せで往復が想定できるか」
  // candidates の内容は評価しない（SR本数は結果であって評価軸ではない）
  // 候補が 0本でも depthSR 自体が上下を持っていれば、
  // チャネル or arena から補完可能 → pass
  
  // すべて満たした
  return true;
}

/**
 * SR群の有力候補を選定（最大6本）
 * 
 * 優先度:
 * 1. primary support/resistance（最新・最強）
 * 2. 過去の反応線（厚み・notional による）
 * 3. channel edges（fallback）
 * 
 * @param {Object} depthSR - depth SR state
 * @param {number} mid - 現在の mid price
 * @param {string} regime - UP/DOWN/RANGE
 * @param {number} maxCount - 最大数（デフォルト6）
 * @returns {Array<{price, type, thickness, notionalUsd}>}
 */
function selectSrCandidates(depthSR, mid, regime, maxCount = 6) {
  const candidates = [];

  // 新形式: supportCenter/resistanceCenter を優先
  if (Number.isFinite(depthSR.supportCenter)) {
    candidates.push({
      price: depthSR.supportCenter,
      type: 'support',
      thickness: depthSR.supportWidth ?? 0,
      notionalUsd: 0,  // 新形式では notional を計算しない
    });
  }

  if (Number.isFinite(depthSR.resistanceCenter)) {
    candidates.push({
      price: depthSR.resistanceCenter,
      type: 'resistance',
      thickness: depthSR.resistanceWidth ?? 0,
      notionalUsd: 0,
    });
  }

  // 後方互換：古い形式の配列が残っている場合も対応
  if (!candidates.length && (depthSR.support?.length || depthSR.resistance?.length)) {
    if (depthSR.support?.[0]) {
      candidates.push({
        price: depthSR.support[0],
        type: 'support',
        thickness: depthSR.supportThickness?.[0] ?? 0,
        notionalUsd: depthSR.supportNotional?.[0] ?? 0,
      });
    }

    if (depthSR.resistance?.[0]) {
      candidates.push({
        price: depthSR.resistance[0],
        type: 'resistance',
        thickness: depthSR.resistanceThickness?.[0] ?? 0,
        notionalUsd: depthSR.resistanceNotional?.[0] ?? 0,
      });
    }

    // 2nd, 3rd ... を追加
    const maxSecondary = maxCount - candidates.length;
    let supportIdx = 1;
    let resistanceIdx = 1;
    let added = 0;

    while (added < maxSecondary && (supportIdx < (depthSR.support?.length ?? 0) || resistanceIdx < (depthSR.resistance?.length ?? 0))) {
      if (supportIdx < (depthSR.support?.length ?? 0)) {
        candidates.push({
          price: depthSR.support[supportIdx],
          type: 'support',
          thickness: depthSR.supportThickness?.[supportIdx] ?? 0,
          notionalUsd: depthSR.supportNotional?.[supportIdx] ?? 0,
        });
        supportIdx++;
        added++;
      }

      if (added < maxSecondary && resistanceIdx < (depthSR.resistance?.length ?? 0)) {
        candidates.push({
          price: depthSR.resistance[resistanceIdx],
          type: 'resistance',
          thickness: depthSR.resistanceThickness?.[resistanceIdx] ?? 0,
          notionalUsd: depthSR.resistanceNotional?.[resistanceIdx] ?? 0,
        });
        resistanceIdx++;
        added++;
      }
    }
  }

  // price でソート
  candidates.sort((a, b) => a.price - b.price);

  return candidates.slice(0, maxCount);
}

/**
 * 上下レール（rails）を計算
 * 
 * ルール:
 * - SR群がある（2本以上）→ 最外周のS/R
 * - SR群がない（0本）→ null（フォールバック禁止）
 * - SR片側のみ（Sのみ/Rのみ）→ null（フォールバック禁止）
 * 
 * @returns {Object} { upper, lower }
 */
function calculateRails(candidates, lrc, mid, arena) {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  // support/resistance の分類
  const supports = candidates.filter(c => c.type === 'support').map(c => c.price);
  const resistances = candidates.filter(c => c.type === 'resistance').map(c => c.price);

  if (supports.length === 0 || resistances.length === 0) {
    return null;
  }

  // 上下レールの決定（フォールバックなし）
  const upper = Math.max(...resistances);
  const lower = Math.min(...supports);

  if (!Number.isFinite(upper) || !Number.isFinite(lower) || upper <= lower) {
    return null;
  }

  return { upper, lower };
}

/**
 * 構造の根拠を判定
 * - sr_group: support/resistance 両側がある
 * - none: それ以外（フォールバック禁止）
 * 
 * @returns {string} 'sr_group' | 'none'
 */
function resolveBasis(candidates) {
  if (!candidates || candidates.length === 0) {
    return 'none';
  }

  const supportCount = candidates.filter(c => c.type === 'support').length;
  const resistanceCount = candidates.filter(c => c.type === 'resistance').length;

  if (supportCount >= 1 && resistanceCount >= 1) {
    return 'sr_group';
  }

  return 'none';
}

/**
 * 構造のハッシュを計算
 * 同一構造 = 同一hash
 * 
 * @returns {string} SHA256 hex digest
 */
function computeStructureHash(rails, candidates) {
  const hashInput = JSON.stringify({
    rails,
    candidates: candidates.map(c => ({
      price: c.price,
      type: c.type,
    })),
  });

  return crypto
    .createHash('sha256')
    .update(hashInput)
    .digest('hex')
    .substring(0, 16);  // 短縮版（16文字）
}

/**
 * bar1h + arena からレジーム判定
 * 
 * @param {Object} bar1h - 1h barの状態
 * @param {Object} arena - arena state
 * @returns {string} 'UP' | 'DOWN' | 'RANGE'
 */
function resolveRegime(bar1h, arena) {
  if (!bar1h || !bar1h.ready) {
    return 'RANGE';  // デフォルト
  }

  if (!arena) {
    return 'RANGE';
  }

  // bar1h.mid vs arena.channelMid
  const mid1h = bar1h.mid ?? 0;
  const channelMid = ((arena.channelTop ?? 0) + (arena.channelBottom ?? 0)) / 2;

  if (channelMid === 0) {
    return 'RANGE';
  }

  if (mid1h > channelMid * 1.01) {
    return 'UP';
  }
  if (mid1h < channelMid * 0.99) {
    return 'DOWN';
  }

  return 'RANGE';
}

/**
 * StructureSnapshot のバリデーション
 * 型安全性・値の正当性を確認
 * 
 * @returns {boolean}
 */
function validateStructureSnapshot(snapshot) {
  if (!snapshot) return false;

  const required = ['basis', 'rails', 'candidates', 'spanUsd', 'createdAt', 'version', 'hash'];
  for (const key of required) {
    if (!(key in snapshot)) {
      return false;
    }
  }

  // rails の上下チェック
  if (!Number.isFinite(snapshot.rails.upper) || !Number.isFinite(snapshot.rails.lower) || snapshot.rails.upper <= snapshot.rails.lower) {
    return false;
  }

  // spanUsd の計算値確認
  if (Math.abs(snapshot.spanUsd - (snapshot.rails.upper - snapshot.rails.lower)) > 0.01) {
    return false;
  }

  // candidates の型チェック
  if (!Array.isArray(snapshot.candidates)) {
    return false;
  }

  return true;
}

// ===== exports =====
export {
  generateStructure,
  selectSrCandidates,
  calculateRails,
  evaluateStructureRecognition,
  computeStructureHash,
  resolveRegime,
  validateStructureSnapshot,
};
