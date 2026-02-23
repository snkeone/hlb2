function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSide(rawSide) {
  const side = String(rawSide ?? '').toLowerCase();
  if (side === 'buy' || side === 'b') return 'buy';
  if (side === 'sell' || side === 's' || side === 'a') return 'sell';
  return null;
}

function normalizeWindows(input) {
  if (!Array.isArray(input) || input.length === 0) return [5000, 30000, 60000];
  const uniq = Array.from(new Set(
    input
      .map(v => Math.max(1000, Math.floor(toFiniteNumber(v, 0))))
      .filter(v => Number.isFinite(v) && v > 0)
  ));
  if (uniq.length === 0) return [5000, 30000, 60000];
  uniq.sort((a, b) => a - b);
  return uniq;
}

function computeAcceleration(now, windowMs, samples) {
  const halfMs = Math.max(1000, Math.floor(windowMs / 2));
  const recentCutoff = now - halfMs;
  const prevCutoff = now - (halfMs * 2);
  let recentVolume = 0;
  let prevVolume = 0;
  for (const t of samples) {
    const n = toFiniteNumber(t.notionalUsd, 0);
    if (t.ts >= recentCutoff) {
      recentVolume += n;
    } else if (t.ts >= prevCutoff && t.ts < recentCutoff) {
      prevVolume += n;
    }
  }
  if (prevVolume <= 0) return recentVolume > 0 ? 1 : 0;
  return (recentVolume - prevVolume) / prevVolume;
}

export class TradeFlowTracker {
  constructor(config = {}) {
    this.buffer = [];
    this.prevOi = null;
    this.oiDelta = 0;
    this.oiDeltaTs = null;
    this.lastCleanupAt = 0;
    this.configure(config);
  }

  configure(config = {}) {
    const windows = normalizeWindows(config.windowsMs);
    const defaultWindowMsRaw = Math.floor(toFiniteNumber(config.defaultWindowMs, 30000));
    const defaultWindowMs = windows.includes(defaultWindowMsRaw) ? defaultWindowMsRaw : windows[Math.min(1, windows.length - 1)];
    this.config = {
      enabled: config.enabled !== false,
      windowsMs: windows,
      defaultWindowMs,
      maxBufferSize: Math.max(500, Math.floor(toFiniteNumber(config.maxBufferSize, 5000))),
      cleanupIntervalMs: Math.max(500, Math.floor(toFiniteNumber(config.cleanupIntervalMs, 3000))),
      minTradesForSignal: Math.max(1, Math.floor(toFiniteNumber(config.minTradesForSignal, 8))),
      largeTradeFactor: Math.max(1.2, toFiniteNumber(config.largeTradeFactor, 3.0))
    };
  }

  addTrade(trade) {
    if (this.config.enabled !== true) return;
    const px = toFiniteNumber(trade?.px, NaN);
    const sz = toFiniteNumber(trade?.sz, NaN);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(sz) || sz <= 0) return;
    const side = normalizeSide(trade?.side);
    if (!side) return;
    const ts = Math.max(0, Math.floor(toFiniteNumber(trade?.ts, Date.now())));
    const notionalUsd = px * sz;
    this.buffer.push({ ts, px, sz, side, notionalUsd });
    const now = Date.now();
    if ((now - this.lastCleanupAt) >= this.config.cleanupIntervalMs) {
      this.cleanup(now);
      this.lastCleanupAt = now;
    }
  }

  updateOi(oi, ts = Date.now()) {
    if (!this.config.enabled) return;
    const oiNum = toFiniteNumber(oi, NaN);
    if (!Number.isFinite(oiNum)) return;
    if (Number.isFinite(this.prevOi)) {
      this.oiDelta = oiNum - this.prevOi;
      this.oiDeltaTs = Math.max(0, Math.floor(toFiniteNumber(ts, Date.now())));
    }
    this.prevOi = oiNum;
  }

  getState(nowTs = Date.now()) {
    if (!this.config.enabled) {
      return {
        enabled: false,
        windowMs: this.config.defaultWindowMs,
        windows: {},
        ofi: 0,
        ofi30s: 0,
        flowPressure: 0,
        tradeCount: 0,
        buyVolumeUsd: 0,
        sellVolumeUsd: 0,
        oi: Number.isFinite(this.prevOi) ? this.prevOi : null,
        oiDelta: Number.isFinite(this.oiDelta) ? this.oiDelta : 0,
        oiDeltaTs: this.oiDeltaTs
      };
    }
    const now = Math.max(0, Math.floor(toFiniteNumber(nowTs, Date.now())));
    this.cleanup(now);
    const maxWindow = this.config.windowsMs[this.config.windowsMs.length - 1];
    const floorTs = now - maxWindow;
    const samples = this.buffer.filter(t => t.ts >= floorTs);
    const windows = {};

    for (const windowMs of this.config.windowsMs) {
      const cutoff = now - windowMs;
      let tradeCount = 0;
      let buyVolumeUsd = 0;
      let sellVolumeUsd = 0;
      let volumeUsd = 0;
      let vwapNotional = 0;
      let vwapSize = 0;
      const notionals = [];
      for (const t of samples) {
        if (t.ts < cutoff) continue;
        tradeCount += 1;
        const n = toFiniteNumber(t.notionalUsd, 0);
        volumeUsd += n;
        vwapNotional += n;
        vwapSize += toFiniteNumber(t.sz, 0);
        notionals.push(n);
        if (t.side === 'buy') buyVolumeUsd += n;
        else if (t.side === 'sell') sellVolumeUsd += n;
      }
      const flowPressure = volumeUsd > 0 ? (buyVolumeUsd - sellVolumeUsd) / volumeUsd : 0;
      const avgTradeNotionalUsd = tradeCount > 0 ? volumeUsd / tradeCount : 0;
      const largeThreshold = avgTradeNotionalUsd * this.config.largeTradeFactor;
      let largeTradeCount = 0;
      if (largeThreshold > 0) {
        for (const n of notionals) {
          if (n >= largeThreshold) largeTradeCount += 1;
        }
      }
      const tradeRatePerSec = windowMs > 0 ? tradeCount / (windowMs / 1000) : 0;
      const vwap = vwapSize > 0 ? (vwapNotional / vwapSize) : null;
      const acceleration = computeAcceleration(now, windowMs, samples.filter(t => t.ts >= cutoff));
      windows[String(windowMs)] = {
        windowMs,
        tradeCount,
        volumeUsd,
        buyVolumeUsd,
        sellVolumeUsd,
        ofi: flowPressure,
        flowPressure,
        avgTradeNotionalUsd,
        largeTradeCount,
        tradeRatePerSec,
        vwap,
        acceleration
      };
    }

    const activeKey = String(this.config.defaultWindowMs);
    const active = windows[activeKey] ?? Object.values(windows)[0] ?? {
      tradeCount: 0,
      volumeUsd: 0,
      buyVolumeUsd: 0,
      sellVolumeUsd: 0,
      ofi: 0,
      flowPressure: 0,
      avgTradeNotionalUsd: 0,
      largeTradeCount: 0,
      tradeRatePerSec: 0,
      vwap: null
    };
    const window30 = windows['30000'] ?? windows[30000] ?? null;

    return {
      enabled: true,
      ts: now,
      windowMs: this.config.defaultWindowMs,
      minTradesForSignal: this.config.minTradesForSignal,
      windows,
      tradeCount: active.tradeCount,
      volumeUsd: active.volumeUsd,
      buyVolumeUsd: active.buyVolumeUsd,
      sellVolumeUsd: active.sellVolumeUsd,
      ofi: toFiniteNumber(active.ofi, toFiniteNumber(active.flowPressure, 0)),
      ofi30s: toFiniteNumber(window30?.ofi, toFiniteNumber(window30?.flowPressure, 0)),
      flowPressure: active.flowPressure,
      avgTradeNotionalUsd: active.avgTradeNotionalUsd,
      largeTradeCount: active.largeTradeCount,
      tradeRatePerSec: active.tradeRatePerSec,
      vwap: active.vwap,
      acceleration: toFiniteNumber(active.acceleration, 0),
      oi: Number.isFinite(this.prevOi) ? this.prevOi : null,
      oiDelta: Number.isFinite(this.oiDelta) ? this.oiDelta : 0,
      oiDeltaTs: this.oiDeltaTs
    };
  }

  getFlowAlignment(positionSide, nowTs = Date.now()) {
    const state = this.getState(nowTs);
    const normalizedSide = normalizeSide(positionSide);
    const minTrades = Math.max(1, this.config.minTradesForSignal);
    const tradeCount = Math.floor(toFiniteNumber(state?.tradeCount, 0));
    const flowPressure = toFiniteNumber(state?.flowPressure, 0);
    if (!normalizedSide) {
      return {
        aligned: false,
        strength: 0,
        signal: 'unknown_side',
        flowPressure,
        tradeCount
      };
    }
    if (tradeCount < minTrades) {
      return {
        aligned: false,
        strength: 0,
        signal: 'insufficient_sample',
        flowPressure,
        tradeCount
      };
    }
    const alignedPressure = normalizedSide === 'buy' ? flowPressure : -flowPressure;
    let signal = 'neutral';
    if (alignedPressure >= 0.3) signal = 'supportive_strong';
    else if (alignedPressure >= 0.12) signal = 'supportive';
    else if (alignedPressure <= -0.3) signal = 'hostile_strong';
    else if (alignedPressure <= -0.12) signal = 'hostile';
    return {
      aligned: alignedPressure > 0,
      strength: alignedPressure,
      signal,
      flowPressure,
      tradeCount,
      acceleration: toFiniteNumber(state?.acceleration, 0)
    };
  }

  classifyMove(priceDelta, nowTs = Date.now()) {
    const state = this.getState(nowTs);
    const pDelta = toFiniteNumber(priceDelta, 0);
    const oiDelta = toFiniteNumber(state?.oiDelta, 0);
    const flowPressure = toFiniteNumber(state?.flowPressure, 0);
    const absDelta = Math.abs(pDelta);
    if (absDelta < 1e-9) {
      return {
        genuine: false,
        type: 'flat',
        confidence: 0.2,
        oiDelta,
        flowPressure
      };
    }
    const priceUp = pDelta > 0;
    const oiUp = oiDelta > 0;
    const oiDown = oiDelta < 0;
    if (priceUp && oiUp) {
      return { genuine: true, type: 'new_long', confidence: 0.8, oiDelta, flowPressure };
    }
    if (!priceUp && oiUp) {
      return { genuine: true, type: 'new_short', confidence: 0.8, oiDelta, flowPressure };
    }
    if (priceUp && oiDown) {
      return { genuine: false, type: 'short_cover', confidence: 0.65, oiDelta, flowPressure };
    }
    if (!priceUp && oiDown) {
      return { genuine: false, type: 'long_liquidation', confidence: 0.65, oiDelta, flowPressure };
    }
    return {
      genuine: false,
      type: 'oi_flat',
      confidence: 0.4,
      oiDelta,
      flowPressure
    };
  }

  cleanup(nowTs = Date.now()) {
    const now = Math.max(0, Math.floor(toFiniteNumber(nowTs, Date.now())));
    const maxWindow = this.config.windowsMs[this.config.windowsMs.length - 1] ?? 60000;
    const cutoff = now - maxWindow - 5000;
    if (this.buffer.length > 0) {
      this.buffer = this.buffer.filter(t => t.ts >= cutoff);
    }
    if (this.buffer.length > this.config.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.config.maxBufferSize);
    }
  }
}

let singleton = null;

export function getOrCreateTradeFlowTracker(config = {}) {
  if (!singleton) {
    singleton = new TradeFlowTracker(config);
  } else {
    singleton.configure(config);
  }
  return singleton;
}

export function resetTradeFlowTracker(config = {}) {
  singleton = new TradeFlowTracker(config);
  return singleton;
}
