// core/healthState.js
// In-memory heartbeat tracker for feed stages. No external deps.

export const STAGES = {
  NETWORK: 'NETWORK',
  WS: 'WS',
  IO: 'IO',
  DECISION_A: 'decision_a',
  DECISION_B: 'decision_b',
  ENGINE: 'engine',
  UPDATE: 'update',
};

export const DEFAULT_THRESHOLDS = {
  [STAGES.NETWORK]: { warnMs: 15_000, ngMs: 30_000 },
  [STAGES.WS]: { warnMs: 15_000, ngMs: 30_000 },
  [STAGES.IO]: { warnMs: 20_000, ngMs: 40_000 },
  [STAGES.DECISION_A]: { warnMs: 25_000, ngMs: 45_000 },
  [STAGES.DECISION_B]: { warnMs: 25_000, ngMs: 45_000 },
  [STAGES.ENGINE]: { warnMs: 30_000, ngMs: 60_000 },
  [STAGES.UPDATE]: { warnMs: 30_000, ngMs: 60_000 },
};

const state = {};

function ensureStage(stage) {
  if (!state[stage]) {
    state[stage] = { stage, seq: 0, lastTs: 0, detail: null, error: null };
  }
  return state[stage];
}

export function updateHealth(stage, detail = null, error = null) {
  try {
    const entry = ensureStage(stage);
    entry.seq += 1;
    entry.lastTs = Date.now();
    entry.detail = detail ?? entry.detail;
    // 正常更新時は error をクリア
    entry.error = error ?? null;
  } catch (_) {
    // health 更新失敗で本体を止めない
  }
}

export function clearHealthError(stage) {
  const entry = ensureStage(stage);
  entry.error = null;
}

export function getHealthSnapshot() {
  for (const stage of Object.values(STAGES)) {
    if (!state[stage]) ensureStage(stage);
  }
  const snapshot = [];
  for (const key of Object.keys(state)) {
    const entry = state[key];
    snapshot.push({ ...entry });
  }
  return snapshot;
}

function resolveThreshold(stage, thresholds) {
  const fallback = DEFAULT_THRESHOLDS[stage] || { warnMs: 30_000, ngMs: 60_000 };
  if (!thresholds || typeof thresholds !== 'object') return fallback;
  const raw = thresholds[stage];
  const warnMs = Number(raw?.warnMs);
  const ngMs = Number(raw?.ngMs);
  return {
    warnMs: Number.isFinite(warnMs) ? warnMs : fallback.warnMs,
    ngMs: Number.isFinite(ngMs) ? ngMs : fallback.ngMs,
  };
}

export function buildHealthReport(thresholds = null) {
  const now = Date.now();
  const report = [];
  for (const stage of Object.values(STAGES)) {
    const entry = ensureStage(stage);
    const { warnMs, ngMs } = resolveThreshold(stage, thresholds);
    const ageMs = entry.lastTs ? now - entry.lastTs : null;
    let status = 'NA';
    if (entry.seq === 0 || !entry.lastTs) {
      status = 'NA';
    } else if (entry.error) {
      status = 'NG';
    } else if (ageMs != null && ageMs >= ngMs) {
      status = 'NG';
    } else if (ageMs != null && ageMs >= warnMs) {
      status = 'WARN';
    } else {
      status = 'OK';
    }
    report.push({
      stage,
      status,
      ageMs,
      seq: entry.seq,
      lastTs: entry.lastTs,
      detail: entry.detail ?? null,
      error: entry.error ?? null,
    });
  }
  return { now, stages: report };
}
