// logic/types.ts
// Logic層の型定義（I/O → Logic → Executor の契約）

/**
 * AResult
 * A ロジック（状況定義エンジン）の出力型
 */
export interface AResult {
  regime: 'UP' | 'DOWN' | 'RANGE' | 'NONE';
  regimeLabel?: string;                    // ログ可視化用（例: WARMUP_RANGE）
  side: 'BUY' | 'SELL';                     // ← 新規（傾きの定義）
  zone: 'top' | 'middle' | 'bottom';        // ← 新規（エリア定義）
  trend_strength?: 'weak' | 'normal' | 'STRONG';  // ← 新規（B の firepower 参考値）
  arena?: { channelTop?: number; channelBottom?: number; mid?: number; valid?: boolean };
  allow: boolean;
  constraints: string[];
  reason: string;
  _gateDiag?: any;
}

/**
 * BResult
 * B ロジック（判断＆実行エンジン）の出力型
 */
export interface BResult {
  side: 'BUY' | 'SELL' | 'none';
  firepower?: number;                       // ← 新規（B が決定。デフォルト 1.0）
  reason: string;
  state?: string;
  midPrice?: number | null;
  supportPrice?: number | null;
  resistancePrice?: number | null;
  distToSupport?: number | null;
  distToResistance?: number | null;
  bandLower?: number | null;
  bandUpper?: number | null;
  structuralDistanceUsd?: number | null;
  structuralPairType?: string | null;
  distanceReason?: string | null;
  tpPx?: number | null;
  tpDistanceUsd?: number | null;
  expectedUsd?: number | null;
  notionalUsd?: number;
  source?: 'A' | 'B';
  size?: number;
}

/**
 * TradingDecisionPayload
 * Logic層の出力型（Executorへの入力）
 */
export interface TradingDecisionPayload {
  side: 'buy' | 'sell' | 'none';
  size: number;
  reason: string;
  logic?: 'A' | 'B';
  monitor?: {
    logic: 'A' | 'B';
    channelWidth?: number | null;
    anchorDistance?: number | null;
    minBandDistanceUsd?: number | null;
    plannedExitDistance?: number | null;
  };
}
