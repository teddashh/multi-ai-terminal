import { randomUUID } from 'node:crypto';
import type { AdapterContentEvent } from '@mat/shared';
import type { Adapter } from '../../adapters/base.js';
import { ContentCoalescer, humanizeError, stringifyToolValue, truncateText, type NodeOutcome, type ResolvedNodeSpec, type SpawnedNode } from '../../adapters/base.js';
import { redactEnvironmentValues } from '../../redact.js';
import { resolveRuntimeBinary, runtimeBinaryForSpawn } from '../../runtime/resolve.js';
import { subscribeRuntimeChanges } from '../../runtime/triggers.js';
import { getDataDir } from '../../store/dataDir.js';
import { LiveQuery } from './live-query.js';
import { loadAgentSdk } from './sdk-loader.js';

type SpawnIo = Parameters<Adapter['spawn']>[1];
type ResolveBinary = typeof resolveRuntimeBinary;
type Subscribe = typeof subscribeRuntimeChanges;

interface RuntimeOverrides { resolveBinary?: ResolveBinary; subscribe?: Subscribe; reapTickMs?: number; reapIdleMs?: number; interruptFallbackMs?: number }
interface SessionState {
  live?: LiveQuery;
  sdkSessionId?: string;
  abortController?: AbortController;
  interruptRequested: boolean;
  stderrTail: string;
  chain: Promise<unknown>;
  lastActivity: number;
  active: boolean;
  activeIo?: SpawnIo;
  coalescer: ContentCoalescer;
}

const REAP_TICK_MS = 30_000;
const REAP_IDLE_MS = 300_000;

export interface ClaudeSessionRuntime {
  startRun(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode;
  dispose(): Promise<void>;
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const stripAnsi = (value: string): string => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');

function resultErrorMessage(result: Record<string, unknown>): string {
  const message = string(result.error) ?? string(result.message)
    ?? (string(result.subtype) ? `Claude turn failed (${string(result.subtype)})` : 'Claude turn failed');
  return redactEnvironmentValues(message);
}

function usageOf(result: Record<string, unknown>): NodeOutcome['usage'] | undefined {
  const usage = record(result.usage);
  const mapped = {
    ...(typeof usage?.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage?.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
  };
  return Object.keys(mapped).length ? mapped : undefined;
}

class SessionRuntime implements ClaudeSessionRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private runtimeChanged = false;
  private readonly unsubscribe: () => void;
  private readonly reaper: ReturnType<typeof setInterval>;

  constructor(private readonly overrides: RuntimeOverrides) {
    this.unsubscribe = (overrides.subscribe ?? subscribeRuntimeChanges)((event) => {
      if (event.family !== 'claude') return;
      this.runtimeChanged = true;
      for (const state of this.sessions.values()) if (!state.active) this.closeLive(state);
      this.resetChangeIfRecycled();
    });
    // Warm LiveQueries keep a claude subprocess alive per session; without a
    // reaper every one-shot engine run would leak one until server restart.
    this.reaper = setInterval(() => this.reapIdle(), overrides.reapTickMs ?? REAP_TICK_MS);
    this.reaper.unref?.();
  }

  startRun(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode {
    const sessionKey = spec.resumeSessionRef ?? `run-${randomUUID()}`;
    const state = this.state(sessionKey);
    let killed = false;
    const killFlag = { requested: false };
    const turn = state.chain.then(() => this.runTurn(sessionKey, state, spec, io, killFlag));
    state.chain = turn.catch(() => undefined);
    const completion = turn.catch((error): NodeOutcome => ({
      exitCode: 1,
      error: redactEnvironmentValues(humanizeError(error, 'claude')),
    }));
    return {
      pid: 0,
      kill: () => {
        if (killed) return;
        killed = true;
        // The flag alone covers a turn that has not started (queued behind
        // another run of the same session) — it must still classify as killed.
        killFlag.requested = true;
        if (!state.active || state.activeIo !== io) return;
        state.interruptRequested = true;
        const live = state.live;
        if (!live) return;
        void live.interrupt().catch(() => { live.close(); state.abortController?.abort(); });
        // A flaky SDK build can accept the interrupt yet never emit a result
        // frame; force-close so the pending turn settles as killed.
        const fallback = setTimeout(() => {
          if (state.active && state.activeIo === io) { live.close(); state.abortController?.abort(); }
        }, this.overrides.interruptFallbackMs ?? 10_000);
        fallback.unref?.();
      },
      completion,
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    clearInterval(this.reaper);
    for (const state of this.sessions.values()) this.closeLive(state);
    this.sessions.clear();
  }

  private reapIdle(): void {
    const idleMs = this.overrides.reapIdleMs ?? REAP_IDLE_MS;
    for (const [key, state] of this.sessions) {
      if (state.active || Date.now() - state.lastActivity < idleMs) continue;
      if (state.live) this.closeLive(state);
      // One-shot keys are unreachable after their run (resume goes through the
      // adopted sdk session id under a new key) — drop them or the map grows forever.
      if (key.startsWith('run-')) this.sessions.delete(key);
    }
  }

  private state(key: string): SessionState {
    let state = this.sessions.get(key);
    if (!state) {
      const created = { interruptRequested: false, stderrTail: '', chain: Promise.resolve(), lastActivity: Date.now(), active: false } as SessionState;
      created.coalescer = new ContentCoalescer((event) => { if (created.active) created.activeIo?.onEvent(event); });
      this.sessions.set(key, created);
      state = created;
    }
    return state;
  }

  private async runTurn(sessionKey: string, state: SessionState, spec: ResolvedNodeSpec, io: SpawnIo, killFlag: { requested: boolean }): Promise<NodeOutcome> {
    state.active = true;
    state.activeIo = io;
    state.lastActivity = Date.now();
    try {
      if (killFlag.requested) return this.killed(state);
      const sdk = await loadAgentSdk();
      if (killFlag.requested) return this.killed(state);
      if (!sdk) return { exitCode: 1, error: 'Claude Agent SDK unavailable — set MAT_CLAUDE_RUNTIME=cli to use the legacy CLI path' };
      if (spec.resumeSessionRef && !state.sdkSessionId) state.sdkSessionId = spec.resumeSessionRef;
      const existing = state.live && !state.live.isClosed ? state.live : undefined;
      const live = existing ?? await this.buildLive(sessionKey, state, spec, sdk);
      if (killFlag.requested) {
        // Don't leak a subprocess we spawned for a run that is already dead;
        // an existing warm session survives a pre-start cancel.
        if (!existing) this.closeLive(state);
        return this.killed(state);
      }
      state.stderrTail = '';
      try {
        const result = await live.push({ type: 'user', message: { role: 'user', content: spec.promptText || ' ' } });
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (live.isClosed && state.live === live) delete state.live;
        if (state.interruptRequested) {
          state.interruptRequested = false;
          return this.killed(state);
        }
        if (result.subtype === 'success') {
          const usage = usageOf(result);
          const resultText = string(result.result);
          return { exitCode: 0, ...this.sessionRef(state), ...(usage ? { usage } : {}), ...(resultText?.length ? { resultText } : {}) };
        }
        return { exitCode: 1, error: resultErrorMessage(result), ...this.sessionRef(state) };
      } catch (error) {
        if (live.isClosed && state.live === live) delete state.live;
        if (state.interruptRequested) {
          state.interruptRequested = false;
          return this.killed(state);
        }
        const raw = error instanceof Error ? error.message : String(error);
        if (state.abortController?.signal.aborted || /aborted/i.test(raw)) return this.killed(state);
        return { exitCode: 1, error: this.enrich(raw, state), ...this.sessionRef(state) };
      }
    } catch (error) {
      // Setup throws (SDK load, binary resolve, LiveQuery construction).
      if (killFlag.requested) return this.killed(state);
      const raw = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, error: this.enrich(raw, state), ...this.sessionRef(state) };
    } finally {
      // Whatever path ended this turn, a leftover interrupt flag is stale and
      // must not classify the next turn on this session as killed.
      state.interruptRequested = false;
      // Flush buffered stream text while activeIo can still receive it.
      state.coalescer.end();
      state.active = false;
      delete state.activeIo;
      state.lastActivity = Date.now();
      if (this.runtimeChanged) this.closeLive(state);
      this.resetChangeIfRecycled();
    }
  }

  private async buildLive(sessionKey: string, state: SessionState, spec: ResolvedNodeSpec, sdk: NonNullable<Awaited<ReturnType<typeof loadAgentSdk>>>): Promise<LiveQuery> {
    const resolve = this.overrides.resolveBinary ?? resolveRuntimeBinary;
    const executable = (await resolve(getDataDir(), 'claude')) ?? runtimeBinaryForSpawn(getDataDir(), 'claude');
    const abortController = new AbortController();
    state.abortController = abortController;
    const permission = spec.binding.permission;
    const options: Record<string, unknown> = {
      cwd: spec.cwd,
      systemPrompt: spec.binding.systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: spec.binding.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      permissionMode: permission === 'full' ? 'bypassPermissions' : permission === 'safe' ? 'plan' : 'acceptEdits',
      ...(permission === 'full' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(spec.binding.model ? { model: spec.binding.model } : {}),
      ...(spec.binding.effort ? { effort: spec.binding.effort } : {}),
      ...(spec.binding.maxTurns !== undefined ? { maxTurns: spec.binding.maxTurns } : {}),
      pathToClaudeCodeExecutable: executable,
      abortController,
      stderr: (chunk: unknown) => {
        state.stderrTail = `${state.stderrTail}${typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`.slice(-8192);
      },
      canUseTool: (tool: string, input: unknown) => {
        // bypassPermissions should keep the SDK from consulting us, but if it
        // does anyway, full permission must never deny.
        if (permission === 'full') return { behavior: 'allow', updatedInput: input };
        const allowed = permission === 'safe' ? new Set(['Read', 'Glob', 'Grep']) : new Set(['Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep']);
        const policy = permission === 'safe' ? 'safe' : 'standard';
        return allowed.has(tool) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `MAT engine run: ${tool} not permitted under ${policy} permission` };
      },
      ...(state.sdkSessionId ? { resume: state.sdkSessionId } : {}),
    };
    const live = new LiveQuery({ sdk, queryOptions: options, onMessage: (message) => this.onMessage(sessionKey, state, message), onError: () => undefined });
    state.live = live;
    return live;
  }

  private onMessage(sessionKey: string, state: SessionState, message: Record<string, unknown>): void {
    if (typeof message.session_id === 'string') state.sdkSessionId = message.session_id;
    if (!state.active || this.sessions.get(sessionKey) !== state) return;
    const emit = (event: AdapterContentEvent) => state.activeIo?.onEvent(event);
    if (message.type === 'stream_event') {
      const event = record(message.event); const delta = record(event?.delta);
      if (event?.type === 'content_block_delta' && typeof delta?.text === 'string') state.coalescer.push('agent', 'message', delta.text);
      if (event?.type === 'content_block_delta' && typeof delta?.thinking === 'string') state.coalescer.push('thinking', 'thinking', delta.thinking);
      return;
    }
    const content = record(message.message)?.content;
    if (!Array.isArray(content)) return;
    if (message.type === 'assistant') for (const raw of content) {
      const block = record(raw); if (block?.type !== 'tool_use') continue;
      const name = string(block.name) ?? 'tool'; const id = string(block.id); const input = stringifyToolValue(block.input);
      emit({ role: 'tool', kind: 'tool_use', text: `${name}${input ? ` ${input.replace(/\s+/g, ' ')}` : ''}`, tool: { ...(id ? { toolCallId: id } : {}), name, input } });
    }
    if (message.type === 'user') for (const raw of content) {
      const block = record(raw); if (block?.type !== 'tool_result') continue;
      const id = string(block.tool_use_id); const output = typeof block.content === 'string' ? block.content : stringifyToolValue(block.content);
      emit({ role: 'tool', kind: 'tool_result', text: truncateText(output), tool: { ...(id ? { toolCallId: id } : {}), name: 'tool', output, isError: block.is_error === true } });
    }
  }

  private sessionRef(state: SessionState): { sessionRef?: string } { return state.sdkSessionId ? { sessionRef: state.sdkSessionId } : {}; }
  private killed(state: SessionState): NodeOutcome { return { exitCode: null, signal: 'SIGTERM', ...this.sessionRef(state) }; }
  private enrich(raw: string, state: SessionState): string {
    let message = raw;
    if (/exited with code|exit code/i.test(raw) && state.stderrTail) {
      const excerpt = stripAnsi(state.stderrTail).replace(/\s+/g, ' ').trim().slice(-400);
      if (excerpt) message = `${message}: ${excerpt}`;
    }
    return redactEnvironmentValues(humanizeError(message, 'claude'));
  }
  private closeLive(state: SessionState): void { const live = state.live; delete state.live; try { live?.close(); } catch { /* best effort */ } state.abortController?.abort(); }
  private resetChangeIfRecycled(): void { if ([...this.sessions.values()].every((state) => !state.active && !state.live)) this.runtimeChanged = false; }
}

let singleton: SessionRuntime | undefined;
let testOverrides: RuntimeOverrides = {};
export function claudeSessionRuntime(): ClaudeSessionRuntime { return singleton ??= new SessionRuntime(testOverrides); }
export function resetClaudeSessionRuntimeForTest(overrides: RuntimeOverrides = {}): void {
  const previous = singleton; singleton = undefined; testOverrides = overrides; if (previous) void previous.dispose();
}
