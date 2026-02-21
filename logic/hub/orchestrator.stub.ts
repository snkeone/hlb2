import { evaluateAbsorptionStub } from '../sensors/absorption.stub.ts';

export function orchestrateStub(): { sensorReady: true } {
  const result = evaluateAbsorptionStub();
  return { sensorReady: result.ready };
}
