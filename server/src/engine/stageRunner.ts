import { join } from 'node:path';
import type { GateDecision, NodeRun, RunSnapshot, Stage, Workspace } from '@mat/shared';
import { appendEvent } from '../store/eventLog.js';
import { saveRun } from '../store/runs.js';
import { getWorkspace } from '../store/workspaces.js';
import { evaluateGate } from '../orchestrator/gate.js';
import { renderTemplate } from '../orchestrator/prompts.js';
import { assembleArtifacts, buildDigest } from './digest.js';
import { emitRetryBoundary, killActiveNode, registerNodeContext, runNode } from './nodeRunner.js';
import { collectPatch, createWorktree, isGitRepository, isWorkspaceDirty, runDirectory } from './worktree.js';

interface StageControl {
  stageId: string;
  gating: boolean;
  pendingRetry?: { promptAddendum?: string };
}

const controls = new Map<string, StageControl>();
const saveTails = new WeakMap<RunSnapshot, Promise<void>>();
const queuedRetryAddenda = new Map<string, string>();
const isAborted = (run: RunSnapshot): boolean => run.status === 'aborted';

export function queueStageRetryAddendum(runId: string, stageId: string, promptAddendum?: string): void {
  queuedRetryAddenda.set(`${runId}\0${stageId}`, promptAddendum ?? '');
}

export function requestActiveStageRetry(runId: string, stageId: string, promptAddendum?: string): boolean {
  const control = controls.get(runId);
  if (!control || control.stageId !== stageId || !control.gating) return false;
  control.pendingRetry = promptAddendum === undefined ? {} : { promptAddendum };
  killActiveNode(runId, 'orchestrator', 'gate-timeout');
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

async function executeNodes(run: RunSnapshot, stage: Stage, nodes: NodeRun[], workspace: Workspace, addenda: ReadonlyMap<string, string>): Promise<void> {
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
      },
    });
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < nodes.length && run.status !== 'aborted') {
      const node = nodes[cursor++];
      if (!node) return;
      const retryAddendum = addenda.get(node.nodeRunId) ?? '';
      if (node.attempt > 1) emitRetryBoundary(node);
      await runNode(node, stage, promptFor(run, stage, node, workspace, retryAddendum));
    }
  };
  await Promise.all(Array.from({ length: Math.min(run.workflow.maxParallel, nodes.length) }, () => worker()));
}

function resetForRetry(node: NodeRun): void {
  node.attempt += 1;
  node.status = 'queued';
  delete node.pid;
  delete node.startedAt;
  delete node.endedAt;
  delete node.resultText;
  delete node.patchFile;
  delete node.baseCommit;
  delete node.exitCode;
}

function appendDecision(run: RunSnapshot, decision: GateDecision): void {
  run.gateDecisions.push(decision);
  appendEvent(run.runId, {
    runId: run.runId,
    stageId: decision.stageId,
    nodeRunId: 'orchestrator',
    attempt: decision.gateAttempt,
    role: 'decision',
    kind: 'decision',
    text: decision.rationale,
    data: { ...decision },
  });
}

export async function runStage(run: RunSnapshot, stage: Stage): Promise<void> {
  const workspace = await getWorkspace(run.workspaceId);
  const nodes = stageNodes(run, stage);
  const control: StageControl = { stageId: stage.id, gating: false };
  controls.set(run.runId, control);
  run.currentStageId = stage.id;
  run.status = 'running';
  await persistRun(run);

  let selected = nodes.filter((node) => node.status === 'queued');
  const queuedAddendum = queuedRetryAddenda.get(`${run.runId}\0${stage.id}`);
  queuedRetryAddenda.delete(`${run.runId}\0${stage.id}`);
  let addenda = new Map(selected.map((node) => [node.nodeRunId, queuedAddendum ?? '']));
  try {
    while (selected.length > 0 && !isAborted(run)) {
      await executeNodes(run, stage, selected, workspace, addenda);
      if (isAborted(run)) return;

      const allFailed = nodes.every((node) => node.status === 'failed');
      if (allFailed && !run.workflow.orchestrator.enabled) {
        run.status = 'failed';
        run.endedAt = Date.now();
        await persistRun(run);
        return;
      }
      if (!stage.gate || !run.workflow.orchestrator.enabled) {
        run.status = 'running';
        await persistRun(run);
        return;
      }

      run.status = 'gating';
      control.gating = true;
      await persistRun(run);
      let decision = await evaluateGate(run, stage, buildDigest(nodes));
      control.gating = false;
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
      if (decision.action === 'retry' && decision.gateAttempt >= maxEvaluations) {
        const { retryNodeRunIds: _retryIds, promptAddendum: _addendum, ...rest } = decision;
        decision = {
          ...rest,
          action: 'advance',
          degraded: true,
          rationale: `${decision.rationale} Gate retry budget exhausted; advancing.`,
        };
      }
      if (decision.degraded) {
        systemEvent(run, stage.id, `Gate advanced in degraded mode: ${decision.rationale}`, { detail: 'gate-degraded' });
      }
      appendDecision(run, decision);
      await persistRun(run);

      if (decision.action === 'abort') {
        run.status = 'aborted';
        run.endedAt = Date.now();
        await persistRun(run);
        return;
      }
      if (decision.action === 'advance') {
        run.status = 'running';
        await persistRun(run);
        return;
      }

      const ids = new Set(decision.retryNodeRunIds ?? []);
      selected = nodes.filter((node) => ids.has(node.nodeRunId));
      addenda = new Map(selected.map((node) => [node.nodeRunId, decision.promptAddendum ?? '']));
      for (const node of selected) resetForRetry(node);
      run.status = 'running';
      await persistRun(run);
    }
  } finally {
    controls.delete(run.runId);
  }
}
