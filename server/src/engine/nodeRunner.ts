import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdapterContentEvent, NodeRun, RunStatus, Stage, Usage } from '@mat/shared';
import { getAdapter } from '../adapters/registry.js';
import type { NodeOutcome, ResolvedNodeSpec, SpawnedNode } from '../adapters/base.js';
import type { Adapter } from '../adapters/base.js';
import { humanizeError } from '../adapters/base.js';
import { appendEvent } from '../store/eventLog.js';
import { runDirectory } from './worktree.js';
import { recordToolUse, resetToolCount } from './digest.js';

export interface NodeExecutionContext {
  runId: string;
  stageId?: string | null;
  resumeSessionRef?: string;
  adapter?: Adapter;
  persist(): Promise<void>;
  getRunStatus?(): RunStatus;
  prepare?(): Promise<void>;
  finalize?(): Promise<void>;
}

interface LiveNode {
  spawned: SpawnedNode;
  node: NodeRun;
  context: NodeExecutionContext;
  killedReason?: 'user' | 'user-retry' | 'abort' | 'timeout' | 'gate-timeout';
  wasStalled?: boolean;
}

const contexts = new WeakMap<NodeRun, NodeExecutionContext>();
const killedLifecycleAttempts = new WeakMap<NodeRun, Set<number>>();
const reportedPersistFailures = new WeakSet<NodeExecutionContext>();
const liveNodes = new Map<string, LiveNode>();
const liveKey = (runId: string, nodeRunId: string): string => `${runId}\0${nodeRunId}`;

export function registerNodeContext(node: NodeRun, context: NodeExecutionContext): void {
  contexts.set(node, context);
}

function eventIdentity(node: NodeRun, context: NodeExecutionContext) {
  return {
    runId: context.runId,
    stageId: context.stageId === undefined ? node.stageId : context.stageId,
    nodeRunId: node.nodeRunId,
    attempt: node.attempt,
  };
}

function lifecycle(node: NodeRun, context: NodeExecutionContext, kind: 'status' | 'result' | 'error', text: string, data?: Record<string, unknown>): void {
  appendEvent(context.runId, {
    ...eventIdentity(node, context),
    role: 'system',
    kind,
    text,
    ...(data ? { data } : {}),
  });
}

function emitKilledLifecycle(node: NodeRun, context: NodeExecutionContext, reason: NonNullable<LiveNode['killedReason']>): void {
  const attempts = killedLifecycleAttempts.get(node) ?? new Set<number>();
  if (attempts.has(node.attempt)) return;
  attempts.add(node.attempt);
  killedLifecycleAttempts.set(node, attempts);
  lifecycle(node, context, 'status', 'killed', { status: 'killed', detail: reason, attempt: node.attempt });
}

function reportPersistFailure(node: NodeRun, context: NodeExecutionContext, error: unknown): void {
  if (reportedPersistFailures.has(context)) return;
  reportedPersistFailures.add(context);
  const detail = error instanceof Error ? error.message : String(error);
  try {
    lifecycle(node, context, 'error', `Snapshot persistence failed: ${detail}`, { detail: 'persist-failed' });
  } catch (appendError) {
    const appendDetail = appendError instanceof Error ? appendError.message : String(appendError);
    console.error(`[mat] snapshot persistence failed for ${context.runId}/${node.nodeRunId}: ${detail}; event append failed: ${appendDetail}`);
  }
}

async function persistSafely(node: NodeRun, context: NodeExecutionContext): Promise<void> {
  try {
    await context.persist();
  } catch (error) {
    reportPersistFailure(node, context, error);
  }
}

function persistInBackground(node: NodeRun, context: NodeExecutionContext): void {
  persistSafely(node, context).catch((error: unknown) => {
    // persistSafely is defensive, but keep the fire-and-forget boundary rejection-safe.
    console.error(`[mat] unexpected persistence handler failure for ${context.runId}/${node.nodeRunId}: ${String(error)}`);
  });
}

export function markNodeKilled(node: NodeRun, runId: string, reason: NonNullable<LiveNode['killedReason']>): void {
  const context = contexts.get(node) ?? { runId, stageId: node.stageId, persist: async () => undefined };
  node.status = 'killed';
  node.endedAt ??= Date.now();
  delete node.pid;
  emitKilledLifecycle(node, context, reason);
}

export function resetNodeForRetry(node: NodeRun): void {
  node.attempt += 1;
  node.status = 'queued';
  delete node.pid;
  delete node.startedAt;
  delete node.endedAt;
  delete node.resultText;
  delete node.error;
  delete node.patchFile;
  delete node.baseCommit;
  delete node.exitCode;
  delete node.sessionRef;
  resetToolCount(node);
}

export function emitRetryBoundary(node: NodeRun): void {
  const context = contexts.get(node);
  if (!context) throw new Error(`No execution context registered for ${node.nodeRunId}`);
  lifecycle(node, context, 'status', 'retry', { status: 'retry', attempt: node.attempt });
}

function mergeUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!next) return current;
  const merged: Usage = {};
  const inputTokens = (current?.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (current?.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const costUsd = (current?.costUsd ?? 0) + (next.costUsd ?? 0);
  if (current?.inputTokens !== undefined || next.inputTokens !== undefined) merged.inputTokens = inputTokens;
  if (current?.outputTokens !== undefined || next.outputTokens !== undefined) merged.outputTokens = outputTokens;
  if (current?.costUsd !== undefined || next.costUsd !== undefined) merged.costUsd = costUsd;
  return merged;
}

function appendContent(node: NodeRun, context: NodeExecutionContext, event: AdapterContentEvent): void {
  if (event.kind === 'tool_use') recordToolUse(node);
  const tool = event.tool ? {
    name: event.tool.name,
    ...(event.tool.toolCallId !== undefined ? { toolCallId: event.tool.toolCallId } : {}),
    ...(event.tool.input !== undefined ? { input: event.tool.input } : {}),
    ...(event.tool.output !== undefined ? { output: event.tool.output } : {}),
    ...(event.tool.isError !== undefined ? { isError: event.tool.isError } : {}),
  } : undefined;
  appendEvent(context.runId, {
    ...eventIdentity(node, context),
    role: event.role,
    kind: event.kind,
    text: event.text,
    ...(tool ? { tool } : {}),
    ...(event.data ? { data: event.data } : {}),
  });
}

export async function runNode(node: NodeRun, stage: Stage, promptText: string): Promise<void> {
  const context = contexts.get(node);
  if (!context) throw new Error(`No execution context registered for ${node.nodeRunId}`);
  const identity = eventIdentity(node, context);
  const adapter = context.adapter ?? getAdapter(node.agent.provider);
  const shouldSkipSpawn = (): boolean => node.status === 'killed' || context.getRunStatus?.() === 'aborted';
  const rawPath = join(runDirectory(context.runId), 'raw', `${node.nodeRunId}.a${node.attempt}.jsonl`);
  mkdirSync(dirname(rawPath), { recursive: true });

  appendEvent(context.runId, { ...identity, role: 'user', kind: 'message', text: promptText });
  if (shouldSkipSpawn()) {
    if (node.status !== 'killed') markNodeKilled(node, context.runId, 'abort');
    else emitKilledLifecycle(node, context, 'user');
    await persistSafely(node, context);
    return;
  }
  try {
    await context.prepare?.();
  } catch (error) {
    if (shouldSkipSpawn()) {
      if (node.status !== 'killed') markNodeKilled(node, context.runId, 'abort');
      else emitKilledLifecycle(node, context, 'user');
      await persistSafely(node, context);
      return;
    }
    const detail = humanizeError(error);
    node.status = 'failed';
    node.startedAt ??= Date.now();
    node.endedAt = Date.now();
    node.exitCode = null;
    node.resultText = detail;
    node.error = detail;
    lifecycle(node, context, 'error', `Preparation failed: ${detail}`, { status: 'failed', exitCode: null });
    await persistSafely(node, context);
    return;
  }

  // prepare() may take seconds. A queued kill or run abort during that await must
  // win before an adapter process can be created.
  if (shouldSkipSpawn()) {
    if (node.status !== 'killed') markNodeKilled(node, context.runId, 'abort');
    else emitKilledLifecycle(node, context, 'user');
    await persistSafely(node, context);
    return;
  }

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let spawned: SpawnedNode;
  const effectiveStallMs = Math.max(stage.stallSec, node.agent.provider === 'agy' ? 600 : 0) * 1000;
  const key = liveKey(context.runId, node.nodeRunId);

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      const live = liveNodes.get(key);
      if (!live || node.status !== 'running') return;
      node.status = 'stalled';
      lifecycle(node, context, 'status', 'stalled', { status: 'stalled', attempt: node.attempt });
      persistInBackground(node, context);
    }, effectiveStallMs);
  };
  const activity = (): void => {
    if (node.status === 'stalled') {
      node.status = 'running';
      lifecycle(node, context, 'status', 'running', { status: 'running', detail: 'recovered', attempt: node.attempt });
      persistInBackground(node, context);
    }
    armStall();
  };

  const spec: ResolvedNodeSpec = {
    binding: node.agent,
    promptText,
    cwd: node.cwd,
    ...(context.resumeSessionRef ? { resumeSessionRef: context.resumeSessionRef } : {}),
  };
  let readyForContent = false;
  const pendingContent: AdapterContentEvent[] = [];
  try {
    spawned = adapter.spawn(spec, {
      onEvent(event) {
        if (!readyForContent) { pendingContent.push(event); return; }
        activity();
        appendContent(node, context, event);
      },
      onRaw(line, stream) {
        appendFileSync(rawPath, `${JSON.stringify({ s: stream, l: line, ts: Date.now() })}\n`, 'utf8');
        if (readyForContent) activity();
      },
    });
  } catch (error) {
    const detail = humanizeError(error);
    node.status = 'failed';
    node.startedAt = Date.now();
    node.endedAt = Date.now();
    node.exitCode = null;
    node.resultText = detail;
    node.error = detail;
    lifecycle(node, context, 'error', detail, { status: 'failed', exitCode: null });
    await persistSafely(node, context);
    return;
  }

  const live: LiveNode = { spawned, node, context };
  liveNodes.set(key, live);
  node.status = 'running';
  node.startedAt = Date.now();
  delete node.endedAt;
  // In-process adapters (mock) use the server pid, and a failed OS spawn can
  // report -1. Neither is a child process group that crash recovery may reap.
  if (Number.isInteger(spawned.pid) && spawned.pid > 0 && spawned.pid !== process.pid) node.pid = spawned.pid;
  else delete node.pid;
  lifecycle(node, context, 'status', 'spawned', { status: 'spawned', attempt: node.attempt });
  lifecycle(node, context, 'status', 'running', { status: 'running', attempt: node.attempt });
  armStall();
  hardTimer = setTimeout(() => {
    const current = liveNodes.get(key);
    if (!current) return;
    current.killedReason = 'timeout';
    current.spawned.kill('SIGTERM');
  }, stage.timeoutSec * 1000);
  readyForContent = true;
  for (const event of pendingContent) {
    activity();
    appendContent(node, context, event);
  }
  await persistSafely(node, context);

  let outcome: NodeOutcome;
  try {
    outcome = await spawned.completion;
  } catch (error) {
    outcome = { exitCode: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (stallTimer) clearTimeout(stallTimer);
  if (hardTimer) clearTimeout(hardTimer);
  const liveState = liveNodes.get(key);
  const killedReason = liveState?.killedReason;
  liveNodes.delete(key);
  delete node.pid;
  node.endedAt = Date.now();
  node.exitCode = outcome.exitCode;
  if (outcome.sessionRef !== undefined) node.sessionRef = outcome.sessionRef;
  const usage = mergeUsage(node.usage, outcome.usage);
  if (usage !== undefined) node.usage = usage;
  const outcomeError = outcome.error === undefined ? undefined : humanizeError(outcome.error, node.agent.provider);
  node.resultText = outcome.resultText ?? outcomeError ?? '';
  if (outcomeError !== undefined) node.error = outcomeError; else delete node.error;

  if (killedReason === 'user' || killedReason === 'user-retry' || killedReason === 'abort' || killedReason === 'gate-timeout') {
    node.status = 'killed';
    emitKilledLifecycle(node, context, killedReason);
    if (liveState?.wasStalled) {
      lifecycle(node, context, 'error', 'Stalled node attempt was killed', { status: 'killed', detail: killedReason });
    }
  } else if (killedReason === 'timeout') {
    node.status = 'failed';
    node.error = 'Node attempt timed out';
    lifecycle(node, context, 'error', node.error, { status: 'failed', exitCode: outcome.exitCode, detail: 'timeout' });
  } else if (outcome.exitCode === 0 && !outcome.error) {
    node.status = 'done';
    delete node.error;
  } else {
    node.status = 'failed';
    node.error = outcomeError ?? `Node exited with code ${String(outcome.exitCode)}`;
    lifecycle(node, context, 'error', node.error, { status: 'failed', exitCode: outcome.exitCode });
  }
  lifecycle(node, context, 'result', node.resultText ?? '', {
    exitCode: outcome.exitCode,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.sessionRef ? { sessionRef: outcome.sessionRef } : {}),
  });

  try { await context.finalize?.(); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lifecycle(node, context, 'error', `Artifact capture failed: ${detail}`);
  }
  await persistSafely(node, context);
}

export function killActiveNode(runId: string, nodeRunId: string, reason: LiveNode['killedReason'] = 'user'): boolean {
  const live = liveNodes.get(liveKey(runId, nodeRunId));
  if (!live) return false;
  if (live.node.status === 'stalled') live.wasStalled = true;
  live.killedReason = reason;
  live.spawned.kill('SIGTERM');
  return true;
}

export function killAllActiveNodes(runId?: string, reason: LiveNode['killedReason'] = 'abort'): number {
  let count = 0;
  for (const [key, live] of liveNodes) {
    if (runId !== undefined && live.context.runId !== runId) continue;
    if (live.node.status === 'stalled') live.wasStalled = true;
    live.killedReason = reason;
    live.spawned.kill('SIGTERM');
    count += 1;
    if (!liveNodes.has(key)) continue;
  }
  return count;
}
