/**
 * Live Market Provider 設計コメント
 *
 * - 接続方式: WebSocket/REST どちらでも可（推奨: REST 1本→WS拡張）
 * - 再接続ポリシー: 指数バックオフ、最大5回まで自動リトライ。失敗時は常に {midPx:null, oi:null, ts, _src:'live'} を返す。
 * - データ正規化: 取得データは必ず { midPx: number|null, oi: number|null, ts: number, _src: 'live' } 形式で返す。値が不正/欠損時はnullを返す。
 * - 例外時の戻り値: throw禁止。必ずnullを返す。ログ出力も最小限。
 * - init(config): サーバ起動時に呼ばれる。APIキー・URL等の設定を受け取る。未使用時はno-op。
 * - close(): サーバ終了時に呼ばれる。クリーンアップ用。未使用時はno-op。
 */
// Live Market Provider Skeleton

export function getMarket() {
  return {
    midPx: null,
    oi: null,
    ts: Date.now(),
    _src: 'live'
  };
}

// 接続I/Fの空スタブ（将来のWS/REST用）
export function init() {
  // no-op
}

export function close() {
  // no-op
}
