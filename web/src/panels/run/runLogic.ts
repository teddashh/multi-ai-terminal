import type { AgentEvent, GateDecision, NodeRun, RunSnapshot, SteerMessage } from '@mat/shared';

export type NodeDisplayStatus = NodeRun['status'] | 'thinking';

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function elapsedForNode(node: NodeRun, now: number): number | undefined {
  if (node.startedAt === undefined) return undefined;
  return Math.max(0, (node.endedAt ?? now) - node.startedAt);
}

export function nodeDisplayStatus(node: NodeRun, latestEvent?: AgentEvent): NodeDisplayStatus {
  return node.status === 'running' && latestEvent?.kind === 'thinking' ? 'thinking' : node.status;
}

export interface DecisionDisplay {
  degraded: boolean;
  borderClass: string;
  actionClass: string;
  label: string;
}

export function decisionDisplay(decision: GateDecision): DecisionDisplay {
  const degraded = decision.degraded === true;
  return {
    degraded,
    borderClass: degraded ? 'border-amber-500/80' : 'border-emerald-500/70',
    actionClass: degraded ? 'text-amber-200' : 'text-emerald-200',
    label: degraded ? `${decision.action} · degraded` : decision.action,
  };
}

export function lastExecutedStageId(run: RunSnapshot): string | undefined {
  if (run.currentStageId && run.workflow.stages.some((stage) => stage.id === run.currentStageId)) return run.currentStageId;
  const latestDecision = [...run.gateDecisions].sort((a, b) => b.ts - a.ts)[0];
  if (latestDecision) return latestDecision.stageId;
  for (let index = run.workflow.stages.length - 1; index >= 0; index -= 1) {
    const stageId = run.workflow.stages[index]?.id;
    if (stageId && run.nodes.some((node) => node.stageId === stageId && (node.startedAt !== undefined || node.status !== 'queued'))) return stageId;
  }
  return undefined;
}

export function canRetryStage(run: RunSnapshot, stageId: string): boolean {
  const inValidityWindow = (run.status === 'gating' && run.currentStageId === stageId)
    || (['done', 'failed', 'aborted'].includes(run.status) && lastExecutedStageId(run) === stageId);
  if (!inValidityWindow) return false;
  const stage = run.workflow.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return false;
  if (stage.gate && run.workflow.orchestrator.enabled) {
    const evaluations = run.gateDecisions.filter((decision) => decision.stageId === stageId).length;
    return evaluations < 1 + run.workflow.maxRetriesPerStage;
  }
  const retries = Math.max(0, ...run.nodes.filter((candidate) => candidate.stageId === stageId).map((candidate) => candidate.attempt - 1));
  return retries < run.workflow.maxRetriesPerStage;
}

export function verificationSummary(nodes: readonly NodeRun[]): { passed: number; failed: number; skipped: number } {
  let passed = 0; let failed = 0; let skipped = 0;
  for (const node of nodes) {
    if (node.verification?.status === 'passed') passed += 1;
    else if (node.verification?.status === 'failed' || node.verification?.status === 'error') failed += 1;
    // An unconfigured workspace means the feature is off, not that a check was skipped.
    else if (node.verification?.status === 'skipped' && node.verification.reason !== 'no-verify-command') skipped += 1;
  }
  return { passed, failed, skipped };
}

export interface SteerGroup { steer: SteerMessage; nodes: NodeRun[]; decisions: GateDecision[] }

export function steerGroups(run: RunSnapshot): SteerGroup[] {
  return (run.steers ?? []).map((steer) => ({
    steer,
    nodes: steer.steerStageId ? run.nodes.filter((node) => node.stageId === steer.steerStageId) : [],
    decisions: steer.steerStageId ? run.gateDecisions.filter((decision) => decision.stageId === steer.steerStageId).sort((a, b) => a.gateAttempt - b.gateAttempt) : [],
  }));
}

export function canComposeSteer(run: RunSnapshot): boolean {
  return !['done', 'failed', 'aborted'].includes(run.status) && (run.steers?.length ?? 0) < 8;
}
