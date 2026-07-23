import {
  ProviderEventSchema,
  ProviderSessionMetaSchema,
  type AdapterContentEvent,
  type ProviderEvent,
  type ProviderSessionMeta,
  type ProviderTurnEndPayload,
  type ProviderTurnEndReason,
  type Usage,
} from '@mat/shared';
import {
  stringifyToolValue,
  truncateText,
  type NodeOutcome,
  type ResolvedNodeSpec,
} from '../adapters/base.js';
import { redactEnvironmentValues, redactJsonValue } from '../redact.js';

export interface ProviderTechnicalEvidence {
  text: string;
  data: Record<string, unknown>;
}

export interface ProviderContractSink {
  onContent(event: AdapterContentEvent): void;
  onTechnical(event: ProviderTechnicalEvidence): void;
}

export interface ProviderTurnBridgeOptions {
  provider: string;
  sessionId: string;
  spec: ResolvedNodeSpec;
  sink: ProviderContractSink;
  now?: () => number;
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  shell: 'Bash',
  commandexecution: 'Bash',
  filechange: 'Edit',
  websearch: 'WebSearch',
  todolist: 'TodoWrite',
};

export function canonicalToolName(name: string): string {
  const key = name.replace(/[-_\s]/g, '').toLowerCase();
  return TOOL_NAMES[key] ?? name;
}

const definedEntries = <T extends object>(value: T): Partial<T> => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => entry !== undefined),
) as Partial<T>;

export function buildProviderSessionMeta(
  overrides: Partial<ProviderSessionMeta> = {},
): ProviderSessionMeta {
  return ProviderSessionMetaSchema.parse({
    permissionMode: 'default',
    model: null,
    effort: null,
    ultracode: false,
    autoCompactWindow: null,
    sdkSessionId: null,
    cwd: null,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    numTurns: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    contextTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    callCacheRead: 0,
    callCacheWrite: 0,
    lastQueryCalls: 0,
    isStreaming: false,
    runtimeStatus: null,
    runtimeMessage: null,
    runtimeStatusStartedAt: null,
    ...definedEntries(overrides),
  });
}

function permissionMode(spec: ResolvedNodeSpec): string {
  if (spec.binding.permission === 'safe') return 'plan';
  if (spec.binding.permission === 'full') return 'bypassPermissions';
  return 'acceptEdits';
}

function usageFrom(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const number = (entry: unknown): number | undefined => (
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : undefined
  );
  const inputTokens = number(record.inputTokens ?? record.input_tokens);
  const outputTokens = number(record.outputTokens ?? record.output_tokens);
  const costUsd = number(record.costUsd ?? record.cost_usd ?? record.total_cost_usd);
  const usage: Usage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function terminalReason(outcome: NodeOutcome): ProviderTurnEndReason {
  if (outcome.signal || (outcome.exitCode === null && outcome.error === undefined)) return 'interrupted';
  return outcome.exitCode === 0 && outcome.error === undefined ? 'completed' : 'error';
}

function safeMeta(meta: ProviderSessionMeta): ProviderSessionMeta {
  return ProviderSessionMetaSchema.parse(redactJsonValue(meta));
}

function safeRecord(value: unknown): Record<string, unknown> {
  const redacted = redactJsonValue(value);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

/**
 * One provider-neutral turn boundary.
 *
 * Native managers feed content through acceptContent(), or richer BAT-shaped
 * events through emit(). This bridge is the only projection back to the
 * adapter content contract; nodeRunner remains the sole AgentEvent writer.
 */
export class ProviderTurnBridge {
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #toolNames = new Map<string, string>();
  readonly #anonymousToolIds: string[] = [];
  #meta: ProviderSessionMeta;
  #messageSequence = 0;
  #toolSequence = 0;
  #started = false;
  #responded = false;
  #ended = false;
  #finishCalled = false;
  #terminal: ProviderTurnEndPayload | undefined;
  #result: Record<string, unknown> | undefined;
  #fatalError: string | undefined;

  constructor(readonly options: ProviderTurnBridgeOptions) {
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#meta = buildProviderSessionMeta({
      permissionMode: permissionMode(options.spec),
      model: options.spec.binding.model ?? null,
      effort: options.spec.binding.effort ?? null,
      cwd: options.spec.cwd,
    });
  }

  get sessionId(): string { return this.options.sessionId; }
  get meta(): ProviderSessionMeta { return this.#meta; }
  get hasEnded(): boolean { return this.#ended; }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.updateStatus({
      isStreaming: true,
      runtimeStatus: 'starting',
      runtimeMessage: `${this.options.provider} runtime starting`,
      runtimeStatusStartedAt: this.#now(),
    });
  }

  updateStatus(patch: Partial<ProviderSessionMeta>): void {
    this.#meta = buildProviderSessionMeta({ ...this.#meta, ...definedEntries(patch) });
    this.emit({
      type: 'claude:status',
      sessionId: this.sessionId,
      meta: this.#meta,
    });
  }

  acceptContent(event: AdapterContentEvent): void {
    const sourceData = event.data;
    if (event.kind === 'message') {
      this.project(ProviderEventSchema.parse({
        type: 'claude:message',
        sessionId: this.sessionId,
        message: {
          id: `provider-message-${++this.#messageSequence}`,
          sessionId: this.sessionId,
          role: event.role === 'user' ? 'user' : 'assistant',
          content: event.text,
          timestamp: this.#now(),
        },
      }), sourceData);
      return;
    }
    if (event.kind === 'thinking') {
      this.project(ProviderEventSchema.parse({
        type: 'claude:stream',
        sessionId: this.sessionId,
        data: { thinking: event.text },
      }), sourceData);
      return;
    }
    const suppliedId = event.tool?.toolCallId;
    const id = suppliedId && suppliedId.length > 0
      ? suppliedId
      : event.kind === 'tool_result' && this.#anonymousToolIds.length > 0
        ? this.#anonymousToolIds.shift()!
        : `provider-tool-${++this.#toolSequence}`;
    if (event.kind === 'tool_use') {
      if (!suppliedId) this.#anonymousToolIds.push(id);
      this.project(ProviderEventSchema.parse({
        type: 'claude:tool-use',
        sessionId: this.sessionId,
        toolCall: {
          id,
          sessionId: this.sessionId,
          toolName: event.tool?.name ?? 'tool',
          input: event.tool?.input ?? event.text,
          status: 'running',
        },
      }), sourceData);
      return;
    }
    this.project(ProviderEventSchema.parse({
      type: 'claude:tool-result',
      sessionId: this.sessionId,
      result: {
        id,
        status: event.tool?.isError === true ? 'error' : 'completed',
        result: event.tool?.output ?? event.text,
      },
    }), sourceData);
  }

  emit(rawEvent: ProviderEvent): void {
    this.project(ProviderEventSchema.parse(rawEvent));
  }

  finish(outcome: NodeOutcome, reasonOverride?: ProviderTurnEndReason): NodeOutcome {
    if (this.#finishCalled) throw new Error(`Provider turn ${this.sessionId} finished more than once`);
    this.#finishCalled = true;
    const reason = reasonOverride ?? this.#terminal?.reason ?? terminalReason(outcome);
    const usage = usageFrom(outcome.usage)
      ?? usageFrom(this.#terminal?.usage)
      ?? usageFrom(this.#result?.usage);
    const resultText = outcome.resultText
      ?? this.#terminal?.result
      ?? (typeof this.#result?.result === 'string' ? this.#result.result : undefined);
    const error = outcome.error ?? this.#terminal?.error ?? this.#fatalError;
    const sessionRef = outcome.sessionRef ?? this.#terminal?.sdkSessionId;
    const durationMs = Math.max(0, this.#now() - this.#startedAt);
    this.updateStatus({
      ...(sessionRef ? { sdkSessionId: sessionRef } : {}),
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.costUsd !== undefined ? { totalCost: usage.costUsd } : {}),
      contextTokens: (usage?.inputTokens ?? this.#meta.inputTokens)
        + (usage?.outputTokens ?? this.#meta.outputTokens),
      durationMs,
      numTurns: Math.max(1, this.#meta.numTurns),
      lastQueryCalls: 1,
      isStreaming: false,
      runtimeStatus: null,
      runtimeMessage: null,
      runtimeStatusStartedAt: null,
    });
    if (!this.#ended) {
      if (reason === 'error' && error) {
        this.emit({ type: 'claude:error', sessionId: this.sessionId, error });
      } else {
        this.emit({
          type: 'claude:result',
          sessionId: this.sessionId,
          result: {
            subtype: reason === 'completed' ? 'success' : reason,
            ...(resultText ? { result: resultText } : {}),
            ...(usage ? { usage } : {}),
          },
        });
      }
      this.emit({
        type: 'claude:turn-end',
        sessionId: this.sessionId,
        payload: {
          reason,
          ...(resultText ? { result: resultText } : {}),
          ...(error ? { error } : {}),
          ...(sessionRef ? { sdkSessionId: sessionRef } : {}),
          ...(usage ? { usage } : {}),
        },
      });
    }
    const finalReason = reason;
    const safeOutcome: NodeOutcome = { ...outcome };
    delete safeOutcome.usage;
    delete safeOutcome.providerTurn;
    return {
      ...safeOutcome,
      ...(sessionRef ? { sessionRef } : {}),
      ...(usage ? { usage } : {}),
      ...(resultText ? { resultText } : {}),
      ...(error ? { error } : {}),
      providerTurn: {
        event: 'claude:turn-end',
        sessionId: redactEnvironmentValues(this.sessionId),
        reason: finalReason,
        status: safeMeta(this.#meta),
      },
    };
  }

  private responded(): void {
    if (this.#responded || !this.#started || this.#meta.runtimeStatus === null) return;
    this.#responded = true;
    this.updateStatus({
      runtimeStatus: null,
      runtimeMessage: null,
      runtimeStatusStartedAt: null,
    });
  }

  private project(event: ProviderEvent, sourceData?: Record<string, unknown>): void {
    if (event.sessionId !== this.sessionId) {
      throw new Error(`Provider event session mismatch: ${event.sessionId} !== ${this.sessionId}`);
    }
    if (this.#ended && event.type !== 'claude:history') {
      if (event.type === 'claude:turn-end') throw new Error(`Provider turn ${this.sessionId} emitted more than one turn-end`);
      return;
    }
    const contentData = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...(sourceData ?? {}),
      ...extra,
      providerEvent: event.type,
      providerSessionId: redactEnvironmentValues(this.sessionId),
    });
    if (event.type === 'claude:message') {
      if (event.message.role === 'user') return;
      this.responded();
      if (event.message.thinking) {
        this.options.sink.onContent({
          role: 'thinking',
          kind: 'thinking',
          text: event.message.thinking,
          data: contentData({ providerMessageId: redactEnvironmentValues(event.message.id) }),
        });
      }
      if (event.message.content) {
        this.options.sink.onContent({
          role: 'agent',
          kind: 'message',
          text: event.message.content,
          data: contentData({ providerMessageId: redactEnvironmentValues(event.message.id) }),
        });
      }
      return;
    }
    if (event.type === 'claude:stream') {
      this.responded();
      const parent = event.data.parentToolUseId
        ? { parentToolUseId: redactEnvironmentValues(event.data.parentToolUseId) }
        : {};
      if (event.data.thinking !== undefined) this.options.sink.onContent({
        role: 'thinking',
        kind: 'thinking',
        text: event.data.thinking,
        data: contentData(parent),
      });
      if (event.data.text !== undefined) this.options.sink.onContent({
        role: 'agent',
        kind: 'message',
        text: event.data.text,
        data: contentData(parent),
      });
      return;
    }
    if (event.type === 'claude:tool-use') {
      this.responded();
      const name = canonicalToolName(event.toolCall.toolName);
      const input = stringifyToolValue(event.toolCall.input);
      this.#toolNames.set(event.toolCall.id, name);
      this.options.sink.onContent({
        role: 'tool',
        kind: 'tool_use',
        text: `${name}${input ? ` ${input.replace(/\s+/g, ' ')}` : ''}`,
        tool: {
          toolCallId: event.toolCall.id,
          name,
          input,
        },
        data: contentData(event.toolCall.parentToolUseId
          ? { parentToolUseId: redactEnvironmentValues(event.toolCall.parentToolUseId) }
          : {}),
      });
      return;
    }
    if (event.type === 'claude:tool-result') {
      this.responded();
      const name = this.#toolNames.get(event.result.id) ?? 'tool';
      this.#toolNames.delete(event.result.id);
      const output = truncateText(
        typeof event.result.result === 'string'
          ? event.result.result
          : stringifyToolValue(event.result.result),
      );
      this.options.sink.onContent({
        role: 'tool',
        kind: 'tool_result',
        text: output,
        tool: {
          toolCallId: event.result.id,
          name,
          output,
          isError: event.result.status === 'error',
        },
        data: contentData(),
      });
      return;
    }
    if (event.type === 'claude:status') {
      this.#meta = event.meta;
      this.technical(event.type, 'provider status', {
        providerStatus: safeMeta(event.meta),
      });
      return;
    }
    if (event.type === 'claude:result') {
      this.#result = event.result;
      return;
    }
    if (event.type === 'claude:error') {
      this.#fatalError = redactEnvironmentValues(event.error);
      return;
    }
    if (event.type === 'claude:turn-end') {
      if (this.#ended) throw new Error(`Provider turn ${this.sessionId} emitted more than one turn-end`);
      this.#terminal = event.payload;
      this.#ended = true;
      return;
    }
    if (event.type === 'claude:history') {
      // MAT events.jsonl is the replay authority. Provider history hydrates a
      // manager session only and must never be appended as fresh evidence.
      return;
    }
    if (event.type === 'claude:rate-limit') {
      this.technical(event.type, 'provider rate limit', { rateLimit: safeRecord(event.info) });
      return;
    }
    if (event.type === 'claude:task') {
      this.technical(event.type, 'provider task', { task: safeRecord(event.task) });
      return;
    }
    if (event.type === 'claude:permission-request' || event.type === 'claude:ask-user') {
      this.technical(event.type, 'provider interaction request', { request: safeRecord(event.data) });
      return;
    }
    if (event.type === 'claude:permission-resolved' || event.type === 'claude:ask-user-resolved') {
      this.technical(event.type, 'provider interaction resolved', {
        toolUseId: redactEnvironmentValues(event.toolUseId),
      });
      return;
    }
    if (event.type === 'claude:modeChange') {
      this.technical(event.type, 'provider mode changed', {
        mode: redactEnvironmentValues(event.mode),
      });
      return;
    }
    if (event.type === 'claude:resume-loading') {
      this.technical(event.type, 'provider resume state', { loading: event.loading });
      return;
    }
    if (event.type === 'claude:session-reset') {
      this.technical(event.type, 'provider session reset');
      return;
    }
    this.technical(event.type, 'provider worktree state', {
      worktree: event.payload === null ? null : safeRecord(event.payload),
    });
  }

  private technical(
    providerEvent: ProviderEvent['type'],
    text: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.options.sink.onTechnical({
      text,
      data: {
        ...payload,
        detail: `provider-${providerEvent.slice('claude:'.length)}`,
        providerEvent,
        provider: this.options.provider,
        providerSessionId: redactEnvironmentValues(this.sessionId),
      },
    });
  }
}
