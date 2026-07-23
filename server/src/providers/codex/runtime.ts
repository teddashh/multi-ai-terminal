import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Adapter } from '../../adapters/base.js';
import { humanizeError, type NodeOutcome, type ResolvedNodeSpec, type SpawnedNode } from '../../adapters/base.js';
import { redactEnvironmentValues } from '../../redact.js';
import { resolveRuntimeBinary, runtimeBinaryForSpawn } from '../../runtime/resolve.js';
import { subscribeRuntimeChanges } from '../../runtime/triggers.js';
import { getDataDir } from '../../store/dataDir.js';
import { VERSION } from '../../version.js';
import { CodexConnection, type CodexConnectionConfig } from './connection.js';
import { DEFAULT_CODEX_MODEL } from './models.js';
import { CodexThreadManager } from './threads.js';

type SpawnIo = Parameters<Adapter['spawn']>[1];

export interface CodexSessionRuntime {
  startRun(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode;
  dispose(): Promise<void>;
}

interface RuntimeOverrides {
  createConnection?: (config: CodexConnectionConfig) => CodexConnection;
  resolveBinary?: typeof resolveRuntimeBinary;
  subscribe?: typeof subscribeRuntimeChanges;
}

class SessionRuntime implements CodexSessionRuntime {
  private connection: CodexConnection | undefined;
  private manager: CodexThreadManager | undefined;
  private setup: Promise<void> | undefined;
  private runtimeChanged = false;
  private readonly runs = new Map<string, SpawnIo>();
  private readonly unsubscribe: () => void;

  constructor(private readonly overrides: RuntimeOverrides) {
    this.unsubscribe = (overrides.subscribe ?? subscribeRuntimeChanges)((event) => {
      if (event.family !== 'codex') return;
      this.runtimeChanged = true;
      if (this.runs.size === 0) void this.retirePair();
      else this.connection?.recycleIfIdle('runtime changed');
    });
  }

  startRun(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode {
    const sessionKey = spec.resumeSessionRef ?? `run-${randomUUID()}`;
    this.runs.set(sessionKey, io);
    let killed = false;
    const completion = this.run(sessionKey, spec).then((outcome) => this.mapOutcome(outcome), (error): NodeOutcome => ({
      exitCode: 1,
      error: redactEnvironmentValues(humanizeError(error, 'codex')),
    })).finally(async () => {
      if (this.runs.get(sessionKey) === io) this.runs.delete(sessionKey);
      if (this.runtimeChanged && this.runs.size === 0) await this.retirePair();
    });
    return {
      pid: this.connection?.pid() ?? 0,
      kill: () => {
        if (killed) return;
        killed = true;
        // Chain on an existing setup only: after a failed or retired setup
        // there is no live turn to abort, and kill must never build a pair.
        const setup = this.setup;
        if (!setup) return;
        void setup.then(() => this.manager?.abort(sessionKey)).catch(() => undefined);
      },
      completion,
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.retirePair();
    this.runs.clear();
  }

  private async retirePair(): Promise<void> {
    // Clear synchronously so a concurrent startRun builds a fresh pair instead
    // of capturing this one mid-dispose; a disposal failure must never reach a
    // run's completion promise.
    const retired = this.connection;
    this.connection = undefined;
    this.manager = undefined;
    this.setup = undefined;
    this.runtimeChanged = false;
    try { await retired?.dispose(); } catch { /* best-effort teardown */ }
  }

  private async run(sessionKey: string, spec: ResolvedNodeSpec) {
    await this.ensureSetup();
    const manager = this.manager!;
    if (spec.resumeSessionRef && !manager.ownsSession(sessionKey)) manager.adoptThread(sessionKey, spec.resumeSessionRef);
    return manager.startTurn(sessionKey, {
      prompt: spec.promptText,
      model: spec.binding.model ?? DEFAULT_CODEX_MODEL,
      ...(spec.binding.effort !== undefined ? { effort: spec.binding.effort } : {}),
      cwd: spec.cwd,
      approvalPolicy: 'never',
      sandbox: spec.binding.permission === 'safe' ? 'read-only' : spec.binding.permission === 'full' ? 'danger-full-access' : 'workspace-write',
    });
  }

  private mapOutcome(outcome: Awaited<ReturnType<CodexThreadManager['startTurn']>>): NodeOutcome {
    if (outcome.status === 'completed') return { exitCode: 0, ...(outcome.threadId ? { sessionRef: outcome.threadId } : {}), ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.resultText ? { resultText: outcome.resultText } : {}) };
    if (outcome.status === 'interrupted') return { exitCode: null, signal: 'SIGTERM', ...(outcome.threadId ? { sessionRef: outcome.threadId } : {}) };
    return { exitCode: 1, error: outcome.error ?? 'Codex turn failed', ...(outcome.threadId ? { sessionRef: outcome.threadId } : {}) };
  }

  private ensureSetup(): Promise<void> {
    if (this.setup) return this.setup;
    const setup = this.createPair().catch((error) => {
      if (this.setup === setup) this.setup = undefined;
      throw error;
    });
    this.setup = setup;
    return setup;
  }

  private async createPair(): Promise<void> {
    const resolve = this.overrides.resolveBinary ?? resolveRuntimeBinary;
    // Exec-path parity: a failed probe (transient or otherwise) falls back to
    // the unprobed spawn command; a truly missing CLI surfaces at spawn time.
    const command = (await resolve(getDataDir(), 'codex')) ?? runtimeBinaryForSpawn(getDataDir(), 'codex');
    const resolvedNode = await resolve(getDataDir(), 'node');
    const nodeCommand = resolvedNode && resolvedNode !== 'node' && isAbsolute(resolvedNode) ? resolvedNode : process.execPath;
    let manager!: CodexThreadManager;
    const config: CodexConnectionConfig = {
      command,
      nodeCommand,
      codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      ...(process.env.OPENAI_API_KEY !== undefined ? { apiKey: process.env.OPENAI_API_KEY } : {}),
      purpose: 'session',
      clientInfo: { name: 'multi-ai-terminal', title: 'Multi-AI Terminal', version: VERSION },
      onNotification: (method, params) => manager.handleNotification(method, params),
      onServerRequest: (method, params) => manager.handleServerRequest(method, params),
      onConnectionLost: (error) => manager.noteConnectionLost(error),
      isBusy: () => manager.busy(),
    };
    const connection = (this.overrides.createConnection ?? ((value) => new CodexConnection(value)))(config);
    manager = new CodexThreadManager(connection, {
      onEvent: (sessionKey, event) => this.runs.get(sessionKey)?.onEvent(event),
      onStatus: (sessionKey, status) => {
        const io = this.runs.get(sessionKey);
        if (status === 'reconnecting') io?.onRaw('[codex] reconnecting…', 'err');
        else if (status === 'ready') io?.onRaw('[codex] ready', 'err');
      },
    });
    this.connection = connection;
    this.manager = manager;
  }
}

let singleton: SessionRuntime | undefined;
let testOverrides: RuntimeOverrides = {};

export function codexSessionRuntime(): CodexSessionRuntime {
  return singleton ??= new SessionRuntime(testOverrides);
}

export function resetCodexSessionRuntimeForTest(overrides: RuntimeOverrides = {}): void {
  const previous = singleton;
  singleton = undefined;
  testOverrides = overrides;
  if (previous) void previous.dispose();
}
