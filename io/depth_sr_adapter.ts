/**
 * io/depth_sr_adapter.ts
 *
 * DepthSR Adapter - Phase 1.5 ENTRY Bridge
 *
 * 役割：
 *   depth_v2 の DepthSR 出力を
 *   decision_b が解釈可能な SR 構造へ変換する最小ブリッジ
 *
 * 設計意図：
 *   - 本 Adapter は「ENTER を発生させるための最小ブリッジ」
 *   - SR の精度・強度・多層構造は Phase 2 以降で扱う
 *   - depth_v2 は変更しない（責務分離）
 */
/**
 * depth_v2 出力 → decision_b 形式への変換
 *
 * @param depthSRv2 - depth_v2 からの DepthSR
 * @returns decision_b が解釈可能な DepthSR 構造
 */
export function adaptDepthSRForB(depthSRv2) {
    if (!depthSRv2) {
        return {
            primarySupport: null,
            primaryResistance: null,
            supportBands: [],
            resistanceBands: [],
            supportCenter: null,
            supportWidth: null,
            supportLower: null,
            supportUpper: null,
            resistanceCenter: null,
            resistanceWidth: null,
            resistanceLower: null,
            resistanceUpper: null,
            ready: false,
            srAgg: null,
            srDiag: null,
        };
    }

    // Primary Support/Resistance を生成（lower/upper から）
    const primarySupport = Number.isFinite(depthSRv2.supportLower) && Number.isFinite(depthSRv2.supportUpper)
        ? { priceRange: [depthSRv2.supportLower, depthSRv2.supportUpper] }
        : null;
    const primaryResistance = Number.isFinite(depthSRv2.resistanceLower) && Number.isFinite(depthSRv2.resistanceUpper)
        ? { priceRange: [depthSRv2.resistanceLower, depthSRv2.resistanceUpper] }
        : null;

    // Ready 継承ルール: adapter.ready = depthSR.ready
    // 例外（null検出）は「契約違反」としてログに記録
    const adapterReady = depthSRv2.ready;

    // Pure format conversion（入力をそのまま渡す）
    return {
        primarySupport,
        primaryResistance,
        supportBands: [],
        resistanceBands: [],
        supportCenter: depthSRv2.supportCenter ?? null,
        supportWidth: depthSRv2.supportWidth ?? null,
        supportLower: depthSRv2.supportLower ?? null,
        supportUpper: depthSRv2.supportUpper ?? null,
        resistanceCenter: depthSRv2.resistanceCenter ?? null,
        resistanceWidth: depthSRv2.resistanceWidth ?? null,
        resistanceLower: depthSRv2.resistanceLower ?? null,
        resistanceUpper: depthSRv2.resistanceUpper ?? null,
        ready: adapterReady,
        srAgg: depthSRv2?.srAgg ?? null,
        srDiag: depthSRv2?.srDiag ?? null,
    };
}
