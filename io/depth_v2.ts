// @ts-nocheck
// io/depth_v2.ts
// SR設計仕様書 v1.0 実装
// 参照: docs/SR_IMPLEMENTATION_PROPOSAL.md
// ============================================================================
// Phase 1 定数（Section 4, 7, 9.5より）
// ============================================================================
var OBSERVATION_WINDOW = 3600; // 秒（1時間・Section 4確定値）
var MIN_SAMPLE_COUNT = 300; // 秒（修正：900 → 300、初期化加速）
var SAMPLE_INTERVAL = 1; // 秒（1秒に1回サンプリング）
var PRICE_BIN_SIZE = 1.0; // USD（Section 9.5確定値）
var DEPTH_THRESHOLD_MULTIPLIER = 1.2; // 平均の1.2倍以上を厚いと判定（修正：1.5 → 1.2）
var TOP_CLUSTERS = 2; // 上位2クラスタ（Primary+Secondary）
var MERGE_DISTANCE = 5.0; // USD（Section 9.5確定値）
var FREQUENCY_ANALYSIS_INTERVAL = 60 * 1000; // ミリ秒（Section 7確定値）
var WIDTH_STDDEV_MULTIPLIER = 2.0; // 標準偏差の2倍
var MIN_WIDTH = 2.0; // USD（最小幅）
var MAX_WIDTH = 15.0; // USD（最大幅）
var ASYMMETRY_RATIO_MIN_RANGE = 1.0; // USD（Section 9.5確定値）
// ============================================================================
// DepthSRAnalyzer クラス
// ============================================================================
var DepthSRAnalyzer = /** @class */ (function () {
    function DepthSRAnalyzer() {
        // ────────────────────────────────────────────────────────────────────────
        // Private State Management
        // ────────────────────────────────────────────────────────────────────────
        // Section 4: リングバッファ（観測窓保持）
        // TODO: Section 4「観測と蓄積」に従い、過去1時間のスナップショットを保持
        this.history = [];
        // Section 9.5: 内部状態（SRState：唯一の真実）
        // TODO: Section 10「Secondary真実の所在」に従い、Private完全閉鎖
        this.state = {
            S1_center: null,
            S1_width: null,
            R1_center: null,
            R1_width: null,
            S0_center: null,
            S0_width: null,
            R2_center: null,
            R2_width: null,
            ready: false,
            sampleCount: 0,
            lastMidPx: null,
            lastAnalysisTime: Date.now(),
        };
        // Section 7: 60秒タイマー管理
        // TODO: Section 9.5「60秒タイマー実装」に従い、経過時間ベースで実装
        this.lastAnalysisTime = Date.now();
    }
    // ────────────────────────────────────────────────────────────────────────
    // Public API（唯一の入口）
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Section 7: 唯一のエントリーポイント
     * WebSocketから毎秒呼び出される
     *
     * @param snapshot - オーダーブック・スナップショット
     * @param mid - 現在のmid価格
     * @returns 現在の DepthSR（ready状態を含む）
     */
    DepthSRAnalyzer.prototype.onDepthSnapshot = function (snapshot, mid) {
        // TODO: Section 4 処理1: snapshot蓄積（常に実行）
        this.addSnapshot(snapshot);
        // 市場midは生値で保持し、SR計算とは独立に動かす
        this.state.lastMidPx = mid;
        // TODO: Section 7 処理2: 60秒判定（内部timer管理）
        if (this.shouldRunAnalysis()) {
            // TODO: Section 9.5「60秒タイマー実装」に従い分析実行
            this.runFrequencyAnalysis(mid);
        }
        // TODO: Section 10 処理3: 外部インターフェース生成＆返却
        return this.generateDepthSR();
    };
    /**
     * Section 10: SRInternalState の readyステータスのみ公開
     * （診断専用）
     */
    DepthSRAnalyzer.prototype.isReady = function () {
        return this.state.ready;
    };
    /**
     * Section 10: Sample Count 公開（検証用）
     */
    DepthSRAnalyzer.prototype.getSampleCount = function () {
        return this.state.sampleCount;
    };
    // ────────────────────────────────────────────────────────────────────────
    // Private Methods（制御フロー）
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Section 4: スナップショット蓄積
     * リングバッファとして過去1時間分を保持
     */
    DepthSRAnalyzer.prototype.addSnapshot = function (snapshot) {
        // リングバッファに追加
        this.history.push(snapshot);
        // 観測窓外（OBSERVATION_WINDOW=3600秒以上古い）データを削除
        var now = snapshot.timestamp;
        while (this.history.length > 0 && (now - this.history[0].timestamp) > OBSERVATION_WINDOW * 1000) {
            this.history.shift();
        }
        // sampleCount を更新（蓄積されたサンプル数）
        this.state.sampleCount = this.history.length;
    };
    /**
     * Section 7: 60秒経過判定
     * 経過時間ベース（wall-clockではなく相対時間）
     */
    DepthSRAnalyzer.prototype.shouldRunAnalysis = function () {
        // Section 9.5「60秒タイマー実装」に従い判定
        // Date.now() - lastAnalysisTime >= FREQUENCY_ANALYSIS_INTERVAL
        var now = Date.now();
        return (now - this.lastAnalysisTime) >= FREQUENCY_ANALYSIS_INTERVAL;
    };
    /**
     * Section 5-6: 周波数分析＆SR更新
     * 以下を実行して state を更新：
     * 1. 頻度ヒストグラム構築
     * 2. クラスタ検出（上位2つ）
     * 3. center/width 計算
     * 4. ready判定（MIN_SAMPLE_COUNT達成？）
     */
    DepthSRAnalyzer.prototype.runFrequencyAnalysis = function (mid) {
        // 直近のSRを保持しておき、分析失敗時に既存値を残せるようにする
        var prevPrimary = {
            S1_center: this.state.S1_center,
            S1_width: this.state.S1_width,
            R1_center: this.state.R1_center,
            R1_width: this.state.R1_width,
        };
        var prevSecondary = {
            S0_center: this.state.S0_center,
            S0_width: this.state.S0_width,
            R2_center: this.state.R2_center,
            R2_width: this.state.R2_width,
        };
        // Section 5 処理1: 頻度ヒストグラム生成
        var freqHistogram = buildFrequencyHistogram(this.history, mid);
        // Section 5 処理2: Support側クラスタ検出（mid以下）
        var supportBins = new Map();
        for (var _i = 0, _a = Array.from(freqHistogram.entries()); _i < _a.length; _i++) {
            var entry = _a[_i];
            var binId = entry[0], freq = entry[1];
            var price = binId * PRICE_BIN_SIZE;
            if (price <= mid) {
                supportBins.set(binId, freq);
            }
        }
        var supportClusters = mergeAdjacentBins(supportBins);
        // Section 5 処理3: Resistance側クラスタ検出（mid超）
        var resistanceBins = new Map();
        for (var _b = 0, _c = Array.from(freqHistogram.entries()); _b < _c.length; _b++) {
            var entry = _c[_b];
            var binId = entry[0], freq = entry[1];
            var price = binId * PRICE_BIN_SIZE;
            if (price > mid) {
                resistanceBins.set(binId, freq);
            }
        }
        var resistanceClusters = mergeAdjacentBins(resistanceBins);
        // Section 6 処理4: Primary の center/width計算
        if (supportClusters.length > 0) {
            this.state.S1_center = supportClusters[0].center;
            this.state.S1_width = calculateWeightedStdDev(supportClusters[0]);
        }
        else if (prevPrimary.S1_center !== null && prevPrimary.S1_width !== null) {
            // 修正：ready 判定を除去し、初期化時も前の値を保持
            this.state.S1_center = prevPrimary.S1_center;
            this.state.S1_width = prevPrimary.S1_width;
        }
        else {
            this.state.S1_center = null;
            this.state.S1_width = null;
        }
        if (resistanceClusters.length > 0) {
            this.state.R1_center = resistanceClusters[0].center;
            this.state.R1_width = calculateWeightedStdDev(resistanceClusters[0]);
        }
        else if (prevPrimary.R1_center !== null && prevPrimary.R1_width !== null) {
            // 修正：ready 判定を除去し、初期化時も前の値を保持
            this.state.R1_center = prevPrimary.R1_center;
            this.state.R1_width = prevPrimary.R1_width;
        }
        else {
            this.state.R1_center = null;
            this.state.R1_width = null;
        }
        // Section 6 処理5: Secondary の center/width計算（null許可）
        if (supportClusters.length > 1) {
            this.state.S0_center = supportClusters[1].center;
            this.state.S0_width = calculateWeightedStdDev(supportClusters[1]);
        }
        else if (prevSecondary.S0_center !== null && prevSecondary.S0_width !== null) {
            // 修正：ready 判定を除去し、初期化時も前の値を保持
            this.state.S0_center = prevSecondary.S0_center;
            this.state.S0_width = prevSecondary.S0_width;
        }
        else {
            this.state.S0_center = null;
            this.state.S0_width = null;
        }
        if (resistanceClusters.length > 1) {
            this.state.R2_center = resistanceClusters[1].center;
            this.state.R2_width = calculateWeightedStdDev(resistanceClusters[1]);
        }
        else if (prevSecondary.R2_center !== null && prevSecondary.R2_width !== null) {
            // 修正：ready 判定を除去し、初期化時も前の値を保持
            this.state.R2_center = prevSecondary.R2_center;
            this.state.R2_width = prevSecondary.R2_width;
        }
        else {
            this.state.R2_center = null;
            this.state.R2_width = null;
        }
        // Section 10 処理6: ready状態更新
        // once-true-never-false セマンティクス
        var primaryReady = this.state.S1_center !== null && this.state.R1_center !== null;
        if (primaryReady && this.state.sampleCount >= MIN_SAMPLE_COUNT) {
            this.state.ready = true;
        }
        // Section 9.5 処理7: タイマーリセット
        this.lastAnalysisTime = Date.now();
    };
    /**
     * Section 10: DepthSR生成
     * 内部状態（SRInternalState）から、
     * 外部インターフェース（DepthSR）を生成
     *
     * Secondary は可視フラグのみ（価格は隠す）
     */
    DepthSRAnalyzer.prototype.generateDepthSR = function () {
        var _a, _b;
        // Section 10「初期状態フェーズ」
        // ready=false時は null安全で統一
        // 修正: S1_center/R1_center の実在性で ready を再判定
        var actualReady = this.state.S1_center !== null && this.state.R1_center !== null;
        
        if (!actualReady) {
            return {
                supportCenter: null,
                supportWidth: null,
                supportLower: null,
                supportUpper: null,
                resistanceCenter: null,
                resistanceWidth: null,
                resistanceLower: null,
                resistanceUpper: null,
                ready: false,  // ← 修正：S1/R1が null なら ready=false
                asymmetryRatio: null,
                observationSampleCount: this.state.sampleCount,
                hasSecondarySupport: false,
                hasSecondaryResistance: false,
                reason: this.state.sampleCount < MIN_SAMPLE_COUNT ? 'insufficient_samples' : 'awaiting_qualification',
            };
        }
        // Primary のedges計算
        var supWidth = (_a = this.state.S1_width) !== null && _a !== void 0 ? _a : (this.state.S1_center !== null ? MIN_WIDTH : null);
        var resWidth = (_b = this.state.R1_width) !== null && _b !== void 0 ? _b : (this.state.R1_center !== null ? MIN_WIDTH : null);
        var _c = calculateEdges(this.state.S1_center, supWidth), supLower = _c[0], supUpper = _c[1];
        var _d = calculateEdges(this.state.R1_center, resWidth), resLower = _d[0], resUpper = _d[1];
        // Section 10「Secondary真実の所在」
        // hasSecondarySupport/Resistance フラグのみ公開
        var hasSecondarySupport = this.state.S0_center !== null;
        var hasSecondaryResistance = this.state.R2_center !== null;
        // asymmetryRatio計算（ready=trueの時点でS1/R1は非null）
        var asymmetryRatio = calculateAsymmetryRatio(
        // WS生midをそのまま使用し、SRとは独立に動くようにする
        this.state.lastMidPx, this.state.S1_center, this.state.R1_center);
        return {
            supportCenter: this.state.S1_center,
            supportWidth: this.state.S1_width,
            supportLower: supLower,
            supportUpper: supUpper,
            resistanceCenter: this.state.R1_center,
            resistanceWidth: this.state.R1_width,
            resistanceLower: resLower,
            resistanceUpper: resUpper,
            ready: actualReady,  // ← 修正：実際のPrimary有効性を返す
            asymmetryRatio: asymmetryRatio,
            observationSampleCount: this.state.sampleCount,
            hasSecondarySupport: hasSecondarySupport,
            hasSecondaryResistance: hasSecondaryResistance,
            reason: null,
        };
    };
    return DepthSRAnalyzer;
}());
export { DepthSRAnalyzer };
// ============================================================================
// ヘルパー関数（純粋計算関数）
// 副作用なし・テスト可能・再利用可能
// ============================================================================
/**
 * Section 9.5: 頻度ヒストグラム生成
 * 観測窓内のすべてのスナップショットから、
 * 各価格ビンの出現頻度をカウント
 *
 * Section 4「重要原則」に従い、
 * DEPTH_THRESHOLD_MULTIPLIER以上のビンのみを計上
 */
export function buildFrequencyHistogram(history, mid) {
    var _a, _b;
    // Section 5: 平均板厚を計算（閾値判定用）
    // bid/ask合算の上位20レベルから計算
    var allDepths = [];
    for (var _i = 0, history_1 = history; _i < history_1.length; _i++) {
        var snapshot = history_1[_i];
        for (var _c = 0, _d = snapshot.bids.slice(0, 20); _c < _d.length; _c++) {
            var bid = _d[_c];
            allDepths.push(bid.size);
        }
        for (var _e = 0, _f = snapshot.asks.slice(0, 20); _e < _f.length; _e++) {
            var ask = _f[_e];
            allDepths.push(ask.size);
        }
    }
    var meanDepth = allDepths.length > 0
        ? allDepths.reduce(function (a, b) { return a + b; }, 0) / allDepths.length
        : 0;
    var threshold = meanDepth * DEPTH_THRESHOLD_MULTIPLIER;
    // ヒストグラム構築
    var histogram = new Map();
    for (var _g = 0, history_2 = history; _g < history_2.length; _g++) {
        var snapshot = history_2[_g];
        // bid側（mid以下）
        for (var _h = 0, _j = snapshot.bids; _h < _j.length; _h++) {
            var bid = _j[_h];
            if (bid.price <= mid && bid.size >= threshold) {
                var binId = Math.floor(bid.price / PRICE_BIN_SIZE);
                histogram.set(binId, ((_a = histogram.get(binId)) !== null && _a !== void 0 ? _a : 0) + 1);
            }
        }
        // ask側（midより上）
        for (var _k = 0, _l = snapshot.asks; _k < _l.length; _k++) {
            var ask = _l[_k];
            if (ask.price > mid && ask.size >= threshold) {
                var binId = Math.floor(ask.price / PRICE_BIN_SIZE);
                histogram.set(binId, ((_b = histogram.get(binId)) !== null && _b !== void 0 ? _b : 0) + 1);
            }
        }
    }
    return histogram;
}
/**
 * Section 9.5: 平均板厚計算
 * 上位20レベルの単純平均（bid/ask合算）
 *
 * 凍結②「上位20レベルの単純平均」を実装
 */
export function calculateMeanDepth(bids, asks) {
    // Section 9.5より、上位20レベルの単純平均
    var topBids = bids.slice(0, 20);
    var topAsks = asks.slice(0, 20);
    var bidSizeSum = topBids.reduce(function (sum, level) { return sum + level.size; }, 0);
    var askSizeSum = topAsks.reduce(function (sum, level) { return sum + level.size; }, 0);
    var totalLevels = topBids.length + topAsks.length;
    if (totalLevels === 0)
        return 0;
    return (bidSizeSum + askSizeSum) / totalLevels;
}
/**
 * Section 9.5: クラスタマージアルゴリズム
 * MERGE_DISTANCE以内の隣接ビンを連結し、
 * 上位TOP_CLUSTERSを抽出
 *
 * Section 9.5「クラスタマージアルゴリズム」のコード例を参照
 */
export function mergeAdjacentBins(freqHistogram, mergeDistance) {
    if (mergeDistance === void 0) { mergeDistance = MERGE_DISTANCE; }
    // 1. 価格昇順でソート
    var bins = Array.from(freqHistogram.entries())
        .sort(function (a, b) { return a[0] - b[0]; });
    if (bins.length === 0)
        return [];
    var clusters = [];
    var currentCluster = [];
    // 2. 隣接ビンをギャップ検出で分断
    for (var _i = 0, bins_1 = bins; _i < bins_1.length; _i++) {
        var _a = bins_1[_i], price = _a[0], freq = _a[1];
        if (currentCluster.length === 0) {
            // 最初のビン
            currentCluster.push([price, freq]);
        }
        else {
            var lastPrice = currentCluster[currentCluster.length - 1][0];
            if (Math.abs(price - lastPrice) <= mergeDistance) {
                // 連結条件を満たす → 同一クラスタに追加
                currentCluster.push([price, freq]);
            }
            else {
                // ギャップ検出 → クラスタ確定
                clusters.push(buildCluster(currentCluster));
                currentCluster = [[price, freq]]; // 新クラスタ開始
            }
        }
    }
    // 3. 最後のクラスタを確定
    if (currentCluster.length > 0) {
        clusters.push(buildCluster(currentCluster));
    }
    // 4. 頻度順でソート（上位2つが Primary/Secondary）
    return clusters.sort(function (a, b) { return b.totalFrequency - a.totalFrequency; });
}
/**
 * Section 9.5: クラスタ構築（ヘルパー）
 * 連結ビンからCluster型を構築
 *
 * Section 9.5「クラスタマージアルゴリズム」のbuildCluster参照
 */
export function buildCluster(bins) {
    var totalFreq = bins.reduce(function (sum, _a) {
        var freq = _a[1];
        return sum + freq;
    }, 0);
    var weightedPrice = bins.reduce(function (sum, _a) {
        var px = _a[0], freq = _a[1];
        return sum + px * freq;
    }, 0);
    var center = weightedPrice / totalFreq;
    return {
        center: center,
        totalFrequency: totalFreq,
        bins: bins,
        priceRange: [bins[0][0], bins[bins.length - 1][0]],
    };
}
/**
 * Section 6: 加重標準偏差（width計算用）
 * クラスタ内の周波数加重分散から標準偏差を計算
 *
 * Section 9.5「加重標準偏差」のコード例を参照
 * 計算結果は [2.0, 15.0] の範囲に制限
 */
export function calculateWeightedStdDev(cluster) {
    var bins = cluster.bins;
    // 1. 加重平均（center）
    var totalFreq = bins.reduce(function (sum, _a) {
        var freq = _a[1];
        return sum + freq;
    }, 0);
    var mean = bins.reduce(function (sum, _a) {
        var px = _a[0], freq = _a[1];
        return sum + px * freq;
    }, 0) / totalFreq;
    // 2. 加重分散
    var variance = bins.reduce(function (sum, _a) {
        var px = _a[0], freq = _a[1];
        var diff = px - mean;
        return sum + freq * diff * diff;
    }, 0) / totalFreq;
    // 3. 標準偏差
    var stddev = Math.sqrt(variance);
    // 4. width = stddev × 2.0（範囲制限付き）
    var width = stddev * WIDTH_STDDEV_MULTIPLIER;
    return Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH);
}
/**
 * Section 6: Center（中心）計算
 * クラスタの頻度加重平均価格
 *
 * Section 6「Center の計算」を実装
 */
export function calculateClusterCenter(cluster) {
    var bins = cluster.bins;
    var totalFreq = bins.reduce(function (sum, _a) {
        var freq = _a[1];
        return sum + freq;
    }, 0);
    if (totalFreq === 0)
        return 0;
    return bins.reduce(function (sum, _a) {
        var px = _a[0], freq = _a[1];
        return sum + px * freq;
    }, 0) / totalFreq;
}
/**
 * Section 10: asymmetryRatio計算
 * (mid - S_center) / (R_center - S_center)
 *
 * Section 10「Bロジック情報」に従い、
 * range < 1.0 なら null を返す（凍結⑤）
 */
export function calculateAsymmetryRatio(mid, supportCenter, resistanceCenter) {
    if (supportCenter === null || resistanceCenter === null) {
        return null; // SR未成立
    }
    var range = resistanceCenter - supportCenter;
    // ゼロ除算防止 + 狭すぎる場合の例外処理（凍結⑤）
    if (Math.abs(range) < ASYMMETRY_RATIO_MIN_RANGE) {
        return null;
    }
    var ratio = (mid - supportCenter) / range;
    return ratio;
}
/**
 * Section 10: Edge（帯の境界）計算
 * lower = center - width/2
 * upper = center + width/2
 *
 * Section 6「Edge（帯の境界）の計算」を実装
 */
export function calculateEdges(center, width) {
    if (center === null || width === null) {
        return [null, null];
    }
    var lower = center - (width / 2);
    var upper = center + (width / 2);
    return [lower, upper];
}
// ============================================================================
// ロジックなし・構造のみ（以上）
// ============================================================================
