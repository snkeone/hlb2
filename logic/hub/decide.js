import { collectSensorSignals } from '../sensors/snapshot_sensor.js';
import { collectPremiumSensor } from '../sensors/premium_sensor.js';
import { collectFlowImbalanceSensor } from '../sensors/flow_imbalance_sensor.js';
import { collectOiPriceTrapSensor } from '../sensors/oi_price_trap_sensor.js';
import { collectImpactSpreadSensor } from '../sensors/impact_spread_sensor.js';
import { collectOrbitSensor } from '../sensors/orbit_sensor.js';
import { collectLiquidationPressureSensor } from '../sensors/liquidation_pressure_sensor.js';
import { collectCtxSizeSensor } from '../sensors/ctx_size_sensor.js';
import { evaluateBasicGates } from '../gates/basic_gate.js';
import { planExecution } from '../execution/basic_execution.js';
import { applyIntegrationPolicy } from '../shared/policy_integration.js';

function validateInput(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, reason: 'invalid_snapshot' };
  }
  return { ok: true, reason: 'valid_snapshot' };
}

function createSideCommitter() {
  let committed = false;
  return (candidateSide) => {
    if (committed) {
      throw new Error('hub_side_already_committed');
    }
    committed = true;
    return candidateSide === 'buy' || candidateSide === 'sell' ? candidateSide : 'none';
  };
}

export function decide(snapshot, policy = {}) {
  const validation = validateInput(snapshot);
  if (!validation.ok) {
    return {
      side: 'none',
      reason: validation.reason,
      context: {
        validation,
        sensorSignals: null,
        premiumSignals: null,
        flowImbalanceSignals: null,
        oiPriceTrapSignals: null,
        impactSpreadSignals: null,
        orbitSignals: null,
        liquidationPressureSignals: null,
        ctxSizeSignals: null,
        gateResult: null,
        executionResult: null,
        integratedResult: null
      }
    };
  }

  const sensorSignals = collectSensorSignals(snapshot);
  const premiumSignals = collectPremiumSensor(snapshot?.market ?? {});
  const flowImbalanceSignals = collectFlowImbalanceSensor(snapshot?.ioMetrics ?? {}, snapshot?.tradeConfig ?? {});
  const oiPriceTrapSignals = collectOiPriceTrapSensor(snapshot, snapshot?.tradeConfig ?? {});
  const impactSpreadSignals = collectImpactSpreadSensor(snapshot?.market ?? {}, snapshot?.tradeConfig ?? {});
  const liquidationPressureSignals = collectLiquidationPressureSensor(snapshot, snapshot?.tradeConfig ?? {});
  const ctxSizeSignals = collectCtxSizeSensor(
    snapshot?.market ?? {},
    snapshot?.signal?.preferredSide ?? 'none',
    snapshot?.tradeConfig ?? {}
  );
  const orbitSignals = collectOrbitSensor(
    snapshot,
    snapshot?.aResult?.regime ?? 'NONE',
    snapshot?.signal?.preferredSide ?? 'none',
    snapshot?.executionSignals ?? {},
    snapshot?.tradeConfig ?? {}
  );
  const gateResult = evaluateBasicGates(snapshot, sensorSignals);
  const executionResult = planExecution(snapshot, sensorSignals, gateResult);
  const integratedResult = applyIntegrationPolicy(executionResult, policy);
  const commitSide = createSideCommitter();
  const side = commitSide(integratedResult.side);

  return {
    side,
    reason: integratedResult.reason,
    context: {
      validation,
      sensorSignals,
      premiumSignals,
      flowImbalanceSignals,
      oiPriceTrapSignals,
      impactSpreadSignals,
      orbitSignals,
      liquidationPressureSignals,
      ctxSizeSignals,
      gateResult,
      executionResult,
      integratedResult
    }
  };
}
