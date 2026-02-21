// io/calc.ts
// I/O 層：ioMetrics 計算（純粋関数のみ、判断ロジックなし）
// 禁止事項遵守：console/throw/状態保持なし、raw・marketStateは不変
// 型は柔らかく扱う（Normalize-Spec v1.0に準拠しつつ、I/O側で最低限参照する）
// marketState: { current: {...}, prev: {...}|null }
// current/prevには少なくとも midPx, oi, bestBidPx, bestAskPx, lastTradePx などが含まれる前提
// 1) cRaw の算出（チャネル内での生位置）。
// lastTradePx を基準に bestBid/bestAsk の相対位置を算出する。
//   cRaw = (lastTradePx - bestBidPx) / (bestAskPx - bestBidPx) * 2 - 1
// 分母が0/不正、必要値が欠損の場合は null。
export function calculateCRaw(current) {
    const bid = toNumber(current?.bestBidPx);
    const ask = toNumber(current?.bestAskPx);
    const last = toNumber(current?.lastTradePx);
    if (bid == null || ask == null || last == null)
        return null;
    const denom = ask - bid;
    if (denom <= 0)
        return null;
    const ratio = (last - bid) / denom; // 0..1
    return ratio * 2 - 1; // -1..+1に射影した生位置
}
// 2) c（-1〜+1 の正規化位置）: cRawを -1..+1 にクリップ。丸め禁止。
export function normalizeC(cRaw) {
    if (cRaw == null)
        return null;
    if (cRaw < -1)
        return -1;
    if (cRaw > 1)
        return 1;
    return cRaw;
}
// 3) zone 判定（top/mid/bottom）
// Logic層との統一のため、'top'|'mid'|'bottom' を使用
export function calculateZone(c) {
    if (c == null)
        return null;
    if (c >= 0.70)
        return 'top';
    if (c <= -0.70)
        return 'bottom';
    return 'mid';
}
// 4) isNearTop / isNearBottom
export function calculateNearBands(c) {
    if (c == null) {
        return { isNearTop: false, isNearBottom: false };
    }
    return {
        isNearTop: c >= 0.90,
        isNearBottom: c <= -0.90,
    };
}
// 5) prev/current 差分
// prev が null の場合は diff = 0。
export function calculateDiffs(current, prev) {
    const cur = {
        midPx: toNumber(current?.midPx) ?? 0,
        oi: toNumber(current?.oi) ?? 0,
        bestBid: toNumber(current?.bestBidPx) ?? 0,
        bestAsk: toNumber(current?.bestAskPx) ?? 0,
        lastTradePx: toNumber(current?.lastTradePx) ?? 0,
    };
    if (!prev) {
        return { midPx: 0, oi: 0, bestBid: 0, bestAsk: 0, lastTradePx: 0 };
    }
    const prv = {
        midPx: toNumber(prev?.midPx) ?? 0,
        oi: toNumber(prev?.oi) ?? 0,
        bestBid: toNumber(prev?.bestBidPx) ?? 0,
        bestAsk: toNumber(prev?.bestAskPx) ?? 0,
        lastTradePx: toNumber(prev?.lastTradePx) ?? 0,
    };
    return {
        midPx: cur.midPx - prv.midPx,
        oi: cur.oi - prv.oi,
        bestBid: cur.bestBid - prv.bestBid,
        bestAsk: cur.bestAsk - prv.bestAsk,
        lastTradePx: cur.lastTradePx - prv.lastTradePx,
    };
}
// メイン：ioMetrics の組み立て（副作用ゼロ）
export function buildIOMetrics(marketState) {
    const current = marketState?.current ?? {};
    const prev = marketState?.prev ?? null;
    const cRaw = calculateCRaw(current);
    const c = normalizeC(cRaw);
    const zone = calculateZone(c);
    const near = calculateNearBands(c);
    const diffs = calculateDiffs(current, prev);
    // cPrev の計算：prev がなければ null
    const cPrevRaw = prev ? calculateCRaw(prev) : null;
    const cPrev = cPrevRaw == null ? null : normalizeC(cPrevRaw);
    // I/Oは判断しない：構造体を返すのみ
    return {
        cRaw,
        c,
        cPrev,
        zone,
        isNearTop: near.isNearTop,
        isNearBottom: near.isNearBottom,
        diffs,
    };
}
// 内部ヘルパ：安全な数値変換（calc.ts内でのみ使用）。丸め禁止。
function toNumber(v) {
    if (typeof v === 'number') {
        return isNaN(v) ? null : v;
    }
    if (typeof v === 'string') {
        if (v === '')
            return null; // 空文字は0化せずnull
        const n = Number(v);
        return isNaN(n) ? null : n;
    }
    if (typeof v === 'boolean')
        return null;
    return null;
}
