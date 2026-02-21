// io/types.ts
// ExecutorPayload 型定義（I/O -> Executor に渡す最小・安全構造）

export type Firepower = {
  rank: string;
  factor: number;
  baseFactor?: number;
  directionalMultiplier?: number;
};

export type Strength = {
  A: number;
  B: number;
  firepower?: Firepower;
};

export type IOMetricDiffs = {
  midPx: number;
  oi: number;
  bestBid: number;
  bestAsk: number;
  lastTradePx: number;
};

export type IOMetrics = {
  cRaw: number | null;
  c: number | null;
  cPrev: number | null;
  zone: 'top' | 'mid' | 'bottom' | null;
  isNearTop: boolean;
  isNearBottom: boolean;
  lrcState: {
    ready: boolean;
    source: 'midPx' | 'lastTradePx' | null;
    len: number;
    devlen: number;
    k: number;
    epsilon: number | null;
    slope: number | null;
    normalizedSlope: number | null;
    trendState: 'up' | 'down' | 'flat' | 'unknown';
    channelMid: number | null;
    channelTop: number | null;
    channelBottom: number | null;
    dev: number | null;
    sampleCount: number;
  } | null;
  lrcTvState: {
    ready: boolean;
    source: 'bar15m' | null;
    len: number;
    devlen: number;
    k: number;
    epsilon: number | null;
    slope: number | null;
    normalizedSlope: number | null;
    trendState: 'up' | 'down' | 'flat' | 'unknown';
    channelMid: number | null;
    channelTop: number | null;
    channelBottom: number | null;
    dev: number | null;
    sampleCount: number;
  } | null;
  depthSR: {
  ready: boolean;
  reason: string | null;
  binPct: number;
  depthLevels: number;
  bidCount: number;
  askCount: number;
  supportBands: Array<{ binId: number; priceRange: [number, number]; weight: number }>;
  resistanceBands: Array<{ binId: number; priceRange: [number, number]; weight: number }>;
    primarySupport: { binId: number; priceRange: [number, number]; weight: number } | null;
    primaryResistance: { binId: number; priceRange: [number, number]; weight: number } | null;
  } | null;
  diffs: IOMetricDiffs;
};

export type MarketSnapshot = {
  midPx: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  oi: number | null;
  lastTradeSide: 'buy' | 'sell' | 'unknown' | null;
  lastTradePx: number | null;
};

export type ExecutorPayload = {
  timestamp: number;
  strength: Strength;
  ioMetrics: IOMetrics;
  market: MarketSnapshot;
  accountEquity?: number | null;
};
