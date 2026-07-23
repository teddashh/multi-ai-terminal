import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdapterContentEvent, NodeRun, ProviderTurnEndReason, RunStatus, Stage, Usage } from '@mat/shared';
import { getAdapter } from '../adapters/registry.js';
import type { NodeOutcome, ResolvedNodeSpec, SpawnedNode } from '../adapters/base.js';
import type { Adapter } from '../adapters/base.js';
import { detectAuthFailure, humanizeError, providerSpawnSlot } from '../adapters/base.js';
import { appendEvent } from '../store/eventLog.js';
import { runDirectory } from './worktree.js';
import { recordToolUse, resetToolCount } from './digest.js';
import { diag } from '../diag.js';
import { clearAuthAlert, setAuthAlert } from '../providers/auth.js';
import { markActiveNeedsLogin, markActiveValid } from '../providers/codex/accounts.js';
import { configuredOpenAiKey } from '../providers/codex/apiKey.js';
import { activeSignInProvider } from '../providers/signin.js';
import { redactDiagnosticValue, redactEnvironmentValues } from '../redact.js';
import { getDataDir } from '../store/dataDir.js';
import { resolveRuntimeBinary } from '../runtime/resolve.js';
import { ProviderTurnBridge, type ProviderTechnicalEvidence } from '../providers/contract.js';

export interface NodeExecutionContext {
  runId: string;
  stageId?: string | null;
  resumeSessionRef?: string;
  adapter?: Adapter;
  persist(): Promise<void>;
  getRunStatus?(): RunStatus;
  steerPending?(): boolean;
  prepare?(): Promise<void>;
  finalize?(): Promise<void>;
}

interface LiveNode {
  spawned: SpawnedNode;
  node: NodeRun;
  context: NodeExecutionContext;
  killedReason?: 'user' | 'user-retry' | 'abort' | 'timeout' | 'gate-timeout' | 'steer';
  wasStalled?: boolean;
  outputTail: string;
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

function redactEventData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data, redactDiagnosticValue)) as Record<string, unknown>;
}

function lifecycle(node: NodeRun, context: NodeExecutionContext, kind: 'status' | 'result' | 'error', text: string, data?: Record<string, unknown>): void {
  appendEvent(context.runId, {
    ...eventIdentity(node, context),
    role: 'system',
    kind,
    text: redactEnvironmentValues(text),
    // Lifecycle metadata contains machine-readable enum values such as
    // "user" and "user-retry". Preserve those exact values; untrusted text is
    // redacted before it is placed into lifecycle data.
    ...(data ? { data } : {}),
  }, { trustedData: true });
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
  const detail = redactEnvironmentValues(error instanceof Error ? error.message : String(error));
  try {
    lifecycle(node, context, 'error', `Snapshot persistence failed: ${detail}`, { detail: 'persist-failed' });
  } catch (appendError) {
    const appendDetail = redactEnvironmentValues(appendError instanceof Error ? appendError.message : String(appendError));
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
    console.error(`[mat] unexpected persistence handler failure for ${context.runId}/${node.nodeRunId}: ${redactEnvironmentValues(String(error))}`);
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
  delete node.errorReason;
  delete node.patchFile;
  delete node.baseCommit;
  delete node.exitCode;
  delete node.sessionRef;
  delete node.verification;
  delete node.handoff;
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
    name: redactEnvironmentValues(event.tool.name),
    ...(event.tool.toolCallId !== undefined ? { toolCallId: redactEnvironmentValues(event.tool.toolCallId) } : {}),
    ...(event.tool.input !== undefined ? { input: redactEnvironmentValues(event.tool.input) } : {}),
    ...(event.tool.output !== undefined ? { output: redactEnvironmentValues(event.tool.output) } : {}),
    ...(event.tool.isError !== undefined ? { isError: event.tool.isError } : {}),
  } : undefined;
  appendEvent(context.runId, {
    ...eventIdentity(node, context),
    role: event.role,
    kind: event.kind,
    text: redactEnvironmentValues(event.text),
    ...(tool ? { tool } : {}),
    ...(event.data ? { data: redactEventData(event.data) } : {}),
  }, { trustedData: true });
}

function appendProviderTechnical(node: NodeRun, context: NodeExecutionContext, event: ProviderTechnicalEvidence): void {
  // ProviderTurnBridge has already separated trusted event/category fields
  // from redacted provider payloads. nodeRunner remains the sole lifecycle
  // writer and these technical statuses never mutate NodeRun.status.
  lifecycle(node, context, 'status', event.text, event.data);
}

function providerTurnEvidence(turn: NodeOutcome['providerTurn']): Record<string, unknown> {
  return turn ? {
    providerEvent: turn.event,
    providerSessionId: turn.sessionId,
    turnReason: turn.reason,
    providerStatus: turn.status,
  } : {};
}

function providerTerminationReason(reason: LiveNode['killedReason']): ProviderTurnEndReason | undefined {
  if (reason === 'timeout') return 'error';
  if (reason === 'abort' || reason === 'gate-timeout') return 'aborted';
  if (reason !== undefined) return 'interrupted';
  return undefined;
}

export async function runNode(node: NodeRun, stage: Stage, promptText: string): Promise<void> {
  const context = contexts.get(node);
  if (!context) throw new Error(`No execution context registered for ${node.nodeRunId}`);
  const identity = eventIdentity(node, context);
  const adapter = context.adapter ?? getAdapter(node.agent.provider);
  const shouldSkipSpawn = (): boolean => node.status === 'killed' || context.getRunStatus?.() === 'aborted';
  const rawPath = join(runDirectory(context.runId), 'raw', `${node.nodeRunId}.a${node.attempt}.jsonl`);
  mkdirSync(dirname(rawPath), { recursive: true });

  // The provider receives the original prompt below; only the persisted event
  // is redacted. This boundary applies to mock as well as real providers.
  appendEvent(context.runId, { ...identity, role: 'user', kind: 'message', text: redactEnvironmentValues(promptText) });
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
    const detail = redactEnvironmentValues(humanizeError(error));
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
  let outputTail = '';
  const appendOutputTail = (text: string): void => {
    outputTail = `${outputTail}${redactEnvironmentValues(text)}\n`.slice(-4096);
    const current = liveNodes.get(key);
    if (current) current.outputTail = outputTail;
  };

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
  let readyForProviderEvidence = false;
  const pendingProviderEvidence: Array<
    { type: 'content'; event: AdapterContentEvent }
    | { type: 'technical'; event: ProviderTechnicalEvidence }
  > = [];
  const receiveContent = (event: AdapterContentEvent): void => {
    if (!readyForProviderEvidence) {
      pendingProviderEvidence.push({ type: 'content', event });
      return;
    }
    activity();
    appendContent(node, context, event);
  };
  const receiveTechnical = (event: ProviderTechnicalEvidence): void => {
    if (!readyForProviderEvidence) {
      pendingProviderEvidence.push({ type: 'technical', event });
      return;
    }
    activity();
    appendProviderTechnical(node, context, event);
  };
  // The deterministic mock remains exempt from real-provider manager
  // behaviors; evidence instruments depend on its exact event sequence.
  const providerTurn = node.agent.provider === 'mock'
    ? undefined
    : new ProviderTurnBridge({
      provider: node.agent.provider,
      sessionId: `provider:${context.runId}:${node.nodeRunId}:a${node.attempt}`,
      spec,
      sink: { onContent: receiveContent, onTechnical: receiveTechnical },
    });
  let providerTurnStarted = false;
  try {
    // Parallel same-account CLI sessions race single-use OAuth refresh-token rotation.
    await providerSpawnSlot(node.agent.provider);
    // A steer interrupt arriving during the stagger wait cannot reach this node
    // through killAllActiveNodes (nothing is spawned yet), so honor it here.
    if (shouldSkipSpawn() || context.steerPending?.()) {
      if (node.status !== 'killed') markNodeKilled(node, context.runId, shouldSkipSpawn() ? 'abort' : 'steer');
      else emitKilledLifecycle(node, context, 'user');
      await persistSafely(node, context);
      return;
    }
    // A login child rewrites the shared CODEX_HOME auth.json mid-ceremony;
    // spawning a codex turn against it would race the credential swap.
    if (node.agent.provider === 'codex' && activeSignInProvider() === 'codex') {
      throw new Error('codex sign-in is in progress; retry after it completes');
    }
    if (adapter.runtimeFamily) {
      const runtimeCommand = await resolveRuntimeBinary(getDataDir(), adapter.runtimeFamily);
      if (!runtimeCommand) {
        const runtimeName = node.agent.provider === adapter.runtimeFamily
          ? `${node.agent.provider} CLI runtime`
          : `${node.agent.provider} requires the ${adapter.runtimeFamily} CLI runtime`;
        throw new Error(`${runtimeName} was not found`);
      }
      spec.runtimeCommand = runtimeCommand;
      if (adapter.runtimeFamily === 'codex') {
        const nodeCommand = await resolveRuntimeBinary(getDataDir(), 'node');
        spec.runtimeNodeCommand = nodeCommand && nodeCommand !== 'node' ? nodeCommand : process.execPath;
      }
    }
    providerTurnStarted = providerTurn !== undefined;
    providerTurn?.start();
    const transport = adapter.spawn(spec, {
      onEvent(event) {
        appendOutputTail(event.text);
        if (providerTurn) providerTurn.acceptContent(event);
        else receiveContent(event);
      },
      onRaw(line, stream) {
        appendOutputTail(line);
        appendFileSync(rawPath, `${JSON.stringify({ s: stream, l: redactEnvironmentValues(line), ts: Date.now() })}\n`, 'utf8');
        if (readyForProviderEvidence) activity();
      },
    });
    spawned = {
      pid: transport.pid,
      kill: (signal) => transport.kill(signal),
      completion: providerTurn
        ? Promise.resolve(transport.completion).then(
          (outcome) => providerTurn.finish(
            outcome,
            providerTerminationReason(liveNodes.get(key)?.killedReason),
          ),
          (error: unknown) => providerTurn.finish(
            {
              exitCode: 1,
              error: error instanceof Error ? error.message : String(error),
            },
            providerTerminationReason(liveNodes.get(key)?.killedReason),
          ),
        )
        : transport.completion,
    };
  } catch (error) {
    const detail = redactEnvironmentValues(humanizeError(error));
    const failedTurn = providerTurnStarted
      ? providerTurn?.finish({ exitCode: null, error: detail }, 'error').providerTurn
      : undefined;
    // A transport may emit synchronous content before throwing. Preserve that
    // evidence, plus the bridge's final full status, without inventing a
    // spawned/running lifecycle for a child that never came up.
    readyForProviderEvidence = true;
    for (const pending of pendingProviderEvidence) {
      if (pending.type === 'content') appendContent(node, context, pending.event);
      else appendProviderTechnical(node, context, pending.event);
    }
    pendingProviderEvidence.length = 0;
    node.status = 'failed';
    node.startedAt = Date.now();
    node.endedAt = Date.now();
    node.exitCode = null;
    node.resultText = detail;
    node.error = detail;
    lifecycle(node, context, 'error', detail, {
      status: 'failed',
      exitCode: null,
      ...providerTurnEvidence(failedTurn),
    });
    await persistSafely(node, context);
    return;
  }

  const live: LiveNode = { spawned, node, context, outputTail };
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
  diag(context.runId, 'spawn', {
    nodeRunId: node.nodeRunId, attempt: node.attempt, provider: node.agent.provider,
    ...(node.agent.model ? { model: node.agent.model } : {}), cwd: node.cwd, pid: spawned.pid,
  });
  armStall();
  hardTimer = setTimeout(() => {
    const current = liveNodes.get(key);
    if (!current) return;
    current.killedReason = 'timeout';
    current.spawned.kill('SIGTERM');
  }, stage.timeoutSec * 1000);
  readyForProviderEvidence = true;
  for (const pending of pendingProviderEvidence) {
    activity();
    if (pending.type === 'content') appendContent(node, context, pending.event);
    else appendProviderTechnical(node, context, pending.event);
  }
  pendingProviderEvidence.length = 0;
  await persistSafely(node, context);

  let outcome: NodeOutcome;
  try {
    outcome = await spawned.completion;
  } catch (error) {
    outcome = { exitCode: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.error) appendOutputTail(outcome.error);
  if (stallTimer) clearTimeout(stallTimer);
  if (hardTimer) clearTimeout(hardTimer);
  const liveState = liveNodes.get(key);
  const killedReason = liveState?.killedReason;
  liveNodes.delete(key);
  delete node.pid;
  node.endedAt = Date.now();
  node.exitCode = outcome.exitCode;
  const sessionRef = outcome.sessionRef !== undefined
    ? redactEnvironmentValues(outcome.sessionRef)
    : undefined;
  if (sessionRef !== undefined) node.sessionRef = sessionRef;
  const usage = mergeUsage(node.usage, outcome.usage);
  if (usage !== undefined) node.usage = usage;
  const outcomeError = outcome.error === undefined ? undefined : redactEnvironmentValues(humanizeError(outcome.error, node.agent.provider));
  node.resultText = redactEnvironmentValues(outcome.resultText ?? outcomeError ?? '');
  if (outcomeError !== undefined) node.error = outcomeError; else delete node.error;

  if (killedReason === 'user' || killedReason === 'user-retry' || killedReason === 'abort' || killedReason === 'gate-timeout' || killedReason === 'steer') {
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
    delete node.errorReason;
    clearAuthAlert(node.agent.provider);
    // A configured API key can carry the turn while the OAuth tokens are dead,
    // so success only clears needs-login when no key could have authed it.
    if (node.agent.provider === 'codex' && !configuredOpenAiKey()) void Promise.resolve(markActiveValid()).catch(() => undefined);
  } else {
    node.status = 'failed';
    node.error = outcomeError ?? `Node exited with code ${String(outcome.exitCode)}`;
    lifecycle(node, context, 'error', node.error, { status: 'failed', exitCode: outcome.exitCode });
  }
  if (node.status === 'failed' && !node.errorReason) {
    const authFailure = detectAuthFailure(node.agent.provider, outputTail);
    if (authFailure) {
      node.errorReason = authFailure;
      lifecycle(node, context, 'error', authFailure, { status: 'failed', detail: 'auth' });
      diag(context.runId, 'error', { nodeRunId: node.nodeRunId, kind: 'auth' });
      setAuthAlert(node.agent.provider, authFailure, context.runId, node.nodeRunId);
      if (node.agent.provider === 'codex') void Promise.resolve(markActiveNeedsLogin(authFailure)).catch(() => undefined);
    }
  }
  lifecycle(node, context, 'result', node.resultText ?? '', {
    exitCode: outcome.exitCode,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(sessionRef ? { sessionRef } : {}),
    ...providerTurnEvidence(outcome.providerTurn),
  });

  try { await context.finalize?.(); } catch (error) {
    const detail = redactEnvironmentValues(humanizeError(error));
    const message = `Artifact capture failed: ${detail}`;
    const verification = {
      status: 'error' as const,
      reason: 'artifact-capture-failed',
      outputTail: detail.slice(-2000),
    };
    node.verification = verification;
    if (node.status === 'done') {
      node.status = 'failed';
      node.error = message;
    } else {
      node.error ??= message;
    }
    lifecycle(node, context, 'error', message, {
      status: node.status,
      detail: 'verify-result',
      phase: 'artifact-capture',
      verification,
    });
    diag(context.runId, 'verify-result', {
      nodeRunId: node.nodeRunId,
      attempt: node.attempt,
      status: verification.status,
      reason: verification.reason,
    });
  }
  diag(context.runId, 'exit', {
    nodeRunId: node.nodeRunId, attempt: node.attempt, status: node.status, exitCode: node.exitCode,
    ...(killedReason ? { killedReason } : {}), durationMs: Math.max(0, (node.endedAt ?? Date.now()) - (node.startedAt ?? node.endedAt ?? Date.now())),
  });
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
