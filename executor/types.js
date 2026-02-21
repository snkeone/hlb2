// Executor 型定義のみ（ロジック禁止）
// CommonJS でエクスポートします。

// ESM: 型定義はJSDocまたはTypeScriptで管理。必要ならexport typeでエクスポート。
/**
 * @typedef {Object} OrderResult
 * @property {string} orderId
 * @property {('filled'|'expired'|'rejected'|'error')} status
 * @property {('buy'|'sell')} side
 * @property {number} price
 * @property {number} size
 * @property {number} timestamp
 * @property {string=} error
 * @property {string=} signature
 * @property {number=} nonce
 * @property {string=} agentAddress
 */

/**
 * @typedef {Object} ExecutorError
 * @property {string} code
 * @property {string} message
 * @property {any=} cause
 */

/**
 * @typedef {Object} SafetyState
 * @property {('normal'|'halted')} mode
 * @property {ExecutorError=} lastError
 * @property {number=} lastUpdated
 */

// ESM: 型定義のみ。必要ならexport typeでTypeScript型もエクスポート可。
