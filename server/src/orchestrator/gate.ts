import type { GateDecision, RunSnapshot, Stage } from '@mat/shared';
export async function evaluateGate(_run: RunSnapshot, _stage: Stage, _digest: string): Promise<GateDecision> { throw new Error('NOT_IMPLEMENTED: orchestrator/gate'); }
