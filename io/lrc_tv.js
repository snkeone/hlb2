// io/lrc_tv.js
// LRC_TV: TV互換slope (linreg(src,len,0) - linreg(src,len,1))
// Phase 1: LRC_TV_NEW実装
// 入力: bar15m.close[] (close[0]最新、close[1..n]確定)
// 出力: {ready, source, len, slope, normalizedSlope, trendState, channelMid, channelTop, channelBottom, dev}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * TV Pine互換: linreg(src, length, offset)
 * offset=0: 現在値から過去length本分の線形回帰
 * offset=1: 1本前から過去length本分の線形回帰
 * TV slope = linreg(src,len,0) - linreg(src,len,1)
 * 
 * close[0]=最新、close[1]=1本前、...に対応
 * offset=0で17本（close[0..16]）必要
 * offset=1で17本（close[1..16]）= 16本で可能（close[0..15]の1本後）
 */
export function tvLinreg(values, length, offset) {
  if (!Array.isArray(values) || length <= 0) return null;
  // offset=0: values[0..length-1]を使う
  // offset=1: values[1..length]を使う (= 過去length本)
  const startIdx = offset;
  const endIdx = startIdx + length;
  
  // offset=1でlength=16の場合、close[1..16]=17要素必要
  // close[0..15]=16要素の場合、close[1..15]=15要素になる（不足）
  // 仕様修正：offset=1でも length本取る（close[1..length]）
  
  // データ不足判定
  if (values.length <= offset) return null; // offset以上のデータ必要
  if (endIdx > values.length) return null; // offset + length までのデータ必要
  
  const segment = values.slice(startIdx, endIdx);
  const n = segment.length;
  if (n < length) return null;

  // 非有限値を含む場合は無効
  if (segment.some(v => !isFiniteNumber(v))) return null;
  
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = segment[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return segment[n - 1]; // 傾き0、最後の値
  
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  
  // linregは最後の値での予測値を返す
  return intercept + slope * (n - 1);
}

/**
 * TV互換slope計算
 * slope = linreg(src,len,0) - linreg(src,len,1)
 * 
 * @param {number[]} values - close[]配列（[0]=最新）
 * @param {number} length - LRC長
 * @returns {number|null} TV互換slope
 */
function computeTvSlope(values, length) {
  // offset=0: close[0..length-1]
  // offset=1: close[1..length]
  // close[0..15]=16本の場合、offset=1は close[1..16]で17要素必要
  // close[0..16]=17本の場合、offset=0でlength=16、offset=1でlength=16両立
  
  const lr0 = tvLinreg(values, length, 0);
  
  // offset=1が成功するには、配列が length+1 以上必要
  const lr1 = values.length >= length + 1 ? tvLinreg(values, length, 1) : null;
  
  if (lr0 == null || lr1 == null) return null;
  
  return lr0 - lr1;
}

/**
 * OLS回帰による標準計算（偏差/チャネル用）
 */
function computeRegression(values) {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const sumX = (n - 1) * n / 2;
  const sumX2 = (n - 1) * n * (2 * n - 1) / 6;
  
  let sumY = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumY += values[i];
    sumXY += i * values[i];
  }
  
  const denom = n * sumX2 - sumX * sumX;
  // [A0-2] 0除算防止：denom=0時はslope=0
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY / n) - slope * ((n - 1) / 2);
  
  // 戻り値は常にfinite（NaN/Infinity排除）
  return { 
    slope: Number.isFinite(slope) ? slope : 0, 
    intercept: Number.isFinite(intercept) ? intercept : 0 
  };
}

function computeDeviation(values, slope, intercept) {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const expected = intercept + slope * i;
    const diff = values[i] - expected;
    sum += diff * diff;
  }
  // [A0-2] dev計算も常にfinite（NaN/Infinity排除）
  const dev = Math.sqrt(sum / n);
  return Number.isFinite(dev) ? dev : 0;
}

/**
 * LRC_TV状態を計算（bar15m.close[]入力）
 * close[0] = 最新（未確定）
 * close[1] = 1本前（確定）
 */
export function computeLrcTv(bar15mCloseArray, config) {
  // close[]をそのまま使用（reverse不要）
  const values = Array.isArray(bar15mCloseArray) ? bar15mCloseArray : [];
  const len = Number(config?.len) || 0;
  const devlen = Number(config?.devlen) || 0;
  const k = Number(config?.k) || 0;
  // slopeThresholdsByLen から default を取得
  const thresholdsByLen = config?.slopeThresholdsByLen || {};
  const slopeThresholds = thresholdsByLen.default || { flat: 1.0, normal: 2.0 };
  
  // データ不足判定（offset=1で length=16の場合、17本必要）
  if (!values || values.length < len + 1 || len <= 0) {
    return {
      ready: false,
      source: 'bar15m',
      len,
      devlen,
      k,
      epsilon: null,
      slope: null, // TV互換slope
      normalizedSlope: null,
      trendState: 'unknown',
      channelMid: null,
      channelTop: null,
      channelBottom: null,
      dev: null,
      sampleCount: values ? values.length : 0
    };
  }
  
  // TV互換slope計算: linreg(src,len,0) - linreg(src,len,1)
  const tvSlope = computeTvSlope(values, len);
  
  if (tvSlope == null) {
    return {
      ready: false,
      source: 'bar15m',
      len,
      devlen,
      k,
      epsilon: null,
      slope: null,
      normalizedSlope: null,
      trendState: 'unknown',
      channelMid: null,
      channelTop: null,
      channelBottom: null,
      dev: null,
      sampleCount: values.length
    };
  }
  
  // チャネル計算用：最初のconfig.len本を使用
  const segmentForChannel = values.slice(0, len);
  const { slope: olsSlope, intercept } = computeRegression(segmentForChannel);
  if (!isFiniteNumber(olsSlope) || !isFiniteNumber(intercept)) {
    return {
      ready: false,
      source: 'bar15m',
      len,
      devlen,
      k,
      epsilon: null,
      slope: null,
      normalizedSlope: null,
      trendState: 'unknown',
      channelMid: null,
      channelTop: null,
      channelBottom: null,
      dev: null,
      sampleCount: values.length
    };
  }
  const dev = computeDeviation(segmentForChannel, olsSlope, intercept);
  if (!isFiniteNumber(dev)) {
    return {
      ready: false,
      source: 'bar15m',
      len,
      devlen,
      k,
      epsilon: null,
      slope: null,
      normalizedSlope: null,
      trendState: 'unknown',
      channelMid: null,
      channelTop: null,
      channelBottom: null,
      dev: null,
      sampleCount: values.length
    };
  }
  
  // チャネルMid = intercept + olsSlope * (len - 1)（最後のindex）
  const channelMid = intercept + olsSlope * (len - 1);
  const channelTop = channelMid + dev * devlen;
  const channelBottom = channelMid - dev * devlen;
  if (!isFiniteNumber(channelMid) || !isFiniteNumber(channelTop) || !isFiniteNumber(channelBottom)) {
    return {
      ready: false,
      source: 'bar15m',
      len,
      devlen,
      k,
      epsilon: null,
      slope: null,
      normalizedSlope: null,
      trendState: 'unknown',
      channelMid: null,
      channelTop: null,
      channelBottom: null,
      dev: null,
      sampleCount: values.length
    };
  }
  
  // Trend判定（TV互換slopeで）
  const epsilon = len > 0 ? k / len : null;
  // [A0-2] normalizedSlope：epsilon>0 の場合のみ計算（0除算禁止）
  const normalizedSlope = epsilon != null && epsilon > 0 && isFiniteNumber(tvSlope)
    ? Math.abs(tvSlope) / epsilon
    : null;
  
  let trendState = 'flat';
  if (normalizedSlope != null && isFiniteNumber(normalizedSlope) && normalizedSlope >= slopeThresholds.flat) {
    trendState = tvSlope > 0 ? 'up' : tvSlope < 0 ? 'down' : 'flat';
  }
  
  return {
    ready: true,
    source: 'bar15m',
    len,
    devlen,
    k,
    epsilon,
    slope: tvSlope, // ★TV互換slope
    normalizedSlope,
    trendState,
    channelMid,
    channelTop,
    channelBottom,
    dev,
    sampleCount: values.length,
    // 自己検証用
    _tvLinreg0: tvLinreg(values, config.len, 0),
    _tvLinreg1: tvLinreg(values, config.len, 1),
    _olsSlope: olsSlope
  };
}

/**
 * LRC_TV Trackerクラス（bar15m連携）
 */
export class LrcTvTracker {
  constructor(config) {
    this.config = config;
    this.state = {
      ready: false,
      source: 'bar15m',
      len: config.len,
      devlen: config.devlen,
      k: config.k,
      epsilon: null,
      slope: null,
      normalizedSlope: null,
      trendState: 'unknown',
      channelMid: null,
      channelTop: null,
      channelBottom: null,
      dev: null,
      sampleCount: 0
    };
  }
  
  /**
   * bar15mオブジェクトから状態更新
   * @param {Object} bar15m - {bars: [{open,high,low,close}, ...], close: [latest, ...]}
   */
  updateFromBar15m(bar15m) {
    if (!bar15m || !bar15m.close) {
      return this.state;
    }
    
    this.state = computeLrcTv(bar15m.close, this.config);
    return this.state;
  }
  
  /**
   * closeArray から状態更新
   * @param {number[]} closeArray - close[0]=最新, close[1]=1本前, ...
   */
  updateFromCloseArray(closeArray) {
    if (!Array.isArray(closeArray) || closeArray.length === 0) {
      return this.state;
    }
    
    this.state = computeLrcTv(closeArray, this.config);
    return this.state;
  }
  
  getState() {
    return this.state;
  }
}

export default { computeLrcTv, LrcTvTracker, tvLinreg };
export function createLrcTvTracker(config) {
  return new LrcTvTracker(config);
}