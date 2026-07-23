import type { AdapterContentEvent, Usage } from '@mat/shared';
import { ContentCoalescer, humanizeError } from '../../adapters/base.js';
import { redactEnvironmentValues } from '../../redact.js';
import { UNHANDLED, type CodexConnection } from './connection.js';
import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES } from './models.js';
import { parseTokenUsage, translateNotification, turnOutcome, type CodexCommandOutputs, type ParsedTokenUsage } from './translate.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const nestedId = (params: unknown, key: string): string | undefined => { const p = object(params); return text(p?.[`${key}Id`]) ?? text(object(p?.[key])?.id); };

export interface CodexTurnOptions { prompt: string; model: string; effort?: string; cwd: string; approvalPolicy?: string; sandbox?: string }
export interface CodexTurnOutcome { status: 'completed' | 'interrupted' | 'failed'; usage?: Usage; resultText?: string; error?: string; threadId?: string }
export interface CodexApprovalRequest { toolUseId: string; toolName: 'Bash' | 'Edit'; detail: Record<string, unknown>; reason?: string }
export interface ThreadManagerHooks {
  onEvent(sessionKey: string, event: AdapterContentEvent): void;
  onApprovalRequest?(sessionKey: string, request: CodexApprovalRequest): Promise<'accept' | 'acceptForSession' | 'decline'>;
  onStatus?(sessionKey: string, status: 'reconnecting' | 'ready'): void;
}

interface RunningTurn {
  pendingId?: string; liveId?: string; abortRequested: boolean; finished: boolean; resultText: string;
  interruptActive?: boolean;
  resolve(value: CodexTurnOutcome): void; promise: Promise<CodexTurnOutcome>;
}
interface SessionState {
  threadId?: string; generation: number; hasCompletedTurn: boolean; running?: RunningTurn;
  queue: Promise<void>; outputs: CodexCommandOutputs; coalescer: ContentCoalescer; reconnecting: boolean;
  tokenUsage?: ParsedTokenUsage;
}
interface PendingApproval { sessionKey: string; settle(value: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): void }

export class CodexThreadManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly threadOwners = new Map<string, string>();
  private readonly approvals = new Map<number, PendingApproval>();
  private approvalSeq = 0;
  private readonly staleTurns: string[] = [];
  private generation = 0;

  private readonly interruptSettleMs: number;

  constructor(private readonly connection: CodexConnection, private readonly hooks: ThreadManagerHooks, opts: { interruptSettleMs?: number } = {}) {
    this.interruptSettleMs = opts.interruptSettleMs ?? 5_000;
  }

  ownsSession(sessionKey: string): boolean { return this.sessions.has(sessionKey); }
  threadIdFor(sessionKey: string): string | undefined { return this.sessions.get(sessionKey)?.threadId; }
  tokenUsageFor(sessionKey: string): ParsedTokenUsage | undefined { return this.sessions.get(sessionKey)?.tokenUsage; }

  adoptThread(sessionKey: string, threadId: string): void {
    const state = this.state(sessionKey);
    if (state.threadId) this.threadOwners.delete(state.threadId);
    state.threadId = threadId;
    state.hasCompletedTurn = true;
    state.generation = this.generation - 1;
    this.threadOwners.set(threadId, sessionKey);
  }

  busy(): boolean {
    return this.approvals.size > 0 || [...this.sessions.values()].some((state) => state.running !== undefined && !state.running.finished);
  }

  startTurn(sessionKey: string, options: CodexTurnOptions): Promise<CodexTurnOutcome> {
    let result!: Promise<CodexTurnOutcome>;
    return this.enqueue(sessionKey, async (state) => {
      if (state.running && !state.running.finished) await this.interrupt(sessionKey, state);
      result = this.beginTurn(sessionKey, state, options);
    }).then(() => result);
  }

  abort(sessionKey: string): Promise<void> {
    this.cancelSessionApprovals(sessionKey);
    return this.enqueue(sessionKey, (state) => this.interrupt(sessionKey, state));
  }

  resetSession(sessionKey: string): void {
    void this.enqueue(sessionKey, async (state) => {
      if (state.running && !state.running.finished) await this.interrupt(sessionKey, state);
      if (state.threadId) this.threadOwners.delete(state.threadId);
      this.sessions.delete(sessionKey);
    });
  }

  /** Call from the connection's onConnectionLost callback before/alongside cancelAllApprovals. */
  noteConnectionLost(error?: unknown): void {
    this.generation += 1;
    this.cancelAllApprovals('connection lost');
    for (const [key, state] of this.sessions) if (state.running && !state.running.finished) this.finish(key, state, {
      status: state.running.abortRequested ? 'interrupted' : 'failed',
      ...(state.running.abortRequested ? {} : { error: this.safeError(error ?? 'connection lost') }),
    });
  }

  cancelAllApprovals(_reason: string): void { for (const approval of [...this.approvals.values()]) approval.settle('cancel'); }

  handleNotification(method: string, params: unknown): void {
    const turnId = nestedId(params, 'turn');
    if (turnId && this.staleTurns.includes(turnId)) return;
    const routed = this.route(params);
    if (!routed) return;
    const [sessionKey, state] = routed;
    const running = state.running;
    if (state.reconnecting && method !== 'error') { state.reconnecting = false; this.hooks.onStatus?.(sessionKey, 'ready'); }
    if (method === 'turn/started' && running) {
      const liveId = turnId ?? running.pendingId;
      if (liveId) running.liveId = liveId;
      if (running.abortRequested) void this.interrupt(sessionKey, state);
      return;
    }
    if (method === 'error') {
      const p = object(params); const message = p?.message ?? params;
      if (p?.willRetry === true) { state.reconnecting = true; this.hooks.onStatus?.(sessionKey, 'reconnecting'); }
      else if (running) this.finish(sessionKey, state, { status: 'failed', error: this.safeError(message) });
      return;
    }
    if (method === 'thread/tokenUsage/updated') { state.tokenUsage = parseTokenUsage(params); return; }
    if (method === 'turn/completed' && running) {
      // A completion for some other turn (a late duplicate from a replaced
      // turn) must not settle the active one. Fall through only when ids are
      // unknowable on either side.
      const known = running.liveId ?? running.pendingId;
      if (turnId && known && turnId !== running.liveId && turnId !== running.pendingId) return;
      state.coalescer.end();
      const outcome = turnOutcome(params) ?? { status: 'failed' as const };
      if (outcome.status === 'completed') state.hasCompletedTurn = true;
      this.cancelSessionApprovals(sessionKey);
      this.finish(sessionKey, state, { ...outcome, ...(outcome.status === 'failed' ? { error: this.safeError(object(object(params)?.turn)?.error ?? object(params)?.error ?? 'turn failed') } : {}) });
      return;
    }
    const events = translateNotification(method, params, state.outputs);
    for (const event of events) {
      if (event.role === 'agent' && event.kind === 'message') { if (running) running.resultText += event.text; state.coalescer.push('agent', 'message', event.text); }
      else if (event.role === 'thinking') state.coalescer.push('thinking', 'thinking', event.text);
      else this.hooks.onEvent(sessionKey, event);
    }
  }

  async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') return UNHANDLED;
    const routed = this.route(params);
    if (!routed) return 'decline';
    const [sessionKey] = routed; const p = object(params) ?? {}; const item = object(p.item) ?? p;
    const requestId = text(p.requestId) ?? String(p.id ?? item.id ?? 'unknown');
    const toolName = method.includes('commandExecution') ? 'Bash' : 'Edit';
    const detail = toolName === 'Bash' ? { command: item.command, cwd: item.cwd } : { summary: item.summary ?? item.changes };
    const reason = text(p.reason);
    const request: CodexApprovalRequest = { toolUseId: `codex-approval-${requestId}`, toolName, detail, ...(reason ? { reason } : {}) };
    // Keyed by a local counter: two id-less wire requests must never collide in
    // the map — an overwritten entry would leave its reply promise unsettled
    // and block the turn forever.
    const approvalKey = this.approvalSeq++;
    return new Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'>((resolve) => {
      let done = false;
      const settle = (value: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): void => { if (done) return; done = true; this.approvals.delete(approvalKey); resolve(value); };
      this.approvals.set(approvalKey, { sessionKey, settle });
      if (!this.hooks.onApprovalRequest) settle('decline');
      else void this.hooks.onApprovalRequest(sessionKey, request).then(settle, () => settle('decline'));
    });
  }

  private state(sessionKey: string): SessionState {
    let state = this.sessions.get(sessionKey);
    if (state) return state;
    state = { generation: this.generation, hasCompletedTurn: false, queue: Promise.resolve(), outputs: new Map(), reconnecting: false,
      coalescer: new ContentCoalescer((event) => this.hooks.onEvent(sessionKey, event)) };
    this.sessions.set(sessionKey, state);
    return state;
  }

  private enqueue(sessionKey: string, action: (state: SessionState) => Promise<void> | void): Promise<void> {
    const state = this.state(sessionKey);
    const next = state.queue.catch(() => undefined).then(() => action(state));
    state.queue = next.catch(() => undefined);
    return next;
  }

  private async beginTurn(sessionKey: string, state: SessionState, options: CodexTurnOptions): Promise<CodexTurnOutcome> {
    const approvalPolicy = CODEX_APPROVAL_POLICIES.includes(options.approvalPolicy as never) ? options.approvalPolicy! : 'on-request';
    const sandbox = CODEX_SANDBOX_MODES.includes(options.sandbox as never) ? options.sandbox! : 'workspace-write';
    let resolve!: (value: CodexTurnOutcome) => void;
    const promise = new Promise<CodexTurnOutcome>((done) => { resolve = done; });
    const running: RunningTurn = { abortRequested: false, finished: false, resultText: '', resolve, promise };
    state.running = running;
    try {
      await this.ensureThread(state, options, approvalPolicy, sandbox);
      const params = { threadId: state.threadId, input: [{ type: 'text', text: options.prompt, text_elements: [] }], model: options.model,
        ...(options.effort !== undefined ? { effort: options.effort } : {}), summary: 'auto', approvalPolicy, sandboxPolicy: { type: sandbox === 'read-only' ? 'readOnly' : sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' } };
      let response: unknown;
      try { response = await this.connection.request('turn/start', params, { timeoutMs: 60_000 }); }
      catch (error) {
        if (!/thread[^\n]*not found|not found[^\n]*thread/i.test(String(error))) throw error;
        await this.recoverThread(state, options, approvalPolicy, sandbox);
        response = await this.connection.request('turn/start', { ...params, threadId: state.threadId }, { timeoutMs: 60_000 });
      }
      const pendingId = nestedId(response, 'turn') ?? text(object(response)?.turnId);
      if (pendingId) running.pendingId = pendingId;
      if (running.abortRequested) void this.interrupt(sessionKey, state);
    } catch (error) { this.finish(sessionKey, state, { status: 'failed', error: this.safeError(error) }); }
    return promise;
  }

  private async ensureThread(state: SessionState, options: CodexTurnOptions, approvalPolicy: string, sandbox: string): Promise<void> {
    if (!state.threadId) return this.startThread(state, options, approvalPolicy, sandbox);
    if (state.generation !== this.generation) await this.recoverThread(state, options, approvalPolicy, sandbox);
  }
  private async recoverThread(state: SessionState, options: CodexTurnOptions, approvalPolicy: string, sandbox: string): Promise<void> {
    if (!state.hasCompletedTurn) return this.startThread(state, options, approvalPolicy, sandbox);
    await this.connection.request('thread/resume', { threadId: state.threadId, model: options.model, cwd: options.cwd, approvalPolicy, sandbox, serviceName: 'multi-ai-terminal' });
    state.generation = this.generation;
  }
  private async startThread(state: SessionState, options: CodexTurnOptions, approvalPolicy: string, sandbox: string): Promise<void> {
    const response = await this.connection.request('thread/start', { model: options.model, cwd: options.cwd, approvalPolicy, sandbox, serviceName: 'multi-ai-terminal' });
    const id = nestedId(response, 'thread') ?? text(object(response)?.threadId);
    if (!id) throw new Error('Codex thread/start returned no thread id');
    if (state.threadId) this.threadOwners.delete(state.threadId);
    state.threadId = id; state.generation = this.generation; this.threadOwners.set(id, [...this.sessions].find(([, value]) => value === state)?.[0] ?? '');
  }

  private async interrupt(sessionKey: string, state: SessionState): Promise<void> {
    const running = state.running;
    if (!running || running.finished) return;
    running.abortRequested = true; this.cancelSessionApprovals(sessionKey);
    // One driver at a time: the abort path and the late turn/started handler
    // both land here, and concurrent loops would double-send turn/interrupt.
    // Non-drivers still fall through to the settle wait below, so EVERY
    // interrupt() caller may safely replace the turn once this resolves.
    if (!running.interruptActive) {
      running.interruptActive = true;
      try {
        const deadline = Date.now() + 30_000;
        while (!running.liveId && !running.finished && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
        if (!running.finished && state.threadId) {
          let turnId = running.liveId ?? running.pendingId;
          if (turnId) {
            for (let attempts = 0; attempts < 6 && !running.finished; attempts += 1) {
              try { await this.connection.request('turn/interrupt', { threadId: state.threadId, turnId }); break; }
              catch (error) {
                const message = String(error); const found = /but found\s+([^\s.,]+)/i.exec(message)?.[1];
                if (found && attempts === 0) { turnId = found; running.liveId = found; continue; }
                if (/no active turn/i.test(message) && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
                break;
              }
            }
          }
        }
      } finally { running.interruptActive = false; }
    }
    // The interrupt RPC succeeding is not settlement: the server's
    // turn/completed lands later. Wait for it so a replacing turn can never
    // orphan this one's promise or inherit its completion, and force-settle
    // locally if the server stays silent.
    const settleBy = Date.now() + this.interruptSettleMs;
    while (!running.finished && Date.now() < settleBy) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!running.finished && state.running === running) this.finish(sessionKey, state, { status: 'interrupted' });
  }

  private finish(sessionKey: string, state: SessionState, outcome: Omit<CodexTurnOutcome, 'resultText' | 'threadId'>): void {
    const running = state.running; if (!running || running.finished) return;
    running.finished = true; state.coalescer.end();
    if (outcome.status === 'interrupted') this.rememberStale(running.liveId ?? running.pendingId);
    running.resolve({ ...outcome, ...(running.resultText ? { resultText: running.resultText } : {}), ...(state.threadId ? { threadId: state.threadId } : {}) });
    delete state.running; this.cancelSessionApprovals(sessionKey);
  }
  private rememberStale(id?: string): void { if (!id) return; this.staleTurns.push(id); if (this.staleTurns.length > 16) this.staleTurns.shift(); }
  private cancelSessionApprovals(sessionKey: string): void { for (const approval of [...this.approvals.values()]) if (approval.sessionKey === sessionKey) approval.settle('cancel'); }
  private safeError(value: unknown): string { return redactEnvironmentValues(humanizeError(value, 'codex')); }
  private route(params: unknown): [string, SessionState] | undefined {
    const threadId = nestedId(params, 'thread');
    const owner = threadId ? this.threadOwners.get(threadId) : undefined;
    if (owner) { const state = this.sessions.get(owner); if (state) return [owner, state]; }
    const active = [...this.sessions].filter(([, state]) => state.running && !state.running.finished);
    return active.length === 1 ? active[0] : undefined;
  }
}
