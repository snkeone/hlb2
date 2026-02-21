/**
 * io/depthSR_aggregator.js
 * 15m時間窓を使用した SR 時間集計モジュール
 * 
 * 仕様: docs/B_LOGIC_SCALE_UP_SPEC.md セクション 12-18
 * - 時間窓: 15-60 分のカスタマイズ可能
 * - マージ閾値: mergeUsdEff を動的計算（kScale × channelWidth / targetBands）
 * - ready/fallback状態管理: セクション16に準拠
 * - observability: decision_trace へ srAgg diag を追加
 * 
 * 修正点:
 * - ageMs を「最新サンプル時刻との差」に修正
 * - ready条件から <1000 を削除（refreshSec×2の閾値に）
 * - mergeUsdEff を動的計算（channelWidth情報含む）
 * - repPoint=max_thickness を最大サイズ点選択に修正
 */

export const DEFAULT_CONFIG = {
  enabled: true,
  windowMin: 15,          // 時間窓(分)
  refreshSec: 20,         // サンプル更新間隔(秒)
  targetBands: 8,         // 想定帯数（デフォルト8、config優先で上書き可。将来は10へ段階調整）
  mergeUsd: 250,          // 近接マージ閾値（channelWidth<=0 のフォールバック値）
  mergeUsdMin: 80,        // mergeUsd 下限（狭channel対応）
  mergeUsdMax: 600,       // mergeUsd 上限
  minBandWidthUsd: 100,   // 帯幅ベース値（config で 120 に上書きし下限80に張り付き抑制）
  minStructureWidthUsd: 120, // primarySupport/Resistance の中心距離の下限
  maxBands: 6,            // 最大帯数（超過で粗マージ）
  repPoint: 'max_thickness', // 代表価格: 'max_thickness' | 'weighted_avg'
  kScale: 1.0,            // ボラティリティ適応係数
  logLevel: 'error'       // silent|error|warn|info|debug
};

const LOG_LEVEL_PRIORITY = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

function normalizeLogLevel(value, fallback = 'error') {
  const level = String(value ?? fallback).toLowerCase();
  return level in LOG_LEVEL_PRIORITY ? level : fallback;
}

/**
 * SR 時間集計マネージャー
 * 
 * 時間窓内の板スナップショットから SR 帯を集計し、
 * 遅延なく ready 状態で DepthSR 互換形式を供給する
 */
export class DepthSRAggregator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logLevel = normalizeLogLevel(process.env.DEPTH_SR_LOG_LEVEL ?? this.config.logLevel, 'error');
    
    // 時間窓バッファ: [{ ts, price, size }, ...]
    this.buffer = [];
    
    // 集計済み帯レイヤー: [{ price, size, width, count, ageMs }, ...]
    this.aggregatedBands = [];
    
    // 最新サンプル時刻（ageMs計算用）
    this.latestSnapshotTime = null;
    
    // 状態管理
    this.state = {
      ready: false,                // 集計が有効か
      ageMs: 0,                    // 最新サンプルからの経過時間
      bandCount: 0,                // 現在の帯数
      avgBandWidthUsd: 0,          // 帯幅平均
      avgStructuralDistanceUsd: 0, // 構造距離平均
      mergeUsdEff: this.config.mergeUsd, // 実効マージ値
      minBandWidthEff: this.config.minBandWidthUsd, // 実効帯幅下限
      channelWidthUsd: 0,          // 推定チャネル幅
    };
    
    // 診断情報（Phase A: SR帯の落とし理由を可視化）
    this.srDiag = {
      preFilter: { support: 0, resistance: 0, all: 0 },
      postFilter: { support: 0, resistance: 0, all: 0 },
      dropped: [],
      params: {},
      bandCount: 0,
      channelWidthUsd: 0,
      structuralDistanceUsd: null,
      fallbackReason: null  // 正常系は null、フォールバック時は reason をセット
    };
    
    // パフォーマンス監視
    this.stats = {
      aggregationCount: 0,    // 集計実行回数
      fallbackCount: 0,       // フォールバック呼び出し回数
      calcTimeMs: 0,          // 最後の計算時間
    };
    
    // P0: スタックトレース取得機構（時間ゲート方式・60秒）
    this.aggErrorCount = 0;           // エラー累積回数
    this.lastStackOutputTs = null;    // 前回stack出力時刻
    
    this.nextRefreshTime = null;
  }

  _shouldLog(level) {
    const current = LOG_LEVEL_PRIORITY[this.logLevel] ?? LOG_LEVEL_PRIORITY.error;
    const target = LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.error;
    return current >= target;
  }

  _log(level, ...args) {
    if (!this._shouldLog(level)) return;
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else console.log(...args);
  }

  /**
   * 板データを時間窓バッファに追加
   * @param {number} ts - タイムスタンプ（ms）
   * @param {Array} bids - [{ price, size }, ...]
   * @param {Array} asks - [{ price, size }, ...]
   */
  addDepthSnapshot(ts, bids, asks) {
    // 時間窓外のデータを削除（window 秒以上前）
    const windowMs = this.config.windowMin * 60 * 1000;
    const cutoffTime = ts - windowMs;
    this.buffer = this.buffer.filter(entry => entry.ts > cutoffTime);
    
    // 現在の bids/asks を追加
    if (Array.isArray(bids)) {
      for (const { price, size } of bids) {
        if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
          this.buffer.push({ ts, price, size, side: 'bid' });
        }
      }
    }
    if (Array.isArray(asks)) {
      for (const { price, size } of asks) {
        if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
          this.buffer.push({ ts, price, size, side: 'ask' });
        }
      }
    }
    
    // バッファサイズ制限（メモリ溢れ防止：最大10000件）
    if (this.buffer.length > 10000) {
      this.buffer = this.buffer.slice(-5000);
    }
    
    // 最新時刻を更新
    this.latestSnapshotTime = ts;
    
    // 更新時刻チェック
    if (!this.nextRefreshTime) {
      this.nextRefreshTime = ts + this.config.refreshSec * 1000;
    }
  }

  /**
   * 集計実行（ready判定含む）
   * 仕様セクション16: 優先度1-4に従いfallback判定
   * 
   * @param {number} currentTime - 現在時刻（ms）
   * @param {number} mid - 中値
   * @returns {boolean} 集計に成功したか
   */
  runAggregation(currentTime, mid) {
    const startMs = Date.now();
    
    // 更新間隔チェック
    if (currentTime < this.nextRefreshTime) {
      return this.state.ready; // 前回の結果を返す
    }
    
    try {
      // 診断: dropped配列をクリア（新しい集計サイクル開始）
      this.srDiag.dropped = [];
      
      // 最新サンプルからの経過時間を計算（修正）
      if (this.latestSnapshotTime) {
        this.state.ageMs = Math.max(0, currentTime - this.latestSnapshotTime);
      }
      
      // 1. Support/Resistance 側に分離
      const supportData = this.buffer.filter(e => e.price <= mid);
      const resistanceData = this.buffer.filter(e => e.price > mid);
      
      // 診断: preFilter を記録（マージ前）
      this.srDiag.preFilter = {
        support: supportData.length,
        resistance: resistanceData.length,
        all: supportData.length + resistanceData.length
      };
      
      // 2. 帯マージ処理（動的マージ値を使用）
      const supportBands = this._mergePriceBands(supportData, true, mid);
      const resistanceBands = this._mergePriceBands(resistanceData, false, mid);
      
      // 3. maxBands チェック：超過ならさらに粗マージ
      const allBands = [...supportBands, ...resistanceBands];
      let finalBands = allBands;
      if (allBands.length > this.config.maxBands) {
        finalBands = this._coarseMergeBands(allBands);
      }
      
      // 優先度1: 帯がなければフォールバック
      if (finalBands.length === 0) {
        this._resetSrDiag('no_bands');
        this.state.ready = false;
        this.stats.calcTimeMs = Date.now() - startMs;
        return false;
      }
      
      // 4. サマリ計算
      this.aggregatedBands = finalBands;
      this._updateStateSummary(finalBands);
      
      // 診断: postFilter を記録（マージ後の最終帯数）
      const supPostFilter = finalBands.filter(b => b.side === 'support').length;
      const resPostFilter = finalBands.filter(b => b.side === 'resistance').length;
      this.srDiag.postFilter = {
        support: supPostFilter,
        resistance: resPostFilter,
        all: finalBands.length
      };
      
      // 計算時間を更新
      this.stats.calcTimeMs = Date.now() - startMs;
      
      // 優先度2: 計算遅延 > 1s ならフォールバック
      if (this.stats.calcTimeMs > 1000) {
        this._resetSrDiag('calc_timeout');
        this.state.ready = false;
        return false;
      }
      
      // 優先度3: 最新データ age > windowMin ならフォールバック
      if (this.state.ageMs > this.config.windowMin * 60 * 1000) {
        this._resetSrDiag('data_stale');
        this.state.ready = false;
        this._log('warn', `[DepthSRAggregator] Ready dropped due to age: ageMs=${this.state.ageMs}ms > ${this.config.windowMin * 60 * 1000}ms, aggregatedBands.length=${this.aggregatedBands.length}`);
        return false;
      }
      
      // ready判定: 最低2本以上の帯 + 計算時間OK + age OK
      this.state.ready = finalBands.length >= 2;
      
      // ◆ デバッグログ1: runAggregation 終了時の状態
      if (this.aggregatedBands.length > 0) {
        const supBands = this.aggregatedBands.filter(b => b.side === 'support');
        const resBands = this.aggregatedBands.filter(b => b.side === 'resistance');
        const repSup = supBands.length > 0 ? supBands[supBands.length - 1] : null;
        const repRes = resBands.length > 0 ? resBands[0] : null;
        this._log('debug', `[DepthSRAggregator.runAggregation] state: ready=${this.state.ready}, bandCount=${this.aggregatedBands.length}, ageMs=${this.state.ageMs}, repSupport=${repSup ? `${repSup.price}±${repSup.width}` : 'null'}, repResistance=${repRes ? `${repRes.price}±${repRes.width}` : 'null'}`);
      }
      
      this.stats.aggregationCount++;
      this.nextRefreshTime = currentTime + this.config.refreshSec * 1000;
      
      return this.state.ready;
    } catch (err) {
      // P0: エラーカウント
      ++this.aggErrorCount;
      
      // P0: スタックを常に出力（デバッグモード）
      const ts = new Date().toISOString();
      this._log('error', `[${ts}][DepthSRAggregator] aggregation CRITICAL ERROR: ${err.message}`);
      this._log('error', `[${ts}][DepthSRAggregator][errCount=${this.aggErrorCount}] ${err.name}`);
      this._log('error', `[${ts}][DepthSRAggregator] Stack trace:\n${err.stack}`);
      this._log('error', `[${ts}][DepthSRAggregator] Buffer size: ${this.buffer.length}, Bands: ${this.aggregatedBands.length}`);
      
      // 例外発生時は srDiag と aggregatedBands をリセット（古い診断が decision_trace に載らないように）
      this._resetSrDiag('error');
      this.state.ready = false;
      this.stats.calcTimeMs = Date.now() - startMs;
      return false;
    }
  }

  /**
   * srDiag をリセット（フォールバック時に古い診断が残らないように）
   * state もリセット（古い bandCount, channelWidthUsd などが decision_trace に載らないように）
   * @private
   * @param {string|null} reason - リセット理由（フォールバック時は文字列、呼び出し側が指定; 正常系は null）
   */
  _resetSrDiag(reason) {
    // aggregatedBands もクリア（ready=false時に古い帯データが残らないように）
    this.aggregatedBands = [];
    
    this.srDiag = {
      preFilter: { support: 0, resistance: 0, all: 0 },
      postFilter: { support: 0, resistance: 0, all: 0 },
      dropped: [],
      params: {},
      bandCount: 0,
      channelWidthUsd: 0,
      structuralDistanceUsd: null,
      fallbackReason: reason ?? null  // 明示的に null を保証（undefined 防止）
    };
    
    // state もリセット（古い値が decision_trace に載らないように）
    this.state = {
      ready: false,
      bandCount: 0,
      channelWidthUsd: 0,
      structuralDistanceUsd: null,
      mergeUsdEff: this.config.mergeUsd,
      minBandWidthEff: this.config.minBandWidthUsd,
      avgBandWidthUsd: 0,
      ageMs: null
    };
  }

  /**
   * 集計 SR を DepthSR 互換形式で返す（独立した呼び出し）
   * 呼び出し側が ready=false の時に fallback を選択
   * 
   * @returns {DepthSR} 集計版 SR（ready フラグ含む）
   */
  getAggregatedDepthSR() {
    // ◆ デバッグログ2a: 入力時の aggregatedBands 状態
    this._log('debug', `[DepthSRAggregator.getAggregatedDepthSR] ENTRY: aggregatedBands.length=${this.aggregatedBands.length}, state.ready=${this.state.ready}`);
    
    // Support/Resistance に分離
    const supportBands = this.aggregatedBands.filter(b => b.side === 'support');
    const resistanceBands = this.aggregatedBands.filter(b => b.side === 'resistance');
    
    // 最も価格が mid に近い帯を選択
    let primarySupport = supportBands.length > 0 
      ? supportBands[supportBands.length - 1] 
      : null;
    let primaryResistance = resistanceBands.length > 0 
      ? resistanceBands[0] 
      : null;

    // primary 間の中心距離（structureWidth）
    const structureWidthUsd = (primarySupport && primaryResistance)
      ? Math.abs(primaryResistance.price - primarySupport.price)
      : null;

    // structureWidth が閾値未満なら primary を無効化し ready を落とす
    const minStructureWidthUsd = this.config.minStructureWidthUsd ?? DEFAULT_CONFIG.minStructureWidthUsd;
    if (
      Number.isFinite(minStructureWidthUsd) &&
      Number.isFinite(structureWidthUsd) &&
      structureWidthUsd < minStructureWidthUsd
    ) {
      this._log('warn', `[DepthSRAggregator.getAggregatedDepthSR] STRUCTURE_WIDTH_GUARD: structureWidthUsd=${structureWidthUsd} < minStructureWidthUsd=${minStructureWidthUsd} => drop primary bands`);
      this.state.ready = false;
      this.srDiag.fallbackReason = 'structure_width_too_narrow';
      // primarySupport / primaryResistance を無効化（B側で no_depth_sr へ）
      primarySupport = null;
      primaryResistance = null;
    } else if (Number.isFinite(structureWidthUsd)) {
      this._log('debug', `[DepthSRAggregator.getAggregatedDepthSR] STRUCTURE_WIDTH_OK: structureWidthUsd=${structureWidthUsd}, minStructureWidthUsd=${minStructureWidthUsd}`);
      // 構造幅が正常復帰した場合のみ、structure_width_too_narrow をクリア（他のフォールバック理由は保持）
      if (this.srDiag.fallbackReason === 'structure_width_too_narrow') {
        this.srDiag.fallbackReason = null;
      }
    }
    
    // structuralDistance: 上側帯下端 − 下側帯上端
    let structuralDistanceUsd = null;
    if (primarySupport && primaryResistance) {
      const supUpper = primarySupport.price + primarySupport.width / 2;
      const resLower = primaryResistance.price - primaryResistance.width / 2;
      structuralDistanceUsd = Math.max(0, resLower - supUpper);
    }

    // チャネル幅: primaryR.center - primaryS.center（片側欠損時は幅を0とする）
    let channelWidthUsd = 0;
    if (primarySupport && primaryResistance) {
      channelWidthUsd = Math.abs(primaryResistance.price - primarySupport.price);
    } else if (primarySupport) {
      channelWidthUsd = primarySupport.width ?? 0;
    } else if (primaryResistance) {
      channelWidthUsd = primaryResistance.width ?? 0;
    }
    this.state.channelWidthUsd = channelWidthUsd;
    
    // 片側欠落の診断情報
    const supportCount = supportBands.length;
    const resistanceCount = resistanceBands.length;
    const empty = supportCount === 0 && resistanceCount === 0;
    let missingSide = null;
    if (supportCount === 0 && resistanceCount > 0) {
      missingSide = 'support';
    } else if (supportCount > 0 && resistanceCount === 0) {
      missingSide = 'resistance';
    } else if (empty) {
      missingSide = 'both';
    }
    
    // ◆ デバッグログ2b: 分離後の状態と center/width 算出
    this._log('debug', `[DepthSRAggregator.getAggregatedDepthSR] split: supportCount=${supportCount}, resistanceCount=${resistanceCount}, primarySupport=${primarySupport ? `${primarySupport.price}±${primarySupport.width}` : 'null'}, primaryResistance=${primaryResistance ? `${primaryResistance.price}±${primaryResistance.width}` : 'null'}`);
    
    // Center/Width から Lower/Upper を算出（aggregatedBands のみから）
    // Aggregator は独立 - fallback は呼び出し側で判定
    const supportCenter = primarySupport?.price ?? null;
    const supportWidth = primarySupport?.width ?? null;
    const resistanceCenter = primaryResistance?.price ?? null;
    const resistanceWidth = primaryResistance?.width ?? null;
    
    this._log('debug', `[DepthSRAggregator.getAggregatedDepthSR] CENTER/WIDTH: supportCenter=${supportCenter}, supportWidth=${supportWidth}, primarySupport=${primarySupport ? 'exists' : 'null'}`);
    
    const supportLower = supportCenter != null && supportWidth != null 
      ? supportCenter - supportWidth / 2 
      : null;
    const supportUpper = supportCenter != null && supportWidth != null 
      ? supportCenter + supportWidth / 2 
      : null;
    const resistanceLower = resistanceCenter != null && resistanceWidth != null 
      ? resistanceCenter - resistanceWidth / 2 
      : null;
    const resistanceUpper = resistanceCenter != null && resistanceWidth != null 
      ? resistanceCenter + resistanceWidth / 2 
      : null;
    
    // ◆ デバッグログ2c: 最終計算結果（lower/upper）
    this._log('debug', `[DepthSRAggregator.getAggregatedDepthSR] calculated: supportCenter=${supportCenter}, supportLower=${supportLower}, supportUpper=${supportUpper}, resistanceCenter=${resistanceCenter}, resistanceLower=${resistanceLower}, resistanceUpper=${resistanceUpper}`);
    
    // フォールバック: ready=false または 帯不足（でも lower/upper は常に出力）
    const isReady = this.state.ready && this.aggregatedBands.length >= 2;
    const isFallback = !isReady;
    
    // ◆ デバッグ用: aggregatedBands の実状をキャプチャ
    const debugBands = this.aggregatedBands.slice(0, 2).map(b => ({ price: b.price, width: b.width, side: b.side }));
    
    // 診断情報を最終組み立て（Phase A）
    this.srDiag.params = {
      targetBands: this.config.targetBands ?? DEFAULT_CONFIG.targetBands,
      mergeUsdMin: this.config.mergeUsdMin ?? DEFAULT_CONFIG.mergeUsdMin,
      mergeUsdMax: this.config.mergeUsdMax ?? DEFAULT_CONFIG.mergeUsdMax,
      minBandWidthUsd: this.config.minBandWidthUsd ?? DEFAULT_CONFIG.minBandWidthUsd,
      minStructureWidthUsd: this.config.minStructureWidthUsd ?? DEFAULT_CONFIG.minStructureWidthUsd,
      kScale: this.config.kScale ?? DEFAULT_CONFIG.kScale,
    };
    this.srDiag.bandCount = this.state.bandCount;
    this.srDiag.channelWidthUsd = this.state.channelWidthUsd;
    this.srDiag.structuralDistanceUsd = structuralDistanceUsd;
    
    // 純粋に aggregatedBands から構築（Aggregator 独立）
    return {
      supportCenter,
      supportWidth,
      supportLower,
      supportUpper,
      resistanceCenter,
      resistanceWidth,
      resistanceLower,
      resistanceUpper,
      ready: isReady,
      // 集計診断情報（diag）
      srAgg: {
        aggReady: this.state.ready,  // Aggregator の ready 状態
        supportCount,
        resistanceCount,
        missingSide,
        empty,
        windowMin: this.config.windowMin,
        targetBands: this.config.targetBands ?? DEFAULT_CONFIG.targetBands,  // ← 追加（null禁止）
        mergeUsdEff: this.state.mergeUsdEff,
        bandCount: this.state.bandCount,
        avgBandWidthUsd: this.state.avgBandWidthUsd,
        avgStructuralDistanceUsd: this.state.avgStructuralDistanceUsd,
        ageMs: this.state.ageMs,
        kScale: this.config.kScale,
        channelWidthUsd: this.state.channelWidthUsd,
        fallback: isFallback,
        debug: {
          aggregatedBands_length: this.aggregatedBands.length,
          state_ready: this.state.ready,
          isReady_return: isReady,
          primarySupport_exists: primarySupport !== null,
          primarySupport_value: primarySupport ? `${primarySupport.price}±${primarySupport.width}` : null,
          primaryResistance_exists: primaryResistance !== null,
          primaryResistance_value: primaryResistance ? `${primaryResistance.price}±${primaryResistance.width}` : null,
          supportCenter,
          supportWidth,
          supportLower,
          supportUpper,
          resistanceCenter,
          resistanceWidth,
          resistanceLower,
          resistanceUpper,
          debugBands: debugBands,
        }
      },
      // 診断情報（Phase A: dropped帯の可視化）
      // ディープコピーして下流での変異を防ぐ
      srDiag: {
        preFilter: { ...this.srDiag.preFilter },
        postFilter: { ...this.srDiag.postFilter },
        dropped: this.srDiag.dropped.map(d => ({ ...d })),
        params: { ...this.srDiag.params },
        bandCount: this.srDiag.bandCount,
        channelWidthUsd: this.srDiag.channelWidthUsd,
        structuralDistanceUsd: this.srDiag.structuralDistanceUsd,
        fallbackReason: this.srDiag.fallbackReason
      }
    };
  }

  /**
   * 価格近接クラスタをマージして帯を生成
   * 仕様セクション12: 近接±200-300、粗マージ±400-700
   * 
   * @private
   * @param {Array} data - [{ ts, price, size }, ...]
   * @param {boolean} isSupport - true=support, false=resistance
   * @param {number} mid - 中値（channelWidth計算用）
   * @returns {Array} 帯: [{ price, size, width, count }, ...]
   */
  _mergePriceBands(data, isSupport, mid) {
    if (data.length === 0) return [];
    
    // 価格でソート
    const sorted = Array.from(data)
      .sort((a, b) => isSupport ? b.price - a.price : a.price - b.price);
    
    // チャネル幅を推定（このデータセットから）
    const prices = sorted.map(e => e.price);
    const channelWidth = Math.max(...prices) - Math.min(...prices);
    
    // 動的マージ値を計算（セクション12/14/15）
    const mergeUsd = this._calculateMergeUsd(channelWidth);
    
    const bands = [];
    let currentBand = null;
    
    for (const entry of sorted) {
      if (!currentBand) {
        // 新規帯開始
        currentBand = {
          price: entry.price,
          totalSize: entry.size,
          count: 1,
          prices: [entry.price],
          sizes: [entry.size],  // repPoint=max_thickness計算用
          timestamps: [entry.ts],
          priceRange: [entry.price, entry.price],
        };
      } else {
        const priceDiff = Math.abs(entry.price - currentBand.price);
        
        if (priceDiff <= mergeUsd) {
          // 同一帯に追加（マージ）
          currentBand.totalSize += entry.size;
          currentBand.count++;
          currentBand.prices.push(entry.price);
          currentBand.sizes.push(entry.size);
          currentBand.timestamps.push(entry.ts);
          currentBand.priceRange = [
            Math.min(currentBand.priceRange[0], entry.price),
            Math.max(currentBand.priceRange[1], entry.price),
          ];
        } else {
          // 新規帯開始
          bands.push(this._finalizeBand(currentBand, isSupport ? 'support' : 'resistance'));
          currentBand = {
            price: entry.price,
            totalSize: entry.size,
            count: 1,
            prices: [entry.price],
            sizes: [entry.size],
            timestamps: [entry.ts],
            priceRange: [entry.price, entry.price],
          };
        }
      }
    }
    
    if (currentBand) {
      bands.push(this._finalizeBand(currentBand, isSupport ? 'support' : 'resistance'));
    }
    
    return bands;
  }

  /**
   * mergeUsd を動的に計算
   * 仕様: mergeUsdEff = clamp(kScale * (channelWidth / targetBands), mergeUsdMin, mergeUsdMax)
   * config > DEFAULT_CONFIG の優先順（null-coalescing）
   * channelWidth<=0 の時のみ mergeUsd フォールバック使用（edge case）
   * @private
   */
  _calculateMergeUsd(channelWidth) {
    // config から値を優先取得（trade.json で上書き可能）
    const targetBands = this.config.targetBands ?? DEFAULT_CONFIG.targetBands;
    const mergeUsdMin = this.config.mergeUsdMin ?? DEFAULT_CONFIG.mergeUsdMin;
    const mergeUsdMax = this.config.mergeUsdMax ?? DEFAULT_CONFIG.mergeUsdMax;
    
    // edge case: channelWidth がない場合のフォールバック（通常は到達不可）
    if (channelWidth <= 0) {
      this.state.mergeUsdEff = this.config.mergeUsd;
      return this.config.mergeUsd;
    }
    
    // 動的計算
    const baseValue = (channelWidth / targetBands);
    const scaled = this.config.kScale * baseValue;
    const mergeUsdEff = Math.max(mergeUsdMin, Math.min(mergeUsdMax, scaled));
    
    this.state.mergeUsdEff = mergeUsdEff;
    return mergeUsdEff;
  }

  /**
   * minBandWidthUsd も動的に計算
   * 仕様: minBandWidthEff = clamp(kScale * base, mergeUsdMin, 800)
   * config > DEFAULT_CONFIG の優先順
   * 下限を mergeUsdMin に統一（固定値から可変へ、帯潰れ抑制）
   * @private
   */
  _calculateMinBandWidth() {
    // config から値を優先取得（trade.json で最適化可能）
    const mergeUsdMin = this.config.mergeUsdMin ?? DEFAULT_CONFIG.mergeUsdMin;
    
    // base（デフォルト100 or config値）を取得し下限 mergeUszMin に統一
    const baseValue = this.config.minBandWidthUsd ?? DEFAULT_CONFIG.minBandWidthUsd;
    const scaled = this.config.kScale * baseValue;
    const lowerBound = mergeUsdMin;
    const minBandWidthEff = Math.max(lowerBound, Math.min(800, scaled));
    
    this.state.minBandWidthEff = minBandWidthEff;
    return minBandWidthEff;
  }

  /**
   * 帯を確定（代表価格・幅計算）
   * 仕様セクション15: repPoint=max_thickness は最大サイズ対応の価格を選択
   * 
   * @private
   */
  _finalizeBand(band, side) {
    let repPrice = band.price;
    
    if (this.config.repPoint === 'max_thickness') {
      // 最大サイズを持つ価格を選択（修正）
      let maxSize = 0;
      let maxSizeIdx = 0;
      for (let i = 0; i < band.sizes.length; i++) {
        if (band.sizes[i] > maxSize) {
          maxSize = band.sizes[i];
          maxSizeIdx = i;
        }
      }
      repPrice = band.prices[maxSizeIdx];
    } else if (this.config.repPoint === 'weighted_avg') {
      // 重み付き平均（出現回数による）
      repPrice = band.prices.reduce((a, b) => a + b, 0) / band.prices.length;
    }
    
    // 帯幅: 実効下限値をクリップ
    const minBandWidth = this._calculateMinBandWidth();
    const width = Math.max(
      Math.max(...band.priceRange) - Math.min(...band.priceRange) + 1,
      minBandWidth
    );
    
    return {
      price: repPrice,
      width: width,
      side: side,
      size: band.totalSize,
      count: band.count,
      ageMs: Date.now() - Math.max(...band.timestamps),
    };
  }

  /**
   * maxBands を超えた場合のさらに粗いマージ
   * 仕様セクション12: 近接マージ後にmaxBands超なら粗マージ±400-700
   * 
   * @private
   */
  _coarseMergeBands(allBands) {
    if (!Array.isArray(allBands) || allBands.length <= this.config.maxBands) {
      return allBands;
    }
    
    // 粗マージ前の帯数を記録
    const preCoarseBands = allBands.length;
    
    // 粗マージ閾値: mergeUsdEff × 1.5 ～ 2.0、上限700
    const coarseMergeUsd = Math.min(
      this.state.mergeUsdEff * 1.75,
      700
    );
    
    const support = allBands
      .filter(b => b?.side === 'support')
      .sort((a, b) => (b?.price ?? 0) - (a?.price ?? 0));
    const resistance = allBands
      .filter(b => b?.side === 'resistance')
      .sort((a, b) => (a?.price ?? 0) - (b?.price ?? 0));
    
    const mergedSupportResult = this._mergeWithinGroup(support, coarseMergeUsd, 'support');
    const mergedResistanceResult = this._mergeWithinGroup(resistance, coarseMergeUsd, 'resistance');
    
    const mergedSupport = mergedSupportResult.merged;
    const mergedResistance = mergedResistanceResult.merged;
    
    const result = [...mergedSupport, ...mergedResistance];
    
    // 粗マージで落とされた帯を記録
    const droppedByCoarseMerge = preCoarseBands - result.length;
    if (droppedByCoarseMerge > 0 && this.srDiag.dropped.length < 5) {
      // 実際に削除されたバンドを特定：_mergeWithinGroup から返された groupInfo を使用
      // groupInfo には各グループの {representative, deleted} が含まれる
      
      const actualDeleted = [];
      
      // Support側の削除バンドを抽出（groupInfo から）
      if (mergedSupportResult.groupInfo && Array.isArray(mergedSupportResult.groupInfo)) {
        mergedSupportResult.groupInfo.forEach(groupEntry => {
          if (groupEntry.deleted && Array.isArray(groupEntry.deleted)) {
            actualDeleted.push(...groupEntry.deleted);
          }
        });
      }
      
      // Resistance側の削除バンドを抽出（groupInfo から）
      if (mergedResistanceResult.groupInfo && Array.isArray(mergedResistanceResult.groupInfo)) {
        mergedResistanceResult.groupInfo.forEach(groupEntry => {
          if (groupEntry.deleted && Array.isArray(groupEntry.deleted)) {
            actualDeleted.push(...groupEntry.deleted);
          }
        });
      }
      
      // 最初のエントリに合計削除本数を記録
      this.srDiag.dropped.push({
        side: 'aggregate',
        reason: 'coarse_merge',
        price: null,
        width: null,
        size: null,
        count: droppedByCoarseMerge  // 実際に削除された帯数
      });
      
      // 代表例として実際に削除されたバンドから最初の2本を記録（診断用）
      const remainingSlots = 5 - this.srDiag.dropped.length;
      actualDeleted.slice(0, Math.min(2, remainingSlots)).forEach(b => {
        this.srDiag.dropped.push({
          side: b.side ?? 'unknown',
          reason: 'coarse_merge_example',
          price: b.price ?? null,
          width: b.width ?? null,
          size: b.size ?? null,
          count: 1
        });
      });
    }
    
    // それでも超過なら、トップN を返す（反復制限）
    if (result.length > this.config.maxBands) {
      const supportCount = Math.ceil(this.config.maxBands / 2);
      const resistanceCount = this.config.maxBands - supportCount;
      
      // maxBands超過で切り捨てられた帯を記録
      const trimmedSupport = mergedSupport.slice(supportCount);
      const trimmedResistance = mergedResistance.slice(resistanceCount);
      const trimmedBands = [...trimmedSupport, ...trimmedResistance];
      const trimmedCount = trimmedBands.length;
      
      if (trimmedCount > 0 && this.srDiag.dropped.length < 5) {
        // maxBands超過で削除された帯の集計を記録（実際の削除本数を count に）
        this.srDiag.dropped.push({
          side: 'aggregate',
          reason: 'maxBands',
          price: null,
          width: null,
          size: null,
          count: trimmedCount  // 実際に削除された帯数
        });
        
        // 代表例として最初の1本を記録（診断用）
        if (trimmedBands.length > 0 && this.srDiag.dropped.length < 5) {
          this.srDiag.dropped.push({
            side: trimmedBands[0].side ?? 'unknown',
            reason: 'maxBands_example',
            price: trimmedBands[0].price ?? null,
            width: trimmedBands[0].width ?? null,
            size: trimmedBands[0].size ?? null,
            count: 1
          });
        }
      }
      
      return [
        ...mergedSupport.slice(0, supportCount),
        ...mergedResistance.slice(0, resistanceCount),
      ];
    }
    
    return result;
  }

  /**
   * グループ内で粗マージ
   * @private
   * @returns {Object} { merged: Array<Band>, groupInfo: Array<{representative, deleted}> }
   *   - merged: マージ後の帯配列
   *   - groupInfo: 各グループの代表帯と削除帯の情報（repPoint で決定された代表のみ保存）
   */
  _mergeWithinGroup(bands, threshold, side) {
    if (!Array.isArray(bands) || bands.length === 0) return { merged: [], groupInfo: [] };
    
    // ガード: bands が無効な場合
    if (bands.some(b => !Number.isFinite(b?.price))) {
      this._log('warn', '[DepthSRAggregator] Invalid band in _mergeWithinGroup:', bands.slice(0, 2));
      return { merged: bands.slice(0, this.config.maxBands), groupInfo: [] };
    }
    
    const result = [];
    const groupInfo = [];  // 各グループの代表と削除情報
    let currentGroup = [bands[0]];
    
    for (let i = 1; i < bands.length; i++) {
      const prevBand = currentGroup[currentGroup.length - 1];
      const currBand = bands[i];
      
      // ガード: オブジェクト構造が破損していないか確認
      if (!Number.isFinite(prevBand?.price) || !Number.isFinite(currBand?.price)) {
        this._log('warn', '[DepthSRAggregator] Invalid price in bands:', prevBand?.price, currBand?.price);
        break;
      }
      
      const priceDiff = Math.abs(currBand.price - prevBand.price);
      
      if (priceDiff <= threshold) {
        currentGroup.push(currBand);
      } else {
        // グループ確定：代表帯を作り、representativeIndex から実削除帯を特定
        const { representative, representativeIndex } = this._mergeBandGroup(currentGroup, side);
        result.push(representative);
        
        // 実削除帯：representativeIndex を除いたバンド
        const deleted = currentGroup.filter((_, idx) => idx !== representativeIndex);
        
        groupInfo.push({
          representative: representative,
          deleted: deleted,  // 正確に代表以外
          representativeIndex: representativeIndex,
        });
        
        currentGroup = [currBand];
      }
    }
    
    if (currentGroup.length > 0) {
      const { representative, representativeIndex } = this._mergeBandGroup(currentGroup, side);
      result.push(representative);
      const deleted = currentGroup.filter((_, idx) => idx !== representativeIndex);
      groupInfo.push({
        representative: representative,
        deleted: deleted,
        representativeIndex: representativeIndex,
      });
    }
    
    return { merged: result, groupInfo };
  }

  /**
   * 帯グループを1つに統合（代表帯とインデックスを返す）
   * @private
   * @returns {Object} { representative, representativeIndex }
   *   - representative: 代表帯（_finalizeBand で確定）
   *   - representativeIndex: グループ内での代表インデックス
   */
  _mergeBandGroup(group, side) {
    if (!Array.isArray(group) || group.length === 0) {
      return {
        representative: {
          price: 0,
          width: this._calculateMinBandWidth(),
          side: side,
          size: 0,
          count: 0,
          ageMs: 0,
        },
        representativeIndex: -1,
      };
    }
    
    // 代表価格を決定（repPoint ロジック復旧）
    let repIndex = 0;  // デフォルトは先頭
    let repPrice = group[0]?.price ?? 0;
    
    if (this.config.repPoint === 'max_thickness') {
      // 最大サイズを持つバンドを代表とする
      let maxSize = group[0]?.size ?? 0;
      for (let i = 1; i < group.length; i++) {
        const size = group[i]?.size ?? 0;
        if (size > maxSize) {
          maxSize = size;
          repIndex = i;
        }
      }
      repPrice = group[repIndex]?.price ?? 0;
    } else if (this.config.repPoint === 'weighted_avg') {
      // 重み付き平均（サイズによる加重）
      const totalSize = group.reduce((sum, b) => sum + (b?.size ?? 0), 0);
      if (totalSize > 0) {
        repPrice = group.reduce((sum, b) => sum + ((b?.price ?? 0) * (b?.size ?? 0)), 0) / totalSize;
      } else {
        repPrice = group.reduce((sum, b) => sum + (b?.price ?? 0), 0) / group.length;
      }
    } else {
      // デフォルト：最初のバンド
      repPrice = group[0]?.price ?? 0;
    }
    
    // サマリ計算
    const totalSize = group.reduce((sum, b) => sum + (b?.size ?? 0), 0);
    const maxWidth = Math.max(...group.map(b => b?.width ?? 0));
    const minBandWidth = this._calculateMinBandWidth();
    
    // 設計意図：
    // - 代表帯の幅: グループ内の最大幅に下限値を適用（Math.max）
    //   理由: 代表帯は集計結果として実際に使われるため、最小限の幅を保証する必要がある
    // - repPoint=weighted_avg でも幅は最大幅（価格のみ重み付け、幅は非対称）
    //   理由: 幅は「グループ内に存在する最厚部」という情報であり、価格の重み付けと独立
    const representative = {
      price: repPrice,
      width: Math.max(maxWidth, minBandWidth),
      side: side,
      size: totalSize,
      count: group.length,
      ageMs: Math.min(...group.map(b => b?.ageMs ?? 0)),
    };
    
    return {
      representative,
      representativeIndex: repIndex,
    };
  }

  /**
   * 状態サマリを更新
   * @private
   */
  _updateStateSummary(finalBands) {
    if (!Array.isArray(finalBands) || finalBands.length === 0) {
      this.state.bandCount = 0;
      this.state.avgBandWidthUsd = 0;
      this.state.avgStructuralDistanceUsd = 0;
      return;
    }
    
    this.state.bandCount = finalBands.length;
    this.state.avgBandWidthUsd = finalBands.length > 0
      ? finalBands.reduce((sum, b) => sum + (Number.isFinite(b?.width) ? b.width : 0), 0) / finalBands.length
      : 0;
    
    // structuralDistance 計算: 上側帯下端 − 下側帯上端
    const supportBands = finalBands
      .filter(b => b?.side === 'support')
      .sort((a, b) => (b?.price ?? 0) - (a?.price ?? 0));
    const resistanceBands = finalBands
      .filter(b => b?.side === 'resistance')
      .sort((a, b) => (a?.price ?? 0) - (b?.price ?? 0));
    
    if (supportBands.length > 0 && resistanceBands.length > 0) {
      const supUpper = (supportBands[0]?.price ?? 0) + ((supportBands[0]?.width ?? 0) / 2);
      const resLower = (resistanceBands[0]?.price ?? 0) - ((resistanceBands[0]?.width ?? 0) / 2);
      this.state.avgStructuralDistanceUsd = Math.max(0, resLower - supUpper);
    } else {
      this.state.avgStructuralDistanceUsd = 0;
    }
  }

  /**
   * 設定を動的に更新（hot reload 対応）
   * 仕様セクション15: updateConfig時にmergeUsdEff/minBandWidthEff再計算
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    // 効果値の再計算
    this._calculateMergeUsd(this.state.channelWidthUsd);
    this._calculateMinBandWidth();
  }

  /**
   * 診断情報を返す
   */
  getDiagnostics() {
    return {
      config: this.config,
      state: this.state,
      stats: this.stats,
      bufferSize: this.buffer.length,
      bandCount: this.aggregatedBands.length,
      bands: this.aggregatedBands.slice(0, 3), // 最初の3本のサンプル
    };
  }
}
