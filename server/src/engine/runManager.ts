import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import {
  TERMINAL_NODE_STATUSES,
  WorkflowDefSchema,
  type ApplyPatchResponse,
  type NodeRun,
  type RetryStageRequest,
  type RunCreateRequest,
  type RunSnapshot,
  type WorkflowDef,
} from '@mat/shared';
import { appendEvent } from '../store/eventLog.js';
import { getRun, listRuns, saveRun } from '../store/runs.js';
import { listWorkflows } from '../store/workflows.js';
import { getWorkspace } from '../store/workspaces.js';
import { killActiveNode, killAllActiveNodes } from './nodeRunner.js';
import { persistRun, queueStageRetryAddendum, requestActiveStageRetry, runStage } from './stageRunner.js';
import { isGitRepository, pruneWorktrees, runDirectory } from './worktree.js';

const execFileAsync = promisify(execFile);
const activeRuns = new Map<string, RunSnapshot>();
const executions = new Map<string, Promise<void>>();
const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'aborted']);

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
  });
}

function validateWorkflowIdentity(workflow: WorkflowDef): void {
  const stages = new Set<string>();
  const nodeIds = new Set<string>();
  for (const stage of workflow.stages) {
    if (stages.has(stage.id)) throw new Error(`Duplicate stage id: ${stage.id}`);
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
    for (let index = startIndex; index < run.workflow.stages.length; index += 1) {
      if (run.status === 'aborted' || run.status === 'failed') return;
      const stage = run.workflow.stages[index];
      if (!stage) break;
      await runStage(run, stage);
    }
    if (run.status !== 'aborted' && run.status !== 'failed') {
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
    systemEvent(run, 'error', `Run failed: ${detail}`);
    await persistRun(run);
  } finally {
    activeRuns.delete(run.runId);
  }
}

function startExecution(run: RunSnapshot, startIndex = 0): void {
  const previous = executions.get(run.runId);
  const execution = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => executeRun(run, startIndex))
    .finally(() => {
      if (executions.get(run.runId) === execution) executions.delete(run.runId);
    });
  executions.set(run.runId, execution);
  void execution.catch(() => undefined);
}

export async function createRun(req: RunCreateRequest): Promise<RunSnapshot> {
  const workspace = await getWorkspace(req.workspaceId);
  const workflow = await resolvedWorkflow(req);
  const run: RunSnapshot = {
    runId: `r_${nanoid()}`,
    workspaceId: workspace.id,
    workflow,
    task: req.task,
    status: 'created',
    nodes: buildNodes(workflow, workspace.path),
    gateDecisions: [],
    createdAt: Date.now(),
  };
  await saveRun(run);
  queueMicrotask(() => startExecution(run));
  return structuredClone(run);
}

export async function abortRun(runId: string): Promise<void> {
  const run = activeRuns.get(runId) ?? await getRun(runId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return;
  run.status = 'aborted';
  run.endedAt = Date.now();
  for (const node of run.nodes) {
    if (node.status === 'queued') {
      node.status = 'killed';
      node.endedAt = Date.now();
    }
  }
  killAllActiveNodes(runId, 'abort');
  systemEvent(run, 'status', 'Run aborted by user.', { status: 'aborted' });
  await persistRun(run);
  const execution = executions.get(runId);
  if (execution) await execution.catch(() => undefined);
}

export async function killNode(runId: string, nodeRunId: string): Promise<void> {
  const run = activeRuns.get(runId) ?? await getRun(runId);
  const node = run.nodes.find((candidate) => candidate.nodeRunId === nodeRunId);
  if (!node) throw new Error(`Node not found: ${nodeRunId}`);
  if (TERMINAL_NODE_STATUSES.includes(node.status as (typeof TERMINAL_NODE_STATUSES)[number])) return;
  if (!killActiveNode(runId, nodeRunId, 'user')) throw new Error(`Node is not currently running: ${nodeRunId}`);
}

function clearAttempt(node: NodeRun): void {
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

export async function retryStage(runId: string, stageId: string, req: RetryStageRequest): Promise<RunSnapshot> {
  const run = activeRuns.get(runId) ?? await getRun(runId);
  const stageIndex = run.workflow.stages.findIndex((stage) => stage.id === stageId);
  if (stageIndex < 0) throw new Error(`Stage not found: ${stageId}`);
  const stage = run.workflow.stages[stageIndex];
  if (!stage) throw new Error(`Stage not found: ${stageId}`);
  const decisionCount = run.gateDecisions.filter((decision) => decision.stageId === stageId).length;
  const maxEvaluations = 1 + run.workflow.maxRetriesPerStage;

  if (run.status === 'gating' && run.currentStageId === stageId) {
    if (decisionCount >= run.workflow.maxRetriesPerStage) throw new Error('Stage gate retry budget is exhausted');
    if (!requestActiveStageRetry(runId, stageId, req.promptAddendum)) throw new Error('Stage is no longer accepting a retry');
    return structuredClone(run);
  }

  if (!TERMINAL_RUN_STATUSES.has(run.status) || run.currentStageId !== stageId) {
    throw new Error('A stage can be retried only while it is gating, or when it was the last stage executed in a terminal run');
  }
  const nodes = run.nodes.filter((node) => node.stageId === stageId);
  if (stage.gate && run.workflow.orchestrator.enabled) {
    if (decisionCount >= maxEvaluations) throw new Error('Stage gate retry budget is exhausted');
  } else {
    const priorManualRetries = Math.max(0, ...nodes.map((node) => node.attempt - 1));
    if (priorManualRetries >= run.workflow.maxRetriesPerStage) throw new Error('Stage retry budget is exhausted');
  }
  for (const node of nodes) clearAttempt(node);
  const laterStageIds = new Set(run.workflow.stages.slice(stageIndex + 1).map((stage) => stage.id));
  for (const node of run.nodes) {
    if (node.stageId !== null && laterStageIds.has(node.stageId) && node.status === 'killed') node.status = 'queued';
  }
  queueStageRetryAddendum(runId, stageId, req.promptAddendum);
  run.status = 'running';
  delete run.endedAt;
  await saveRun(run);
  startExecution(run, stageIndex);
  return structuredClone(run);
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
  if (!node) throw new Error(`Node not found: ${nodeRunId}`);
  const patchFile = node.patchFile ?? join(runDirectory(runId), 'artifacts', `${node.nodeRunId}.a${node.attempt}.patch`);
  if (!existsSync(patchFile)) return { ok: false, message: 'No captured patch is available for this node.' };
  const workspace = await getWorkspace(run.workspaceId);
  if (!workspace.isGit || !await isGitRepository(workspace.path)) return { ok: false, message: 'Patches can only be applied to a Git workspace.' };
  try {
    await execFileAsync('git', ['-C', workspace.path, 'apply', '--check', '--3way', '--binary', patchFile], { encoding: 'utf8' });
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${value.stdout ?? ''}\n${value.stderr ?? ''}`.trim();
    const conflicts = conflictsFromOutput(output);
    return {
      ok: false,
      ...(conflicts.length ? { conflicts } : {}),
      message: output || value.message || 'Patch validation failed.',
    };
  }
  try {
    await execFileAsync('git', ['-C', workspace.path, 'apply', '--3way', '--binary', patchFile], { encoding: 'utf8' });
    return { ok: true, message: 'Patch applied.' };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${value.stdout ?? ''}\n${value.stderr ?? ''}`.trim();
    const conflicts = conflictsFromOutput(output);
    return { ok: false, ...(conflicts.length ? { conflicts } : {}), message: output || value.message || 'Patch application failed.' };
  }
}

export async function sweepOnBoot(): Promise<void> {
  const runs = await listRuns(undefined, Number.MAX_SAFE_INTEGER);
  for (const run of runs) {
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    for (const node of run.nodes) {
      if (node.pid) {
        try { process.kill(-node.pid, 'SIGTERM'); } catch { /* Stale or already dead. */ }
      }
      if (node.status === 'running' || node.status === 'stalled') {
        node.status = 'killed';
        node.endedAt = Date.now();
      }
      delete node.pid;
    }
    try { await pruneWorktrees(run.runId); } catch { /* Recovery continues even when git metadata is damaged. */ }
    run.status = 'aborted';
    run.endedAt = Date.now();
    systemEvent(run, 'status', 'Run aborted during server restart recovery.', { status: 'aborted', detail: 'server-restart' });
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
