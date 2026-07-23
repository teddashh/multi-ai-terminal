import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { codexChildEnv } from '../../adapters/codex.js';
import { redactEnvironmentValues } from '../../redact.js';
import { spawnManaged, type ManagedProcess } from '../../spawn.js';

export const UNHANDLED: unique symbol = Symbol('codex app-server method unhandled');

export interface CodexConnectionConfig {
  command: string;
  nodeCommand?: string;
  codexHome: string;
  apiKey?: string;
  extraEnv?: Readonly<Record<string, string | undefined>>;
  purpose: 'session' | 'login';
  cwd?: string;
  clientInfo: { name: string; title: string; version: string };
  onNotification: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onConnectionLost?: (error: Error) => void;
  isBusy?: () => boolean;
  idleReaper?: { checkIntervalMs?: number; idleAfterMs?: number } | false;
  /** Test seam only. Production callers leave this unset to use `app-server`. */
  spawnArgs?: string[];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectionSlot {
  child: ChildProcess;
  killGroup: ManagedProcess['killGroup'];
  nextId: number;
  pending: Map<number, PendingRequest>;
  buffer: string;
  ready: boolean;
  lost: boolean;
  handshake: Promise<void>;
}

export interface CodexRpcError extends Error {
  code: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_AFTER_MS = 300_000;

function errorMessage(error: unknown, environment: NodeJS.ProcessEnv = process.env): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactEnvironmentValues(raw, environment);
}

function connectionLostError(reason: string, environment: NodeJS.ProcessEnv = process.env): Error {
  return new Error(`Codex app-server connection lost: ${redactEnvironmentValues(reason, environment)}`);
}

function rpcError(code: number, message: string, environment: NodeJS.ProcessEnv = process.env): CodexRpcError {
  const error = new Error(redactEnvironmentValues(message, environment)) as CodexRpcError;
  error.code = code;
  return error;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class CodexConnection {
  private slot: ConnectionSlot | undefined;
  private spawning: Promise<ConnectionSlot> | undefined;
  private lastActivity = Date.now();
  private deferredRecycle: string | undefined;
  private readonly reaper?: ReturnType<typeof setInterval>;
  private readonly sinkEnvironment: NodeJS.ProcessEnv;

  constructor(private readonly config: CodexConnectionConfig) {
    this.sinkEnvironment = {
      ...process.env,
      ...config.extraEnv,
      ...(config.purpose === 'session' && config.apiKey !== undefined
        ? { OPENAI_API_KEY: config.apiKey }
        : {}),
    };
    if (config.idleReaper !== false) {
      const interval = config.idleReaper?.checkIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
      this.reaper = setInterval(() => this.reaperTick(), interval);
      this.reaper.unref();
    }
  }

  connected(): boolean {
    return this.slot?.ready === true && !this.slot.lost;
  }

  pid(): number | undefined {
    return this.slot?.child.pid;
  }

  async request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const slot = await this.ensureReady();
    return this.sendRequest(slot, method, params, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    void this.ensureReady()
      .then((slot) => this.write(slot, { method, params }))
      .catch(() => undefined);
  }

  async kill(): Promise<void> {
    const slot = this.slot;
    if (!slot) return;
    this.lose(slot, connectionLostError('terminated', this.sinkEnvironment));
  }

  /** Final teardown: kills the child AND stops the reaper. The instance stays
   * usable only in the lazy-respawn sense kill() allows; retire it after this. */
  async dispose(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await this.kill();
  }

  recycleIfIdle(reason: string): void {
    if (this.busy()) {
      this.deferredRecycle = reason;
      return;
    }
    this.deferredRecycle = undefined;
    this.recycle(reason);
  }

  private busy(): boolean {
    // An in-flight RPC (login can pend 300 s without a single output line) is
    // busy even before session wiring exists — the reaper must not SIGTERM a
    // child mid-request.
    if (this.slot && this.slot.pending.size > 0) return true;
    try {
      return this.config.isBusy?.() ?? false;
    } catch {
      return true;
    }
  }

  private reaperTick(): void {
    if (!this.slot) return;
    if (this.busy()) return;
    if (this.deferredRecycle !== undefined) {
      const reason = this.deferredRecycle;
      this.deferredRecycle = undefined;
      this.recycle(reason);
      return;
    }
    const idleAfter = this.config.idleReaper === false
      ? DEFAULT_IDLE_AFTER_MS
      : this.config.idleReaper?.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    if (Date.now() - this.lastActivity >= idleAfter) this.recycle('idle timeout');
  }

  private recycle(reason: string): void {
    const slot = this.slot;
    if (!slot) return;
    this.lose(slot, connectionLostError(reason, this.sinkEnvironment));
  }

  private async ensureReady(): Promise<ConnectionSlot> {
    if (this.slot) {
      const slot = this.slot;
      await slot.handshake;
      if (this.slot !== slot || slot.lost) return this.ensureReady();
      return slot;
    }
    if (!this.spawning) {
      this.spawning = this.spawnSlot();
      void this.spawning.finally(() => { this.spawning = undefined; }).catch(() => undefined);
    }
    const slot = await this.spawning;
    await slot.handshake;
    // The child can die between handshake resolution and our turn to run;
    // treat that like the existing-slot path and respawn instead of failing.
    // (The cast resets TS narrowing, which wrongly persists across the awaits.)
    const current = this.slot as ConnectionSlot | undefined;
    if (current !== slot || slot.lost) return this.ensureReady();
    return slot;
  }

  private async spawnSlot(): Promise<ConnectionSlot> {
    const env = codexChildEnv(this.config.command, this.config.nodeCommand);
    for (const [name, value] of Object.entries(this.config.extraEnv ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    env.CODEX_HOME = this.config.codexHome;
    if (this.config.purpose === 'session' && this.config.apiKey !== undefined) env.OPENAI_API_KEY = this.config.apiKey;
    else delete env.OPENAI_API_KEY;
    const unsetEnv = new Set(
      Object.entries(this.config.extraEnv ?? {})
        .filter(([, value]) => value === undefined)
        .map(([name]) => name),
    );
    if (!(this.config.purpose === 'session' && this.config.apiKey !== undefined)) {
      unsetEnv.add('OPENAI_API_KEY');
    }

    // spawnManaged is the project's one Windows-correct spawn seam: cross-spawn
    // .cmd shims, process-group kill with SIGKILL escalation, and loader-var
    // sanitization. Our env's PATH wins inside it because an explicit PATH
    // override replaces its augmented base.
    const managed = spawnManaged({
      command: this.config.command,
      args: this.config.spawnArgs ?? ['app-server'],
      cwd: this.config.cwd ?? homedir(),
      stdinOpen: true,
      env,
      ...(unsetEnv.size > 0 ? { unsetEnv: [...unsetEnv] } : {}),
    });
    const { child, killGroup } = managed;
    if (!child.stdout || !child.stdin) {
      try { killGroup('SIGTERM'); } catch { /* best-effort */ }
      throw connectionLostError('child spawned without stdio pipes', this.sinkEnvironment);
    }
    const slot: ConnectionSlot = { child, killGroup, nextId: 1, pending: new Map(), buffer: '', ready: false, lost: false, handshake: Promise.resolve() };
    this.slot = slot;
    this.lastActivity = Date.now();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(slot, chunk));
    child.stdout.once('end', () => {
      // Spawn errors and exits can close stdout first. Give their more useful,
      // redacted reason one event-loop turn to win before reporting plain EOF.
      setImmediate(() => this.lose(slot, connectionLostError('stdout closed', this.sinkEnvironment)));
    });
    // BAT runs the app-server with inherited stderr; spawnManaged pipes it, so
    // forward complete, redacted lines — an unconsumed pipe would eventually
    // block a chatty child, while raw forwarding could expose an env-sourced
    // provider credential in server logs.
    let stderrPending = '';
    const flushStderr = (final = false): void => {
      let newline = stderrPending.indexOf('\n');
      while (newline >= 0) {
        const line = stderrPending.slice(0, newline).replace(/\r$/, '');
        stderrPending = stderrPending.slice(newline + 1);
        process.stderr.write(`${redactEnvironmentValues(line, this.sinkEnvironment)}\n`);
        newline = stderrPending.indexOf('\n');
      }
      if (final && stderrPending) {
        process.stderr.write(redactEnvironmentValues(stderrPending, this.sinkEnvironment));
        stderrPending = '';
      }
    };
    child.stderr?.on('data', (chunk: string | Uint8Array) => {
      stderrPending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      flushStderr();
    });
    child.stderr?.once('end', () => flushStderr(true));
    child.once('exit', (code, signal) => {
      const detail = signal ? `exited with signal ${signal}` : `exited with code ${code ?? 'unknown'}`;
      this.lose(slot, connectionLostError(detail, this.sinkEnvironment));
    });
    child.once('error', (error) => this.lose(slot, connectionLostError(errorMessage(error, this.sinkEnvironment), this.sinkEnvironment)));
    child.stdin.on('error', (error) => this.lose(slot, connectionLostError(errorMessage(error, this.sinkEnvironment), this.sinkEnvironment)));

    slot.handshake = this.sendRequest(slot, 'initialize', {
      clientInfo: this.config.clientInfo,
      capabilities: { experimentalApi: true },
    }, DEFAULT_TIMEOUT_MS).then(() => {
      this.write(slot, { method: 'initialized', params: {} });
      slot.ready = true;
    }).catch((error) => {
      this.lose(slot, error instanceof Error
        ? error
        : connectionLostError(errorMessage(error, this.sinkEnvironment), this.sinkEnvironment));
      throw error;
    });
    return slot;
  }

  private sendRequest(slot: ConnectionSlot, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (slot.lost) return Promise.reject(connectionLostError('not connected', this.sinkEnvironment));
    const id = slot.nextId++;
    this.lastActivity = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      slot.pending.set(id, { resolve, reject, timer });
      try {
        this.write(slot, { method, id, params });
      } catch (error) {
        clearTimeout(timer);
        slot.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(slot: ConnectionSlot, message: Record<string, unknown>): void {
    const stdin = slot.child.stdin;
    if (slot.lost || !stdin?.writable) throw connectionLostError('stdin closed', this.sinkEnvironment);
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(slot: ConnectionSlot, chunk: string): void {
    if (slot.lost) return;
    slot.buffer += chunk;
    let newline = slot.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = slot.buffer.slice(0, newline).replace(/\r$/, '');
      slot.buffer = slot.buffer.slice(newline + 1);
      this.lastActivity = Date.now();
      if (line) this.dispatchLine(slot, line);
      newline = slot.buffer.indexOf('\n');
    }
  }

  private dispatchLine(slot: ConnectionSlot, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = objectValue(parsed);
    if (!message) return;
    const hasMethod = typeof message.method === 'string';
    const hasId = Object.hasOwn(message, 'id');
    if (hasMethod && hasId) {
      this.answerServerRequest(slot, message.id, message.method as string, message.params);
    } else if (hasMethod) {
      try {
        this.config.onNotification(message.method as string, message.params);
      } catch {
        // Notifications have no response channel; one consumer failure must not
        // stop JSONL dispatch for the shared connection.
      }
    } else if (hasId && typeof message.id === 'number') {
      this.handleResponse(slot, message.id, message);
    }
  }

  private handleResponse(slot: ConnectionSlot, id: number, message: Record<string, unknown>): void {
    const pending = slot.pending.get(id);
    if (!pending) return;
    slot.pending.delete(id);
    clearTimeout(pending.timer);
    const error = objectValue(message.error);
    if (error) {
      const code = typeof error.code === 'number' ? error.code : -32603;
      const messageText = typeof error.message === 'string' ? error.message : 'JSON-RPC error';
      pending.reject(rpcError(code, messageText, this.sinkEnvironment));
    } else {
      pending.resolve(message.result);
    }
  }

  private answerServerRequest(slot: ConnectionSlot, id: unknown, method: string, params: unknown): void {
    const handler = this.config.onServerRequest;
    if (!handler) {
      this.safeReply(slot, { id, error: { code: -32601, message: 'method not found' } });
      return;
    }
    void Promise.resolve().then(() => handler(method, params)).then((result) => {
      if (result === UNHANDLED) this.safeReply(slot, { id, error: { code: -32601, message: 'method not found' } });
      else this.safeReply(slot, { id, result });
    }, (error) => {
      this.safeReply(slot, { id, error: { code: -32603, message: errorMessage(error, this.sinkEnvironment) } });
    });
  }

  private safeReply(slot: ConnectionSlot, response: Record<string, unknown>): void {
    try {
      this.write(slot, response);
    } catch {
      // Connection loss owns pending cleanup; a server reply has no caller promise.
    }
  }

  private lose(slot: ConnectionSlot, error: Error): void {
    if (slot.lost) return;
    slot.lost = true;
    slot.ready = false;
    if (this.slot === slot) this.slot = undefined;
    for (const pending of slot.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    slot.pending.clear();
    // A child that half-closed stdout may still be alive; group-kill is a
    // no-op for one that already exited.
    try {
      slot.killGroup('SIGTERM');
    } catch {
      // Process cleanup is always best-effort.
    }
    try {
      this.config.onConnectionLost?.(error);
    } catch {
      // Cleanup is complete and connection-loss hooks are advisory.
    }
  }
}
