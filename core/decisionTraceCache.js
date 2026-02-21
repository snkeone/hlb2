// core/decisionTraceCache.js
// decision_trace の最新スナップショットを保持（クラッシュ時の診断用）

let lastDecisionTrace = null;
let lastDecisionTraceAt = null;

export function setDecisionTraceSnapshot(payload) {
  try {
    lastDecisionTrace = payload ?? null;
    lastDecisionTraceAt = payload ? Date.now() : null;
  } catch (_) {
    // ここで例外が起きても致命的にはしない
  }
}

export function getDecisionTraceSnapshot() {
  if (!lastDecisionTrace) {
    return null;
  }
  return {
    ts: lastDecisionTraceAt,
    payload: lastDecisionTrace
  };
}
