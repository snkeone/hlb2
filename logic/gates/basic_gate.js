export function evaluateBasicGates(snapshot, sensorSignals) {
  const allow = snapshot?.aResult?.allow === true && sensorSignals?.ready === true;
  return {
    allow,
    reason: allow ? 'gate_allow' : 'gate_blocked'
  };
}
