import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdapterContentEvent, NodeRun, Stage, Usage } from '@mat/shared';
import { getAdapter } from '../adapters/registry.js';
import type { NodeOutcome, ResolvedNodeSpec, SpawnedNode } from '../adapters/base.js';
import type { Adapter } from '../adapters/base.js';
import { appendEvent } from '../store/eventLog.js';
import { runDirectory } from './worktree.js';
import { recordToolUse } from './digest.js';

export interface NodeExecutionContext {
  runId: string;
  stageId?: string | null;
  resumeSessionRef?: string;
  adapter?: Adapter;
  persist(): Promise<void>;
  prepare?(): Promise<void>;
  finalize?(): Promise<void>;
}

interface LiveNode {
  spawned: SpawnedNode;
  node: NodeRun;
  context: NodeExecutionContext;
  killedReason?: 'user' | 'abort' | 'timeout' | 'gate-timeout';
  wasStalled?: boolean;
}

const contexts = new WeakMap<NodeRun, NodeExecutionContext>();
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
  const rawPath = join(runDirectory(context.runId), 'raw', `${node.nodeRunId}.a${node.attempt}.jsonl`);
  mkdirSync(dirname(rawPath), { recursive: true });

  appendEvent(context.runId, { ...identity, role: 'user', kind: 'message', text: promptText });
  try {
    await context.prepare?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    node.status = 'failed';
    node.startedAt ??= Date.now();
    node.endedAt = Date.now();
    node.exitCode = null;
    node.resultText = detail;
    lifecycle(node, context, 'error', `Preparation failed: ${detail}`, { status: 'failed', exitCode: null });
    await context.persist();
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
      void context.persist();
    }, effectiveStallMs);
  };
  const activity = (): void => {
    if (node.status === 'stalled') {
      node.status = 'running';
      lifecycle(node, context, 'status', 'running', { status: 'running', detail: 'recovered', attempt: node.attempt });
      void context.persist();
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
    const detail = error instanceof Error ? error.message : String(error);
    node.status = 'failed';
    node.startedAt = Date.now();
    node.endedAt = Date.now();
    node.exitCode = null;
    node.resultText = detail;
    lifecycle(node, context, 'error', detail, { status: 'failed', exitCode: null });
    await context.persist();
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
  readyForContent = true;
  for (const event of pendingContent) {
    activity();
    appendContent(node, context, event);
  }
  await context.persist();
  armStall();
  hardTimer = setTimeout(() => {
    const current = liveNodes.get(key);
    if (!current) return;
    current.killedReason = 'timeout';
    current.spawned.kill('SIGTERM');
  }, stage.timeoutSec * 1000);

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
  node.resultText = outcome.resultText ?? outcome.error ?? '';

  if (killedReason === 'user' || killedReason === 'abort' || killedReason === 'gate-timeout') {
    node.status = 'killed';
    lifecycle(node, context, 'status', 'killed', { status: 'killed', detail: killedReason, attempt: node.attempt });
    if (liveState?.wasStalled) {
      lifecycle(node, context, 'error', 'Stalled node attempt was killed', { status: 'killed', detail: killedReason });
    }
  } else if (killedReason === 'timeout') {
    node.status = 'failed';
    lifecycle(node, context, 'error', 'Node attempt timed out', { status: 'failed', exitCode: outcome.exitCode, detail: 'timeout' });
  } else if (outcome.exitCode === 0 && !outcome.error) {
    node.status = 'done';
  } else {
    node.status = 'failed';
    lifecycle(node, context, 'error', outcome.error ?? `Node exited with code ${String(outcome.exitCode)}`, { status: 'failed', exitCode: outcome.exitCode });
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
  await context.persist();
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
