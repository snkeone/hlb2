import path from 'path';

/**
 * resolveStatePath
 * engine_state.json のパスを唯一の関数で決定
 * MODE（live/test/dry）を基準に、環境変数で上書き可能
 * @param {string} mode - 実行モード（process.env.MODE）
 * @param {string} envOverride - 環境変数 ENGINE_STATE_PATH（優先度最高）
 * @returns {string} 絶対パス
 */
export function resolveStatePath(mode = process.env.MODE, envOverride = process.env.ENGINE_STATE_PATH) {
  // 優先度1: 明示的な環境変数上書き
  if (envOverride && typeof envOverride === 'string' && envOverride.trim().length > 0) {
    return path.resolve(process.cwd(), envOverride.trim());
  }
  
  // 優先度2: mode 判定（唯一の真実）
  const isLive = mode === 'live';
  const filename = isLive ? 'engine_state.LIVE.json' : 'engine_state.TEST.json';
  
  return path.join(process.cwd(), 'ws', filename);
}
