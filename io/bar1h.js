/**
 * io/bar1h.js
 * 
 * 責務：WS tick から 1時間 OHLC バーを生成・管理
 * 時刻：UTC基準（Date.now()）
 * 配列規約：close[0]=最新（未確定含む）、close[n-1]=最古
 * 
 * 出力：
 * - bar1h.close[] : OHLC データ
 * - bar1h.bars[] : 確定バー履歴
 * - bar1h.current : 現在バー（未確定）
 */

export class Bar1hTracker {
  constructor(config = {}) {
    this.bars = []; // 確定バー履歴（古→新）
    this.current = null; // 現在バー（未確定）
    this.sourceLog = []; // source追跡用（品質監査）
    this.config = config; // bar1h コンフィグ
  }

  /**
   * update
   * WS tick（midPx）を受け取り、bar1h を更新
   * 
   * @param {number} nowMs - Date.now()
   * @param {number} midPx - (bestBidPx + bestAskPx) / 2
   * @param {string} source - データ出処（"midPx" / "lastTradePx"）
   */
  update(nowMs, midPx, source = 'midPx') {
    const tsStart = this._calcBarStart(nowMs);

    // 新しいバーに遷移したか？
    if (!this.current || this.current.tsStart !== tsStart) {
      if (this.current) {
        // 前バーを確定して履歴に追加
        this.bars.push(this.current);
        this.sourceLog.push({
          tsStart: this.current.tsStart,
          source: this.current.source,
          closeValues: this.current.closeHistory.join(',')
        });
      }
      // 新バー開始
      this.current = {
        tsStart,
        open: midPx,
        high: midPx,
        low: midPx,
        close: midPx,
        closeHistory: [midPx],
        source
      };
    } else {
      // 現在バー内の更新
      this.current.high = Math.max(this.current.high, midPx);
      this.current.low = Math.min(this.current.low, midPx);
      this.current.close = midPx;
      this.current.closeHistory.push(midPx);
      this.current.source = source; // 最新データ出処
    }
  }

  /**
   * getCloseArray
   * 未確定バーを含む close[] 配列を返す（0=最新）
   * 
   * @param {number} len - 要素数（lenA=16）
   * @returns {number[]} close[0]=最新, close[1]=1本前, ...
   */
  getCloseArray(len) {
    const result = [];

    // 未確定バーの close を先頭に
    if (this.current) {
      result.push(this.current.close);
    }

    // 確定バーを古い順に追加（結果的に新→旧になる）
    for (let i = this.bars.length - 1; i >= 0 && result.length < len; i--) {
      result.push(this.bars[i].close);
    }

    return result;
  }

  /**
   * getBarCount
   * 確定バー数 + 未確定バー(0 or 1)
   */
  getBarCount() {
    return this.bars.length + (this.current ? 1 : 0);
  }

  /**
   * hasUnclosed
   * 未確定バーが存在するか
   */
  hasUnclosed() {
    return this.current ? 1 : 0;
  }

  /**
   * debugLog5Bars
   * 5本分の bar をログ出力（Phase 0-B 検証用）
   */
  debugLog5Bars() {
    console.log('[bar1h] ===== Phase 0-B: 5本分ログ開始 =====');
    
    const count = Math.min(5, this.bars.length + (this.current ? 1 : 0));
    let idx = 0;

    // 未確定バー
    if (this.current) {
      console.log(`[bar1h] bar[${idx}] (未確定) tsStart=${this.current.tsStart} close=${this.current.close} source=${this.current.source}`);
      idx++;
    }

    // 確定バー（新→旧）
    for (let i = this.bars.length - 1; i >= 0 && idx < count; i--) {
      const bar = this.bars[i];
      console.log(`[bar1h] bar[${idx}] (確定) tsStart=${bar.tsStart} close=${bar.close} source=${bar.source}`);
      idx++;
    }

    console.log('[bar1h] ===== Phase 0-B: ログ終了 =====');
  }

  /**
   * _calcBarStart
   * UTC 1時間境界を計算
   * 
   * @param {number} nowMs
   * @returns {number} tsStart (ms)
   */
  _calcBarStart(nowMs) {
    const barMs = 60 * 60 * 1000; // 3600000ms (1 hour)
    return Math.floor(nowMs / barMs) * barMs;
  }

  /**
   * getCurrentBarInfo
   * 現在バーのメタデータ（検証用）
   */
  getCurrentBarInfo() {
    if (!this.current) {
      return null;
    }
    return {
      tsStart: this.current.tsStart,
      open: this.current.open,
      high: this.current.high,
      low: this.current.low,
      close: this.current.close,
      closeTickCount: this.current.closeHistory.length,
      source: this.current.source
    };
  }

  /**
   * getState
   * decision_a.js が参照する bar1hState を返す
    * Phase A: ready 判定は bars.length >= lookbackBars（設定本数確定後にA判定を許可）
   * 
    * high/low は過去lookbackBars本 + 現在1本の最高値・最安値を返す
   * 
   * @returns {Object} { ready, high, low, mid }
   */
  getState() {
    // lookbackBars は config から取得（デフォルト=4）
    const lookbackBars = this.config?.lookbackBars ?? 4;
    // [A1-6] ready定義：未確定バーが存在し、かつ確定バーが lookbackBars 本以上で true
    const ready = this.current != null && this.bars.length >= lookbackBars;
    if (!this.current) {
      return {
        ready,
        barCount: this.getBarCount(),
        high: 0,
        low: 0,
        mid: 0
      };
    }
    
    // 過去N本 + 現在1本の最高値・最安値を計算
    let high = this.current.high;
    let low = this.current.low;
    
    // 過去N本を遡る
    const lookbackCount = Math.min(lookbackBars, this.bars.length);
    for (let i = this.bars.length - 1; i >= this.bars.length - lookbackCount; i--) {
      if (i >= 0) {
        const bar = this.bars[i];
        if (bar.high > high) high = bar.high;
        if (bar.low < low) low = bar.low;
      }
    }
    
    return {
      ready,
      barCount: this.getBarCount(),
      high,
      low,
      mid: this.current.close
    };
  }
  
  /**
   * updateConfig
   * ホットリロード用：コンフィグを動的に更新
   * 
   * @param {Object} newConfig - 新しいコンフィグ（bar1h セクション）
   */
  updateConfig(newConfig) {
    if (newConfig && typeof newConfig === 'object') {
      this.config = newConfig;
    }
  }

  mergeBackfillCandles(candles, nowMs = Date.now()) {
    if (!Array.isArray(candles) || candles.length === 0) return { addedBars: 0, adoptedCurrent: false };

    const barMs = 60 * 60 * 1000;
    const currentHourStart = this._calcBarStart(nowMs);
    const existingTs = new Set(this.bars.map((b) => b.tsStart));
    if (this.current?.tsStart != null) {
      existingTs.add(this.current.tsStart);
    }

    let addedBars = 0;
    let adoptedCurrent = false;

    for (const candle of candles) {
      const tsStart = Number(candle?.tsStart);
      const open = Number(candle?.open);
      const high = Number(candle?.high);
      const low = Number(candle?.low);
      const close = Number(candle?.close);
      if (!Number.isFinite(tsStart) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        continue;
      }
      if (high < low) continue;
      if (existingTs.has(tsStart)) continue;

      const bar = {
        tsStart,
        open,
        high,
        low,
        close,
        closeHistory: [close],
        source: candle?.source || 'backfill'
      };

      if (tsStart === currentHourStart && !this.current) {
        this.current = bar;
        adoptedCurrent = true;
      } else if (tsStart < currentHourStart) {
        this.bars.push(bar);
        addedBars += 1;
      } else if (tsStart > currentHourStart && tsStart < currentHourStart + barMs) {
        if (!this.current) {
          this.current = bar;
          adoptedCurrent = true;
        }
      }

      existingTs.add(tsStart);
    }

    if (this.bars.length > 1) {
      this.bars.sort((a, b) => a.tsStart - b.tsStart);
    }

    return { addedBars, adoptedCurrent };
  }

  /**
   * close配列を返す（LRC_TV連携用）
   * close[0]=最新（未確定含む）、close[n-1]=最古
   */
  get close() {
    // [A1-6] close 配列規約：close[0]=最新(未確定)、close[1]=直近確定、以降確定を新→旧で積む
    const result = [];
    
    // 現在バー（未確定）を最初に追加
    if (this.current) {
      result.push(this.current.close);
    }
    
    // 確定バーを新→古の順で追加
    for (let i = this.bars.length - 1; i >= 0; i--) {
      result.push(this.bars[i].close);
    }
    
    return result;
  }
}

// シングルトンインスタンス（必要に応じて）
let tracker = null;

export function getBar1hTracker() {
  if (!tracker) {
    tracker = new Bar1hTracker();
  }
  return tracker;
}

export function resetBar1hTracker() {
  tracker = new Bar1hTracker();
  return tracker;
}

export function createBar1hTracker(config = {}) {
  return new Bar1hTracker(config);
}
