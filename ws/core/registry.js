/**
 * Core Registry
 * 目的:
 * - モード × HL_ENABLE に応じたコアの存在宣言を行い
 * - 起動時にロード結果レポートを作成する
 *
 * 設計原則:
 * - optional なコアは未定義でも正常ルート
 * - required のコアが missing のときのみ severity=ERROR
 * - 「存在しない」を仕様として扱う
 */

const CORE_DECL = {
  live: [
    { id: 'wsStatus', required: true, state: 'loaded', reason: 'core' },
    { id: 'marketFeed', required: false, needsHl: true },
    { id: 'decisionEngine', required: false, needsHl: false },
    { id: 'tradeExecutor', required: false, needsHl: true }
  ],
  test: [
    { id: 'wsStatus', required: true, state: 'loaded', reason: 'core' },
    { id: 'marketFeed', required: false, needsHl: true },
    { id: 'decisionEngine', required: false, needsHl: false },
    { id: 'tradeExecutor', required: false, needsHl: false }
  ],
  dry: [
    { id: 'wsStatus', required: true, state: 'loaded', reason: 'core' },
    { id: 'marketFeed', required: false, needsHl: false },
    { id: 'decisionEngine', required: false, needsHl: false },
    { id: 'tradeExecutor', required: false, needsHl: false }
  ],
  ui: [
    { id: 'wsStatus', required: true, state: 'loaded', reason: 'core' },
    { id: 'marketFeed', required: false, needsHl: false },
    { id: 'decisionEngine', required: false, needsHl: false },
    { id: 'tradeExecutor', required: false, needsHl: false }
  ]
};

function resolveMode(mode, hlEnabled) {
  const m = (mode || '').toLowerCase();
  if (m === 'live' || m === 'test' || m === 'dry' || m === 'ui') return m;
  if (!hlEnabled) return 'dry';
  if (process.env.TEST_MODE === '1') return 'test';
  return 'live';
}

function buildRegistryReport(modeInput, hlEnabled) {
  const mode = resolveMode(modeInput, hlEnabled);
  const decl = CORE_DECL[mode] || CORE_DECL.live;
  const cores = [];
  let hasError = false;

  for (const core of decl) {
    if (core.needsHl && !hlEnabled) {
      cores.push({
        id: core.id,
        required: core.required,
        state: 'disabled',
        reason: 'HL_ENABLE=0'
      });
      continue;
    }
    if (core.state === 'loaded') {
      cores.push({
        id: core.id,
        required: core.required,
        state: 'loaded',
        reason: core.reason || 'core'
      });
      continue;
    }
    cores.push({
      id: core.id,
      required: core.required,
      state: 'missing',
      reason: core.required ? 'not loaded' : 'optional not loaded'
    });
    if (core.required) hasError = true;
  }

  const severity = hasError ? 'ERROR' : 'OK';
  const missingRequired = cores.filter(c => c.required && c.state !== 'loaded');
  const hint = hasError
    ? `missing core: ${missingRequired.map(c => c.id).join(',')}`
    : 'cores loaded/disabled as declared';

  return {
    mode,
    hlEnabled,
    severity,
    hint,
    cores
  };
}

export { buildRegistryReport, resolveMode };
