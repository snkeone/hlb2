function normalizeSide(value) {
  return value === 'buy' || value === 'sell' ? value : 'none';
}

export function applyIntegrationPolicy(executionResult, policy = {}) {
  const allowedSides = Array.isArray(policy.allowedSides) && policy.allowedSides.length > 0
    ? policy.allowedSides
    : ['buy', 'sell', 'none'];

  const normalizedExecutionSide = normalizeSide(executionResult?.side);
  const forcedSide = normalizeSide(policy.forceSide);

  if (forcedSide !== 'none') {
    return {
      side: forcedSide,
      reason: 'policy_forced_side',
      policyApplied: true,
      sourceSide: normalizedExecutionSide
    };
  }

  if (!allowedSides.includes(normalizedExecutionSide)) {
    return {
      side: 'none',
      reason: 'policy_side_blocked',
      policyApplied: true,
      sourceSide: normalizedExecutionSide
    };
  }

  return {
    side: normalizedExecutionSide,
    reason: executionResult?.reason ?? 'execution_result',
    policyApplied: true,
    sourceSide: normalizedExecutionSide
  };
}
