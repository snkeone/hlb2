export function planExecution(snapshot, sensorSignals, gateResult) {
  if (!gateResult?.allow) {
    return {
      side: 'none',
      reason: gateResult?.reason ?? 'gate_blocked'
    };
  }

  const preferredSide = snapshot?.signal?.preferredSide;
  const side = preferredSide === 'buy' || preferredSide === 'sell' ? preferredSide : 'none';

  return {
    side,
    reason: side === 'none' ? 'execution_no_preferred_side' : 'execution_side_selected'
  };
}
