import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import {
  TERMINAL_NODE_STATUSES,
  WorkflowDefSchema,
  type ApplyPatchResponse,
  type NodeRun,
  type RetryStageRequest,
  type RunCreateRequest,
  type RunSnapshot,
  type SteerMessage,
  type SteerRequest,
  type WorkflowDef,
} from '@mat/shared';
import { appendEvent, readEventsAfter } from '../store/eventLog.js';
import { getRun, listRuns, saveRun } from '../store/runs.js';
import { listWorkflows } from '../store/workflows.js';
import { getWorkspace } from '../store/workspaces.js';
import { execFile } from '../execFile.js';
import { terminateProcessGroup } from '../spawn.js';
import { diag } from '../diag.js';
import { EngineConflictError, EngineNotFoundError } from './errors.js';
import { killActiveNode, killAllActiveNodes, markNodeKilled, resetNodeForRetry } from './nodeRunner.js';
import { clearSteerInterrupt, persistRun, queueStageRetryAddendum, requestActiveStageRetry, requestSteerInterrupt, runStage } from './stageRunner.js';
import { expireSteers, runSteerCycle, type SteerOutcome } from './steer.js';
import { isGitRepository, pruneWorktrees, runDirectory, workspaceForRun } from './worktree.js';

const activeRuns = new Map<string, RunSnapshot>();
const executions = new Map<string, Promise<void>>();
const runMutationTails = new Map<string, Promise<void>>();
const workspaceApplyTails = new Map<string, Promise<void>>();
const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'aborted']);
const executionStopped = (run: RunSnapshot): boolean => run.status === 'aborted' || run.status === 'failed';

async function withMutex<T>(tails: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const prior = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => gate);
  tails.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

const withRunMutation = <T>(runId: string, operation: () => Promise<T>): Promise<T> => withMutex(runMutationTails, runId, operation);

function systemEvent(run: RunSnapshot, kind: 'status' | 'error', text: string, data?: Record<string, unknown>): void {
  appendEvent(run.runId, {
    runId: run.runId,
    stageId: null,
    nodeRunId: null,
    attempt: 0,
    role: 'system',
    kind,
    text,
    ...(data ? { data } : {}),
  }, { trustedData: true });
}

function validateWorkflowIdentity(workflow: WorkflowDef): void {
  const stages = new Set<string>();
  const nodeIds = new Set<string>();
  for (const stage of workflow.stages) {
    if (stages.has(stage.id)) throw new Error(`Duplicate stage id: ${stage.id}`);
    if (stage.id.startsWith('steer-')) throw new Error(`Stage id ${stage.id} is reserved for steering`);
    stages.add(stage.id);
    const slots = new Set<string>();
    for (const slot of stage.slots) {
      if (slots.has(slot.id)) throw new Error(`Duplicate slot id ${slot.id} in stage ${stage.id}`);
      slots.add(slot.id);
      for (let index = 0; index < slot.count; index += 1) {
        const id = `${stage.id}.${slot.id}.${index}`;
        if (nodeIds.has(id) || id === 'orchestrator') throw new Error(`Duplicate nodeRunId: ${id}`);
        nodeIds.add(id);
      }
    }
  }
}

function buildNodes(workflow: WorkflowDef, workspacePath: string): NodeRun[] {
  const nodes: NodeRun[] = [];
  for (const stage of workflow.stages) {
    for (const slot of stage.slots) {
      for (let index = 0; index < slot.count; index += 1) {
        nodes.push({
          nodeRunId: `${stage.id}.${slot.id}.${index}`,
          stageId: stage.id,
          slotId: slot.id,
          instanceIndex: index,
          agent: structuredClone(slot.agent),
          label: `${slot.label} · ${slot.agent.provider}`,
          status: 'queued',
          attempt: 1,
          cwd: workspacePath,
        });
      }
    }
  }
  if (workflow.orchestrator.enabled) {
    nodes.push({
      nodeRunId: 'orchestrator',
      stageId: null,
      slotId: 'orchestrator',
      instanceIndex: 0,
      agent: structuredClone(workflow.orchestrator.agent),
      label: `Orchestrator · ${workflow.orchestrator.agent.provider}`,
      status: 'queued',
      attempt: 1,
      cwd: workspacePath,
    });
  }
  return nodes;
}

async function resolvedWorkflow(req: RunCreateRequest): Promise<WorkflowDef> {
  const source = req.workflowOverride ?? (await listWorkflows()).find((workflow) => workflow.id === req.workflowId);
  if (!source) throw new Error(`Workflow not found: ${req.workflowId}`);
  const workflow = WorkflowDefSchema.parse(structuredClone(source)) as WorkflowDef;
  validateWorkflowIdentity(workflow);
  return workflow;
}

async function executeRun(run: RunSnapshot, startIndex = 0): Promise<void> {
  activeRuns.set(run.runId, run);
  try {
    let lastStageId: string | undefined;
    for (let index = startIndex; index < run.workflow.stages.length;) {
      if (executionStopped(run)) return;
      const stage = run.workflow.stages[index];
      if (!stage) break;
      await runStage(run, stage);
      lastStageId = stage.id;
      if (executionStopped(run)) return;
      let outcome: SteerOutcome | undefined;
      for (;;) {
        const steer = (run.steers ?? []).find((candidate) => candidate.status === 'pending');
        if (!steer) break;
        outcome = await runSteerCycle(run, steer, stage);
        if (outcome === 'abort') return;
        if (outcome === 'redo') break;
      }
      if (outcome === 'redo') continue;
      index += 1;
    }
    if (run.status !== 'aborted' && run.status !== 'failed') {
      // A trailing steer leaves currentStageId on its synthetic stage; terminal
      // stage retry resolves against the last real workflow stage.
      if (lastStageId !== undefined && run.currentStageId?.startsWith('steer-')) run.currentStageId = lastStageId;
      run.status = 'done';
      run.endedAt = Date.now();
      systemEvent(run, 'status', 'Run completed.', { status: 'done' });
      await persistRun(run);
    }
  } catch (error) {
    if (run.status === 'aborted') return;
    run.status = 'failed';
    run.endedAt = Date.now();
    const detail = error instanceof Error ? error.message : String(error);
    diag(run.runId, 'error', { message: detail, ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) });
    systemEvent(run, 'error', `Run failed: ${detail}`);
    await persistRun(run);
  } finally {
    try {
      if (TERMINAL_RUN_STATUSES.has(run.status)) await expireSteers(run);
    } finally {
      clearSteerInterrupt(run.runId);
      if (activeRuns.get(run.runId) === run) activeRuns.delete(run.runId);
    }
  }
}

function startExecution(run: RunSnapshot, startIndex = 0): void {
  if (executions.has(run.runId)) throw new EngineConflictError(`Run ${run.runId} already has an active or scheduled execution`);
  const execution = executeRun(run, startIndex)
    .finally(() => {
      if (executions.get(run.runId) === execution) executions.delete(run.runId);
    });
  executions.set(run.runId, execution);
  void execution.catch(() => undefined);
}

export async function createRun(req: RunCreateRequest, providerVersions?: Record<string, string>): Promise<RunSnapshot> {
  const workspace = await getWorkspace(req.workspaceId);
  const workflow = await resolvedWorkflow(req);
  const run: RunSnapshot = {
    runId: `r_${nanoid()}`,
    workspaceId: workspace.id,
    workspaceSnapshot: {
      name: workspace.name,
      path: workspace.path,
      isGit: workspace.isGit,
      ...(workspace.verifyCommand ? { verifyCommand: workspace.verifyCommand } : {}),
      ...(workspace.verifyTimeoutSec !== undefined ? { verifyTimeoutSec: workspace.verifyTimeoutSec } : {}),
    },
    workflow,
    task: req.task,
    status: 'created',
    nodes: buildNodes(workflow, workspace.path),
    gateDecisions: [],
    ...(providerVersions && Object.keys(providerVersions).length > 0 ? { providerVersions: structuredClone(providerVersions) } : {}),
    createdAt: Date.now(),
  };
  return withRunMutation(run.runId, async () => {
    await saveRun(run);
    diag(run.runId, 'run', { action: 'create', status: run.status, workspaceId: run.workspaceId });
    activeRuns.set(run.runId, run);
    startExecution(run);
    return structuredClone(run);
  });
}

export async function abortRun(runId: string): Promise<void> {
  await withRunMutation(runId, async () => {
    const run = activeRuns.get(runId) ?? await getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    run.status = 'aborted';
    run.endedAt = Date.now();
    for (const node of run.nodes) {
      if (node.status === 'queued') markNodeKilled(node, runId, 'abort');
    }
    killAllActiveNodes(runId, 'abort');
    systemEvent(run, 'status', 'Run aborted by user.', { status: 'aborted' });
    diag(run.runId, 'run', { action: 'abort', status: run.status });
    await persistRun(run);
    const execution = executions.get(runId);
    if (execution) await execution.catch(() => undefined);
  });
}

export async function steerRun(runId: string, req: SteerRequest): Promise<RunSnapshot> {
  return withRunMutation(runId, async () => {
    const run = activeRuns.get(runId) ?? await getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) throw new EngineConflictError(`Run ${runId} is terminal`);
    if ((run.steers ?? []).length >= 8) throw new EngineConflictError('A run accepts at most 8 steer messages');
    const steer: SteerMessage = {
      steerId: `s_${nanoid()}`, text: req.text, mode: req.mode ?? 'interrupt', status: 'pending', createdAt: Date.now(),
    };
    (run.steers ??= []).push(steer);
    appendEvent(run.runId, {
      runId: run.runId, stageId: null, nodeRunId: null, attempt: 0, role: 'user', kind: 'message', text: steer.text,
      data: { detail: 'steer', steerId: steer.steerId, mode: steer.mode },
    }, { trustedData: true });
    diag(run.runId, 'steer', { steerId: steer.steerId, transition: 'pending', mode: steer.mode });
    if (steer.mode === 'interrupt' && run.status === 'running') {
      requestSteerInterrupt(runId);
      const killed = killAllActiveNodes(runId, 'steer');
      if (killed > 0) steer.interruptedStageId = run.currentStageId ?? null;
    }
    await persistRun(run);
    return structuredClone(run);
  });
}

export async function killNode(runId: string, nodeRunId: string): Promise<void> {
  const run = activeRuns.get(runId) ?? await getRun(runId);
  const node = run.nodes.find((candidate) => candidate.nodeRunId === nodeRunId);
  if (!node) throw new EngineNotFoundError(`Node not found: ${nodeRunId}`);
  if (TERMINAL_NODE_STATUSES.includes(node.status as (typeof TERMINAL_NODE_STATUSES)[number])) {
    throw new EngineConflictError(`Node has already finished: ${nodeRunId}`);
  }
  if (node.status === 'queued') {
    markNodeKilled(node, runId, 'user');
    await persistRun(run);
    return;
  }
  if (!killActiveNode(runId, nodeRunId, 'user')) throw new EngineConflictError(`Node is no longer running: ${nodeRunId}`);
}

export async function retryStage(runId: string, stageId: string, req: RetryStageRequest): Promise<RunSnapshot> {
  if (runMutationTails.has(runId)) throw new EngineConflictError(`Run ${runId} already has a mutation in progress`);
  return withRunMutation(runId, async () => {
    let run = activeRuns.get(runId);
    if (!run) {
      run = await getRun(runId);
      activeRuns.set(runId, run);
    }
    const stageIndex = run.workflow.stages.findIndex((stage) => stage.id === stageId);
    if (stageIndex < 0) throw new EngineNotFoundError(`Stage not found: ${stageId}`);
    const stage = run.workflow.stages[stageIndex];
    if (!stage) throw new EngineNotFoundError(`Stage not found: ${stageId}`);
    const decisionCount = run.gateDecisions.filter((decision) => decision.stageId === stageId).length;
    const maxEvaluations = 1 + run.workflow.maxRetriesPerStage;

    if (run.status === 'gating' && run.currentStageId === stageId) {
      if (decisionCount >= run.workflow.maxRetriesPerStage) throw new EngineConflictError('Stage gate retry budget is exhausted');
      if (!requestActiveStageRetry(runId, stageId, req.promptAddendum)) throw new EngineConflictError('Stage is no longer accepting a retry');
      return structuredClone(run);
    }

    if (!TERMINAL_RUN_STATUSES.has(run.status) || run.currentStageId !== stageId) {
      throw new EngineConflictError('A stage can be retried only while it is gating, or when it was the last stage executed in a terminal run');
    }
    // The run is terminal, but the execution promise may still be settling its
    // cleanup; wait for it instead of surfacing a spurious conflict.
    const settling = executions.get(runId);
    if (settling) await settling.catch(() => undefined);
    if (executions.has(runId)) throw new EngineConflictError(`Run ${runId} already has an active or scheduled execution`);
    const nodes = run.nodes.filter((node) => node.stageId === stageId);
    if (stage.gate && run.workflow.orchestrator.enabled) {
      if (decisionCount >= maxEvaluations) throw new EngineConflictError('Stage gate retry budget is exhausted');
    } else {
      const priorManualRetries = Math.max(0, ...nodes.map((node) => node.attempt - 1));
      if (priorManualRetries >= run.workflow.maxRetriesPerStage) throw new EngineConflictError('Stage retry budget is exhausted');
    }
    for (const node of nodes) resetNodeForRetry(node);
    const laterStageIds = new Set(run.workflow.stages.slice(stageIndex + 1).map((stage) => stage.id));
    for (const node of run.nodes) {
      if (node.stageId !== null && laterStageIds.has(node.stageId) && node.status === 'killed') node.status = 'queued';
    }
    queueStageRetryAddendum(runId, stageId, req.promptAddendum);
    run.status = 'running';
    delete run.endedAt;
    await saveRun(run);
    diag(run.runId, 'run', { action: 'retry', stageId, status: run.status });
    startExecution(run, stageIndex);
    return structuredClone(run);
  });
}

function conflictsFromOutput(output: string): string[] {
  const conflicts = new Set<string>();
  for (const line of output.split('\n')) {
    const value = line.trim();
    const match =
      /^error:\s+(.+?):\s+(?:does not match index|patch does not apply)$/i.exec(value)
      ?? /^error:\s+patch failed:\s+(.+?)(?::\d+)?$/i.exec(value)
      ?? /(?:conflict(?:s)?(?: in)?|with conflicts?)[^A-Za-z0-9._/-]*['"]?([^'"]+?)['"]?$/i.exec(value);
    if (match?.[1]) conflicts.add(match[1].trim());
  }
  return [...conflicts];
}

export async function applyPatch(runId: string, nodeRunId: string): Promise<ApplyPatchResponse> {
  const run = activeRuns.get(runId) ?? await getRun(runId);
  const node = run.nodes.find((candidate) => candidate.nodeRunId === nodeRunId);
  if (!node) throw new EngineNotFoundError(`Node not found: ${nodeRunId}`);
  const patchFile = node.patchFile ?? join(runDirectory(runId), 'artifacts', `${node.nodeRunId}.a${node.attempt}.patch`);
  if (!existsSync(patchFile)) return { ok: false, message: 'No captured patch is available for this node.' };
  const workspace = await workspaceForRun(run);
  if (!workspace.isGit || !await isGitRepository(workspace.path)) return { ok: false, message: 'Patches can only be applied to a Git workspace.' };
  return withMutex(workspaceApplyTails, workspace.id, async () => {
    try {
      await execFile('git', ['-C', workspace.path, 'apply', '--check', '--3way', '--binary', patchFile]);
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; message?: string };
      let output = `${value.stdout ?? ''}\n${value.stderr ?? ''}`.trim();
      const unsupportedDetail = `${output}\n${value.message ?? ''}`;
      const unsupportedCombination = unsupportedDetail.includes('--check') && unsupportedDetail.includes('--3way')
        && /does not work|cannot be used together|incompatible/i.test(unsupportedDetail);
      if (unsupportedCombination) {
        try {
          await execFile('git', ['-C', workspace.path, 'apply', '--check', '--binary', patchFile]);
        } catch (fallbackError) {
          const fallback = fallbackError as { stdout?: string; stderr?: string; message?: string };
          output = `${fallback.stdout ?? ''}\n${fallback.stderr ?? ''}`.trim();
          const conflicts = conflictsFromOutput(output);
          return { ok: false, ...(conflicts.length ? { conflicts } : {}), message: output || fallback.message || 'Patch validation failed.' };
        }
      } else {
        const conflicts = conflictsFromOutput(output);
        return { ok: false, ...(conflicts.length ? { conflicts } : {}), message: output || value.message || 'Patch validation failed.' };
      }
    }
    try {
      await execFile('git', ['-C', workspace.path, 'apply', '--3way', '--binary', patchFile]);
      return { ok: true, message: 'Patch applied.' };
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; message?: string };
      const output = `${value.stdout ?? ''}\n${value.stderr ?? ''}`.trim();
      const conflicts = conflictsFromOutput(output);
      return { ok: false, ...(conflicts.length ? { conflicts } : {}), message: output || value.message || 'Patch application failed.' };
    }
  });
}

export async function sweepOnBoot(): Promise<void> {
  const runs = await listRuns(undefined, Number.MAX_SAFE_INTEGER);
  for (const run of runs) {
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    for (const node of run.nodes) {
      if (node.pid) terminateProcessGroup(node.pid);
      if (node.status === 'running' || node.status === 'stalled') {
        node.status = 'killed';
        node.endedAt = Date.now();
      }
      delete node.pid;
    }
    try { await pruneWorktrees(run.runId); } catch { /* Recovery continues even when git metadata is damaged. */ }
    run.status = 'aborted';
    run.endedAt = Date.now();
    const events = readEventsAfter(run.runId, 0, Number.MAX_SAFE_INTEGER);
    const tail = events.at(-1);
    if (!(tail?.kind === 'status' && tail.data?.detail === 'server-restart' && tail.runId === run.runId)) {
      systemEvent(run, 'status', 'Run aborted during server restart recovery.', { status: 'aborted', detail: 'server-restart' });
    }
    for (const steer of run.steers ?? []) {
      if (steer.status !== 'pending' && steer.status !== 'active') continue;
      steer.status = 'expired';
      systemEvent(run, 'status', `Steer ${steer.steerId} expired during server restart recovery.`, { detail: 'steer-expired', steerId: steer.steerId });
      diag(run.runId, 'steer', { steerId: steer.steerId, transition: 'expired', mode: steer.mode, ...(steer.interruptedStageId !== undefined ? { interruptedStageId: steer.interruptedStageId } : {}) });
    }
    diag(run.runId, 'run', { action: 'boot-sweep', status: run.status });
    await saveRun(run);
  }
}

const signalMarker = Symbol.for('mat.engine.signal-handler');
const processWithMarker = process as NodeJS.Process & { [signalMarker]?: boolean };
if (!processWithMarker[signalMarker]) {
  processWithMarker[signalMarker] = true;
  process.prependListener('SIGTERM', () => { killAllActiveNodes(undefined, 'abort'); });
  process.prependListener('SIGINT', () => { killAllActiveNodes(undefined, 'abort'); });
}
