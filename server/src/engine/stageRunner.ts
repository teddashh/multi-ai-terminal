import { join } from 'node:path';
import type { GateDecision, NodeRun, RunSnapshot, Stage, Workspace } from '@mat/shared';
import { appendEvent } from '../store/eventLog.js';
import { saveRun } from '../store/runs.js';
import { getWorkspace } from '../store/workspaces.js';
import { evaluateGate } from '../orchestrator/gate.js';
import { renderTemplate } from '../orchestrator/prompts.js';
import { diag } from '../diag.js';
import { assembleArtifacts, buildDigest } from './digest.js';
import { emitRetryBoundary, killActiveNode, registerNodeContext, resetNodeForRetry, runNode } from './nodeRunner.js';
import { collectPatch, createWorktree, isGitRepository, isWorkspaceDirty, runDirectory } from './worktree.js';
import { verifyCandidate } from './verify.js';

export interface StageControl {
  stageId: string;
  gating: boolean;
  pendingRetry?: { promptAddendum?: string };
  steerInterrupt?: boolean;
}

const controls = new Map<string, StageControl>();
const saveTails = new WeakMap<RunSnapshot, Promise<void>>();
const queuedRetryAddenda = new Map<string, string>();
const isAborted = (run: RunSnapshot): boolean => run.status === 'aborted';

export const hasPendingInterruptSteer = (run: RunSnapshot): boolean =>
  (run.steers ?? []).some((steer) => steer.status === 'pending' && steer.mode === 'interrupt');

export function requestSteerInterrupt(runId: string): boolean {
  const control = controls.get(runId);
  if (!control || control.gating) return false;
  control.steerInterrupt = true;
  return true;
}

// Which stage a steer actually cut short. steerRun's killed>0 marking misses the
// races (kill between node spawns, gate-ordered retry reset); runStage records
// the truth here and the steer cycle consumes it.
const steerInterruptedStages = new Map<string, string>();

export function takeSteerInterruptedStage(runId: string): string | undefined {
  const stageId = steerInterruptedStages.get(runId);
  steerInterruptedStages.delete(runId);
  return stageId;
}

export function clearSteerInterrupt(runId: string): void {
  steerInterruptedStages.delete(runId);
}

export function queueStageRetryAddendum(runId: string, stageId: string, promptAddendum?: string): void {
  queuedRetryAddenda.set(`${runId}\0${stageId}`, promptAddendum ?? '');
}

export function requestActiveStageRetry(runId: string, stageId: string, promptAddendum?: string): boolean {
  const control = controls.get(runId);
  if (!control || control.stageId !== stageId || !control.gating || control.pendingRetry) return false;
  control.pendingRetry = promptAddendum === undefined ? {} : { promptAddendum };
  killActiveNode(runId, 'orchestrator', 'user-retry');
  return true;
}

export async function persistRun(run: RunSnapshot): Promise<void> {
  const prior = saveTails.get(run) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => saveRun(run));
  saveTails.set(run, next);
  await next;
}

function systemEvent(run: RunSnapshot, stageId: string | null, text: string, data?: Record<string, unknown>): void {
  appendEvent(run.runId, {
    runId: run.runId,
    stageId,
    nodeRunId: null,
    attempt: 0,
    role: 'system',
    kind: 'status',
    text,
    ...(data ? { data } : {}),
  });
}

function stageNodes(run: RunSnapshot, stage: Stage): NodeRun[] {
  return run.nodes.filter((node) => node.stageId === stage.id);
}

function previousStageNodes(run: RunSnapshot, stage: Stage): NodeRun[] {
  const index = run.workflow.stages.findIndex((candidate) => candidate.id === stage.id);
  if (index <= 0) return [];
  const priorId = run.workflow.stages[index - 1]?.id;
  return run.nodes.filter((node) => node.stageId === priorId);
}

function promptFor(run: RunSnapshot, stage: Stage, node: NodeRun, workspace: Workspace, retryAddendum: string): string {
  const slot = stage.slots.find((candidate) => candidate.id === node.slotId);
  if (!slot) throw new Error(`Unknown slot ${node.slotId} in stage ${stage.id}`);
  const priorNodes = previousStageNodes(run, stage);
  const artifacts = assembleArtifacts(priorNodes);
  const orchestratorContext = [...run.gateDecisions].reverse().find((decision) => decision.contextForNext)?.contextForNext ?? '';
  node.handoff = {
    priorNodeRunIds: priorNodes.map((priorNode) => priorNode.nodeRunId),
    orchestratorContext: orchestratorContext !== '',
    retryAddendum: retryAddendum !== '',
  };
  return renderTemplate(slot.promptTemplate, {
    task: run.task,
    workspace_name: workspace.name,
    workspace_path: workspace.path,
    stage_name: stage.name,
    slot_label: slot.label,
    instance_index: node.instanceIndex,
    prior_stage_digest: buildDigest(priorNodes),
    orchestrator_context: orchestratorContext,
    retry_addendum: retryAddendum,
    patches: artifacts.patches,
    artifact_paths: artifacts.artifactPaths,
  });
}

export async function executeNodes(
  run: RunSnapshot,
  stage: Stage,
  nodes: NodeRun[],
  workspace: Workspace,
  addenda: ReadonlyMap<string, string>,
  promptOverride?: (node: NodeRun) => string,
): Promise<void> {
  const actuallyGit = workspace.isGit && await isGitRepository(workspace.path);
  if (stage.isolation === 'worktree' && !actuallyGit) {
    systemEvent(run, stage.id, 'Worktree isolation unavailable; running in the workspace.', { detail: 'non-git-workspace' });
  } else if (stage.isolation === 'worktree' && await isWorkspaceDirty(workspace.path)) {
    systemEvent(run, stage.id, 'Workspace is dirty; worktrees branch from HEAD and do not include uncommitted changes.', { detail: 'dirty-workspace' });
  }

  for (const node of nodes) {
    node.cwd = workspace.path;
    registerNodeContext(node, {
      runId: run.runId,
      getRunStatus: () => run.status,
      steerPending: () => hasPendingInterruptSteer(run),
      persist: async () => persistRun(run),
      prepare: async () => {
        if (stage.isolation !== 'worktree' || !actuallyGit) return;
        const result = await createWorktree(workspace.path, run.runId, node.nodeRunId, node.attempt);
        node.cwd = result.cwd;
        node.baseCommit = result.baseCommit;
        await persistRun(run);
      },
      finalize: async () => {
        if (stage.isolation !== 'worktree' || !actuallyGit || !node.baseCommit) return;
        const patchPath = join(runDirectory(run.runId), 'artifacts', `${node.nodeRunId}.a${node.attempt}.patch`);
        await collectPatch(node.cwd, node.baseCommit, patchPath);
        node.patchFile = patchPath;
        const verification = await verifyCandidate(node, workspace, run.runId);
        if (verification) node.verification = verification;
      },
    });
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < nodes.length && run.status !== 'aborted' && !hasPendingInterruptSteer(run)) {
      const node = nodes[cursor++];
      if (!node) return;
      if (isAborted(run) || node.status !== 'queued') continue;
      const retryAddendum = addenda.get(node.nodeRunId) ?? '';
      if (node.attempt > 1) emitRetryBoundary(node);
      await runNode(node, stage, promptOverride ? promptOverride(node) : promptFor(run, stage, node, workspace, retryAddendum));
    }
  };
  await Promise.all(Array.from({ length: Math.min(run.workflow.maxParallel, nodes.length) }, () => worker()));
}

export function appendDecision(run: RunSnapshot, decision: GateDecision, options: { engineForced?: boolean } = {}): void {
  run.gateDecisions.push(decision);
  appendEvent(run.runId, {
    runId: run.runId,
    // SPEC v1.1 §3.1 and §6 require orchestrator-identity events to use stageId:null.
    stageId: null,
    nodeRunId: 'orchestrator',
    attempt: decision.gateAttempt,
    role: 'decision',
    kind: 'decision',
    text: decision.rationale,
    data: { ...decision },
  });
  diag(run.runId, 'decision', {
    stageId: decision.stageId, action: decision.action, degraded: decision.degraded === true,
    ...(options.engineForced ? { engineForced: true } : {}),
  });
}

export async function runStage(run: RunSnapshot, stage: Stage): Promise<void> {
  const workspace = await getWorkspace(run.workspaceId);
  if (isAborted(run)) return;
  const nodes = stageNodes(run, stage);
  const control: StageControl = { stageId: stage.id, gating: false };
  controls.set(run.runId, control);
  run.currentStageId = stage.id;
  run.status = 'running';
  await persistRun(run);

  let selected = nodes.filter((node) => node.status === 'queued');
  diag(run.runId, 'stage', { stageId: stage.id, phase: 'start', selectedCount: selected.length });
  const queuedAddendum = queuedRetryAddenda.get(`${run.runId}\0${stage.id}`);
  queuedRetryAddenda.delete(`${run.runId}\0${stage.id}`);
  let addenda = new Map(selected.map((node) => [node.nodeRunId, queuedAddendum ?? '']));
  try {
    while (selected.length > 0 && !isAborted(run)) {
      if (hasPendingInterruptSteer(run)) {
        steerInterruptedStages.set(run.runId, stage.id);
        return;
      }
      await executeNodes(run, stage, selected, workspace, addenda);
      if (isAborted(run)) return;
      if (control.steerInterrupt || hasPendingInterruptSteer(run)) {
        delete control.steerInterrupt;
        if (nodes.some((node) => node.status === 'queued' || node.status === 'killed')) {
          steerInterruptedStages.set(run.runId, stage.id);
          return;
        }
        // The stage finished intact; run its gate and apply the steer at the boundary.
      }

      const allFailed = nodes.every((node) => node.status === 'failed');
      if (allFailed && !run.workflow.orchestrator.enabled) {
        run.status = 'failed';
        run.endedAt = Date.now();
        await persistRun(run);
        return;
      }
      if (!stage.gate) {
        run.status = 'running';
        await persistRun(run);
        return;
      }

      if (!run.workflow.orchestrator.enabled) {
        const gateAttempt = run.gateDecisions.filter((candidate) => candidate.stageId === stage.id).length + 1;
        appendDecision(run, {
          stageId: stage.id,
          gateAttempt,
          action: 'advance',
          rationale: 'Gate auto-advanced: orchestrator disabled',
          degraded: false,
          ts: Date.now(),
        });
        run.status = 'running';
        await persistRun(run);
        return;
      }

      run.status = 'gating';
      control.gating = true;
      await persistRun(run);
      let decision = await evaluateGate(run, stage, buildDigest(nodes));
      let engineForced = false;
      if (isAborted(run)) return;
      const maxEvaluations = 1 + run.workflow.maxRetriesPerStage;
      const manual = control.pendingRetry;
      delete control.pendingRetry;
      if (manual && decision.gateAttempt <= maxEvaluations) {
        decision = {
          stageId: stage.id,
          gateAttempt: decision.gateAttempt,
          action: 'retry',
          retryNodeRunIds: nodes.map((node) => node.nodeRunId),
          ...(manual.promptAddendum !== undefined ? { promptAddendum: manual.promptAddendum } : {}),
          rationale: 'Stage retry requested by the user.',
          ts: Date.now(),
        };
      }
      const failedVerificationNodes = nodes.filter((node) => node.verification?.status === 'failed' || node.verification?.status === 'error');
      if (stage.requireVerified && decision.action === 'advance' && failedVerificationNodes.length > 0
        && !nodes.some((node) => node.verification?.status === 'passed')) {
        decision = {
          ...decision,
          action: 'retry',
          retryNodeRunIds: failedVerificationNodes.map((node) => node.nodeRunId),
          rationale: `${decision.rationale} [engine] requireVerified: no candidate passed verification; retrying failing candidates.`,
        };
        engineForced = true;
        diag(run.runId, 'decision', { stageId: stage.id, action: 'retry', degraded: false, engineForced: true, detail: 'requireVerified' });
      }
      if (decision.action === 'retry' && decision.gateAttempt >= maxEvaluations) {
        const { retryNodeRunIds: _retryIds, promptAddendum: _addendum, ...rest } = decision;
        decision = {
          ...rest,
          action: 'advance',
          degraded: true,
          rationale: `${decision.rationale} Gate retry budget exhausted; advancing.`,
        };
        engineForced = true;
      }
      if (decision.degraded) {
        systemEvent(run, stage.id, `Gate advanced in degraded mode: ${decision.rationale}`, { detail: 'gate-degraded' });
      }
      appendDecision(run, decision, { engineForced });
      if (decision.action === 'abort') {
        run.status = 'aborted';
        run.endedAt = Date.now();
        control.gating = false;
        await persistRun(run);
        return;
      }
      if (decision.action === 'advance') {
        run.status = 'running';
        control.gating = false;
        await persistRun(run);
        return;
      }

      const ids = new Set(decision.retryNodeRunIds ?? []);
      selected = nodes.filter((node) => ids.has(node.nodeRunId));
      addenda = new Map(selected.map((node) => [node.nodeRunId, decision.promptAddendum ?? '']));
      for (const node of selected) resetNodeForRetry(node);
      run.status = 'running';
      control.gating = false;
      await persistRun(run);
    }
  } finally {
    diag(run.runId, 'stage', { stageId: stage.id, phase: 'end', selectedCount: selected.length });
    controls.delete(run.runId);
  }
}
