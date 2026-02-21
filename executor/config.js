// Executor Live Integration - Environment Configuration
// Provides environment variables for Live mode operation

/**
 * Live モード有効化コインリスト
 * BTC のみ Live 発注許可、HYPE は将来用（現在は無効化）
 */
export const LIVE_ENABLED_COINS = ['BTC'];

/**
 * SignerAdapter の URL
 * デフォルト: localhost:8000
 */
export const SIGNER_ADAPTER_URL = process.env.SIGNER_ADAPTER_URL || 'http://localhost:8000';

/**
 * Mainnet/Testnet 切替
 * SignerAdapter と同じ環境変数を使用
 */
export const HL_MAINNET = (process.env.HL_MAINNET || 'true').toLowerCase() === 'true';

/**
 * Hyperliquid API エンドポイント
 */
export const HL_API_URL = HL_MAINNET 
  ? 'https://api.hyperliquid.xyz'
  : 'https://api.hyperliquid-testnet.xyz';

/**
 * SignerAdapter リクエストタイムアウト（ms）
 */
export const SIGNER_TIMEOUT_MS = 2500;

/**
 * SignerAdapter リトライ設定
 */
export const SIGNER_MAX_RETRIES = 3;
export const SIGNER_RETRY_DELAY_MS = 250;


// ESM: 個別export済み。必要ならまとめてexportも可。
export default {
  LIVE_ENABLED_COINS,
  SIGNER_ADAPTER_URL,
  HL_MAINNET,
  HL_API_URL,
  SIGNER_TIMEOUT_MS,
  SIGNER_MAX_RETRIES,
  SIGNER_RETRY_DELAY_MS,
};
