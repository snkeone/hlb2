import path from 'path';

/**
 * resolveTradesPath
 * trades.jsonl のパスを唯一の関数で決定
 * MODE（live/test/dry）を基準に、環境変数で上書き可能
 * @param {string} mode - 実行モード（process.env.MODE）
 * @param {string} envOverride - 環境変数 LOG_TRADES_PATH（優先度最高）
 * @returns {string} 絶対パス
 */
export function resolveTradesPath(mode = process.env.MODE, envOverride = process.env.LOG_TRADES_PATH) {
  // 優先度1: 明示的な環境変数上書き
  if (envOverride && typeof envOverride === 'string' && envOverride.trim().length > 0) {
    return path.resolve(process.cwd(), envOverride.trim());
  }

  // 優先度1.5: Jest実行時は運用/検証ログを汚染しない専用パスへ隔離
  if (process.env.JEST_WORKER_ID) {
    return path.resolve(process.cwd(), 'test-logs/jest/trades.jsonl');
  }
  
  // 優先度2: TEST_MODE=1 の場合は強制的に test 扱い
  if (process.env.TEST_MODE === '1') {
    mode = 'test';
  }
  
  // 優先度3: mode 判定（唯一の真実）
  const isLive = mode === 'live';
  const defaultPath = isLive ? 'logs/trades.jsonl' : 'test-logs/trades.jsonl';
  
  return path.resolve(process.cwd(), defaultPath);
}
