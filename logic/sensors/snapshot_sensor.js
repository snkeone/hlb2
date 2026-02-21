export function collectSensorSignals(snapshot) {
  const mid = Number(snapshot?.market?.midPx);
  const hasMid = Number.isFinite(mid);

  return {
    ready: hasMid,
    midPx: hasMid ? mid : null,
    reason: hasMid ? 'sensor_ready' : 'sensor_mid_missing'
  };
}
