import { randomUUID } from 'node:crypto';
import type { Usage } from '@mat/shared';
import type { Adapter, NodeOutcome, ResolvedNodeSpec, SpawnedNode } from '../../adapters/base.js';
import { humanizeError } from '../../adapters/base.js';
import { redactEnvironmentValues } from '../../redact.js';

export type CliSpawnIo = Parameters<Adapter['spawn']>[1];
export type CliTransport = (spec: ResolvedNodeSpec, io: CliSpawnIo) => SpawnedNode;

export interface CliSessionManagerOptions {
  provider: string;
  resumable: boolean;
  spawn: CliTransport;
  killFallbackMs?: number;
  createSessionId?: () => string;
}

interface PendingRun {
  spec: ResolvedNodeSpec;
  io: CliSpawnIo;
  completion: Promise<NodeOutcome>;
  resolve(outcome: NodeOutcome): void;
  spawned?: SpawnedNode;
  killed: boolean;
  settled: boolean;
  fallback?: ReturnType<typeof setTimeout>;
  state: SessionState;
}

interface SessionState {
  key: string;
  active?: PendingRun;
  queue: PendingRun[];
}

const DEFAULT_KILL_FALLBACK_MS = 10_000;
const KILLED_OUTCOME = (): NodeOutcome => ({ exitCode: null, signal: 'SIGTERM' });

function usageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Enforce the strict shared Usage shape at the provider-manager boundary. */
export function normalizeCliUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = usageNumber(raw.inputTokens);
  const outputTokens = usageNumber(raw.outputTokens);
  const costUsd = usageNumber(raw.costUsd);
  const usage: Usage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * FIFO coordinator for one-shot CLI transports.
 *
 * A resumable provider uses its resume reference as the session key. Fresh
 * turns, and every turn for a non-resumable provider, receive an ephemeral key
 * and can therefore run in parallel. The first turn in an idle session is
 * spawned synchronously so the adapter can expose the real child pid.
 */
export class CliSessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly killFallbackMs: number;
  private readonly createSessionId: () => string;
  private freshSequence = 0;

  constructor(private readonly options: CliSessionManagerOptions) {
    this.killFallbackMs = options.killFallbackMs ?? DEFAULT_KILL_FALLBACK_MS;
    this.createSessionId = options.createSessionId ?? randomUUID;
  }

  startRun(spec: ResolvedNodeSpec, io: CliSpawnIo): SpawnedNode {
    const state = this.session(spec);
    let resolve!: (outcome: NodeOutcome) => void;
    const completion = new Promise<NodeOutcome>((done) => { resolve = done; });
    const run: PendingRun = {
      spec,
      io,
      completion,
      resolve,
      killed: false,
      settled: false,
      state,
    };
    state.queue.push(run);
    if (!state.active) this.startNext(state);

    return {
      // startNext() is deliberately synchronous on the idle-session path.
      pid: run.spawned?.pid ?? 0,
      kill: () => this.kill(run),
      completion,
    };
  }

  dispose(): void {
    for (const state of [...this.sessions.values()]) {
      if (state.active) this.kill(state.active);
      for (const run of [...state.queue]) this.kill(run);
    }
  }

  private session(spec: ResolvedNodeSpec): SessionState {
    const key = this.options.resumable && spec.resumeSessionRef
      ? `resume:${spec.resumeSessionRef}`
      : `run:${this.createSessionId()}:${this.freshSequence++}`;
    let state = this.sessions.get(key);
    if (!state) {
      state = { key, queue: [] };
      this.sessions.set(key, state);
    }
    return state;
  }

  private startNext(state: SessionState): void {
    if (state.active) return;
    const run = state.queue.shift();
    if (!run) {
      if (this.sessions.get(state.key) === state) this.sessions.delete(state.key);
      return;
    }
    if (run.killed) {
      this.settle(run, KILLED_OUTCOME());
      return;
    }

    state.active = run;
    try {
      const spawned = this.options.spawn(run.spec, this.guardedIo(run));
      run.spawned = spawned;
      void Promise.resolve(spawned.completion).then(
        (outcome) => this.finishTransport(run, outcome),
        (error: unknown) => this.finishTransport(run, undefined, error),
      );
    } catch (error) {
      this.settle(run, run.killed ? KILLED_OUTCOME() : this.failed(error));
      this.release(run);
    }
  }

  private kill(run: PendingRun): void {
    if (run.killed || run.settled) return;
    run.killed = true;

    if (run.state.active !== run) {
      const index = run.state.queue.indexOf(run);
      if (index >= 0) run.state.queue.splice(index, 1);
      this.settle(run, KILLED_OUTCOME());
      return;
    }

    try {
      run.spawned?.kill('SIGTERM');
    } catch {
      // The bounded fallback below remains authoritative.
    }
    run.fallback = setTimeout(() => this.settle(run, KILLED_OUTCOME()), this.killFallbackMs);
    run.fallback.unref?.();
  }

  private settle(run: PendingRun, outcome: NodeOutcome): void {
    if (run.settled) return;
    run.settled = true;
    if (run.fallback) clearTimeout(run.fallback);
    run.resolve(outcome);

    const state = run.state;
    if (state.active !== run && !state.active && state.queue.length === 0 && this.sessions.get(state.key) === state) {
      this.sessions.delete(state.key);
    }
  }

  private finishTransport(run: PendingRun, outcome?: NodeOutcome, error?: unknown): void {
    if (!run.settled) {
      if (run.killed) this.settle(run, KILLED_OUTCOME());
      else {
        try {
          this.settle(run, error === undefined && outcome !== undefined
            ? this.normalizeOutcome(outcome)
            : this.failed(error));
        } catch (caught) {
          this.settle(run, this.failed(caught));
        }
      }
    }
    // A kill fallback settles the public completion but deliberately keeps
    // this session occupied. Starting the next resume turn before the old
    // transport actually closes would overlap two children on one session.
    this.release(run);
  }

  private release(run: PendingRun): void {
    const state = run.state;
    if (state.active !== run) return;
    delete state.active;
    this.startNext(state);
  }

  private guardedIo(run: PendingRun): CliSpawnIo {
    return {
      onEvent: (event) => {
        if (!run.killed && !run.settled) run.io.onEvent(event);
      },
      onRaw: (line, stream) => {
        if (!run.killed && !run.settled) run.io.onRaw(line, stream);
      },
    };
  }

  private normalizeOutcome(outcome: NodeOutcome): NodeOutcome {
    const usage = normalizeCliUsage(outcome.usage);
    const shared = {
      ...(typeof outcome.sessionRef === 'string' && outcome.sessionRef.length > 0
        ? { sessionRef: redactEnvironmentValues(outcome.sessionRef) }
        : {}),
      ...(usage ? { usage } : {}),
      ...(typeof outcome.resultText === 'string' && outcome.resultText.length > 0 ? { resultText: outcome.resultText } : {}),
    };
    const reportedError = typeof outcome.error === 'string' && outcome.error.trim().length > 0
      ? outcome.error
      : undefined;
    if (outcome.exitCode === 0 && !reportedError) return { exitCode: 0, ...shared };

    const fallback = outcome.signal
      ? `${this.options.provider} transport ended with signal ${outcome.signal}`
      : `${this.options.provider} exited ${String(outcome.exitCode)}`;
    return { exitCode: 1, ...shared, error: this.safeError(reportedError ?? fallback) };
  }

  private failed(error: unknown): NodeOutcome {
    return { exitCode: 1, error: this.safeError(error) };
  }

  private safeError(error: unknown): string {
    const normalized = humanizeError(error, this.options.provider).trim()
      || `${this.options.provider} transport failed`;
    return redactEnvironmentValues(normalized);
  }
}
