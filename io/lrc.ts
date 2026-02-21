// io/lrc.ts
// LRC計算（I/O層の計測モジュール）
// 状態は内部バッファに保持。判断ロジックは持たない。
const history = [];
function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
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
function computeRegression(values) {
    const n = values.length;
    if (n === 0)
        return { slope: 0, intercept: 0 };
    const sumX = (n - 1) * n / 2;
    const sumX2 = (n - 1) * n * (2 * n - 1) / 6;
    let sumY = 0;
    let sumXY = 0;
    for (let i = 0; i < n; i++) {
        const y = values[i];
        sumY += y;
        sumXY += i * y;
    }
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY / n) - slope * ((n - 1) / 2);
    return { slope, intercept };
}
function computeDeviation(values, slope, intercept) {
    const n = values.length;
    if (n === 0)
        return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const expected = intercept + slope * i;
        const diff = values[i] - expected;
        sum += diff * diff;
    }
    return Math.sqrt(sum / n);
}
export function createLrcTracker(config) {
    const history = [];
    return {
        update(current) {
            // フェイルセーフ: slopeThresholds が無い場合は slopeThresholdsByLen.default を使用
            const thresholdsByLen = config?.slopeThresholdsByLen || {};
            const slopeThresholds = config?.slopeThresholds || thresholdsByLen.default || { flat: 1.0, normal: 2.0 };
            const midPx = toNumber(current?.midPx);
            const lastTradePx = toNumber(current?.lastTradePx);
            let source = null;
            let value = midPx;
            if (value != null) {
                source = 'midPx';
            }
            else if (lastTradePx != null) {
                value = lastTradePx;
                source = 'lastTradePx';
            }
            if (value == null) {
                return {
                    ready: false,
                    source: null,
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
                    sampleCount: history.length
                };
            }
            history.push(value);
            while (history.length > config.len)
                history.shift();
            if (history.length < config.len) {
                return {
                    ready: false,
                    source,
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
                    sampleCount: history.length
                };
            }
            const { slope, intercept } = computeRegression(history);
            const dev = computeDeviation(history, slope, intercept);
            const channelMid = intercept + slope * (config.len - 1);
            const channelTop = channelMid + dev * config.devlen;
            const channelBottom = channelMid - dev * config.devlen;
            const epsilon = config.k / config.len;
            const normalizedSlope = epsilon > 0 ? Math.abs(slope) / epsilon : null;
            let trendState = 'flat';
            if (normalizedSlope != null && normalizedSlope >= slopeThresholds.flat) {
                trendState = slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat';
            }
            return {
                ready: true,
                source,
                len: config.len,
                devlen: config.devlen,
                k: config.k,
                epsilon,
                slope,
                normalizedSlope,
                trendState,
                channelMid,
                channelTop,
                channelBottom,
                dev,
                sampleCount: history.length
            };
        },
    };
}
export function updateLrcState(current, config) {
    // フェイルセーフ: slopeThresholdsByLen から default を取得
    const thresholdsByLen = config.slopeThresholdsByLen || {};
    const slopeThresholds = thresholdsByLen.default ?? { flat: 1.0, normal: 2.0 };
    const safeConfig = { ...config, slopeThresholds };
    if (!safeConfig.len || safeConfig.len <= 0) {
        return {
            ready: false,
            source: null,
            len: safeConfig.len,
            devlen: safeConfig.devlen,
            k: safeConfig.k,
            epsilon: null,
            slope: null,
            normalizedSlope: null,
            trendState: 'unknown',
            channelMid: null,
            channelTop: null,
            channelBottom: null,
            dev: null,
            sampleCount: history.length
        };
    }
    
    const midPx = toNumber(current?.midPx);
    const lastTradePx = toNumber(current?.lastTradePx);
    let source = null;
    let value = midPx;
    if (value != null) {
        source = 'midPx';
    }
    else if (lastTradePx != null) {
        value = lastTradePx;
        source = 'lastTradePx';
    }
    if (value == null) {
        return {
            ready: false,
            source: null,
            len: safeConfig.len,
            devlen: safeConfig.devlen,
            k: safeConfig.k,
            epsilon: null,
            slope: null,
            normalizedSlope: null,
            trendState: 'unknown',
            channelMid: null,
            channelTop: null,
            channelBottom: null,
            dev: null,
            sampleCount: history.length
        };
    }
    history.push(value);
    while (history.length > safeConfig.len)
        history.shift();
    if (history.length < safeConfig.len) {
        return {
            ready: false,
            source,
            len: safeConfig.len,
            devlen: safeConfig.devlen,
            k: safeConfig.k,
            epsilon: null,
            slope: null,
            normalizedSlope: null,
            trendState: 'unknown',
            channelMid: null,
            channelTop: null,
            channelBottom: null,
            dev: null,
            sampleCount: history.length
        };
    }
    const { slope, intercept } = computeRegression(history);
    if (!isFiniteNumber(slope) || !isFiniteNumber(intercept)) {
        return {
            ready: false,
            source,
            len: safeConfig.len,
            devlen: safeConfig.devlen,
            k: safeConfig.k,
            epsilon: null,
            slope: null,
            normalizedSlope: null,
            trendState: 'unknown',
            channelMid: null,
            channelTop: null,
            channelBottom: null,
            dev: null,
            sampleCount: history.length
        };
    }
    const dev = computeDeviation(history, slope, intercept);
    if (!isFiniteNumber(dev)) {
        return {
            ready: false,
            source,
            len: safeConfig.len,
            devlen: safeConfig.devlen,
            k: safeConfig.k,
            epsilon: null,
            slope: null,
            normalizedSlope: null,
            trendState: 'unknown',
            channelMid: null,
            channelTop: null,
            channelBottom: null,
            dev: null,
            sampleCount: history.length
        };
    }
    const channelMid = intercept + slope * (safeConfig.len - 1);
    const channelTop = channelMid + dev * safeConfig.devlen;
    const channelBottom = channelMid - dev * safeConfig.devlen;
    if (!isFiniteNumber(channelMid) || !isFiniteNumber(channelTop) || !isFiniteNumber(channelBottom)) {
        return {
            ready: false,
            source,
            len: safeConfig.len,
            devlen: safeConfig.devlen,
            k: safeConfig.k,
            epsilon: null,
            slope: null,
            normalizedSlope: null,
            trendState: 'unknown',
            channelMid: null,
            channelTop: null,
            channelBottom: null,
            dev: null,
            sampleCount: history.length
        };
    }
    const epsilon = safeConfig.len > 0 ? safeConfig.k / safeConfig.len : null;
    const normalizedSlope = epsilon && epsilon > 0 && isFiniteNumber(slope)
        ? Math.abs(slope) / epsilon
        : null;
    let trendState = 'flat';
    if (normalizedSlope != null && isFiniteNumber(normalizedSlope) && normalizedSlope >= safeConfig.slopeThresholds.flat) {
        trendState = slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat';
    }
    return {
        ready: true,
        source,
        len: safeConfig.len,
        devlen: safeConfig.devlen,
        k: safeConfig.k,
        epsilon,
        slope,
        normalizedSlope,
        trendState,
        channelMid,
        channelTop,
        channelBottom,
        dev,
        sampleCount: history.length
    };
}
