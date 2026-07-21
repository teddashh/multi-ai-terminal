import type { AdapterContentEvent, AgentBinding, ProviderId, Usage } from '@mat/shared';
import type { ChildProcess } from 'node:child_process';
import { spawnManaged } from '../spawn.js';
import { diag } from '../diag.js';
import { signInCommand } from '../providers/auth.js';
import { redactEnvironmentValues } from '../redact.js';

export interface ResolvedNodeSpec {
  binding: AgentBinding; promptText: string; cwd: string;
  resumeSessionRef?: string;
}
export interface NodeOutcome {
  exitCode: number | null; signal?: string;
  sessionRef?: string; usage?: Usage;
  resultText?: string;
  error?: string;
}
export interface SpawnedNode { pid: number; kill(sig?: NodeJS.Signals): void; completion: Promise<NodeOutcome> }
export interface Adapter {
  id: ProviderId; tier: 'rich' | 'plain';
  available(): Promise<{ ok: boolean; version?: string; detail?: string }>;
  spawn(spec: ResolvedNodeSpec, io: { onEvent(e: AdapterContentEvent): void; onRaw(line: string, stream: 'out'|'err'): void }): SpawnedNode;
  models: string[]; defaultModel: string;
}
export type { AdapterContentEvent } from '@mat/shared';

const AUTH_PATTERNS = [
  /refresh token[\s\S]*?(?:revoked|already used)/i,
  /refresh_token_invalidated/i,
  /401 Unauthorized/i,
  /not signed in/i,
  /log out and sign in again/i,
  /please (?:sign|log) in/i,
  /authentication (?:failed|required)/i,
  /invalid api key/i,
];

const SAFE_AUTH_INSTRUCTIONS: Readonly<Record<string, readonly string[]>> = {
  codex: ['codex logout && codex login', 'codex login'],
  grok: ['grok login --device-code', 'grok login'],
};

function safeAuthInstruction(provider: string, text: string): string | undefined {
  const allowed = SAFE_AUTH_INSTRUCTIONS[provider];
  if (!allowed) return undefined;
  const candidates = text.split(/\r?\n/).map((line) => line.trim().replace(/^run:\s*/i, '').replace(/^`([^`]+)`[.!]?$/, '$1'));
  // Return our canonical copy, never CLI-controlled text. Extra arguments are
  // rejected because a pairing code or token can otherwise look like a flag.
  return allowed.find((instruction) => candidates.some((candidate) => candidate.toLowerCase() === instruction.toLowerCase()));
}

export function detectAuthFailure(provider: string, text: string): string | undefined {
  if (provider === 'mock') return undefined;
  const tail = text.slice(-4096);
  if (!AUTH_PATTERNS.some((pattern) => pattern.test(tail))) return undefined;
  const command = signInCommand(provider);
  if (!command) return undefined;
  const expired = /refresh(?:_| )token|401 Unauthorized/i.test(tail);
  const message = `${provider}${expired ? ' sign-in expired.' : ' is not signed in.'}\nFix: ${command}`;
  const instruction = safeAuthInstruction(provider, tail);
  return redactEnvironmentValues(instruction ? `${message}\n${instruction}` : message);
}

interface ExtractedError {
  message?: string;
  status?: string;
  type?: string;
}

function extractError(value: unknown, depth: number, result: ExtractedError): void {
  if (depth > 3 || value === null || value === undefined || result.message) return;
  if (value instanceof Error) { extractError(value.message, depth + 1, result); return; }
  if (typeof value === 'string') {
    const message = value.trim();
    if (!message) return;
    try {
      const parsed: unknown = JSON.parse(message);
      if (parsed !== message) { extractError(parsed, depth, result); return; }
    } catch { /* Plain error text is already the best available message. */ }
    result.message = message;
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') { result.message = String(value); return; }
  if (typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (result.status === undefined && (typeof record.status === 'string' || typeof record.status === 'number')) result.status = String(record.status);
  if (result.type === undefined && typeof record.type === 'string' && record.type !== 'error') result.type = record.type;
  for (const key of ['error', 'message', 'reason'] as const) extractError(record[key], depth + 1, result);
}

export function humanizeError(value: unknown, provider?: string): string {
  const extracted: ExtractedError = {};
  extractError(value, 0, extracted);
  const original = typeof value === 'string' ? value : (value instanceof Error ? value.message : String(value));
  const message = extracted.message ?? original;
  const spawn = /spawn (\S+) ENOENT/.exec(message);
  if (spawn?.[1]) return `\`${spawn[1]}\` CLI not found on PATH — install it or remove this agent from the workflow.`;
  if (provider && provider !== 'mock' && (/refresh token .*(revoked|already used)/i.test(message) || /401 Unauthorized/.test(message))) {
    const relogin = provider === 'codex'
      ? 'Sign out and back in with the codex CLI (e.g. `codex logout && codex login`)'
      : `Sign out and back in with the ${provider} CLI`;
    return `${provider} sign-in expired — parallel ${provider} sessions can race single-use refresh tokens. ${relogin}, or switch to API-key auth to avoid the race.`;
  }
  if (provider && message.startsWith(`${provider} sign-in expired`)) return message;
  if (provider !== 'codex' || message.startsWith('codex: ')) return message;
  const detail = [extracted.status, extracted.type].filter(Boolean).join(' ');
  return `codex: ${detail ? `${detail} — ` : ''}${message}`;
}

/** Converts arbitrary stream chunks into complete lines and preserves a final partial line on end. */
export class IncrementalLineBuffer {
  #pending = '';
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string | Uint8Array): void {
    this.#pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const lines = this.#pending.split('\n');
    this.#pending = lines.pop() ?? '';
    for (const raw of lines) this.onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
  }

  end(): void {
    if (this.#pending.length > 0) this.onLine(this.#pending.endsWith('\r') ? this.#pending.slice(0, -1) : this.#pending);
    this.#pending = '';
  }
}

export const createLineBuffer = (onLine: (line: string) => void): IncrementalLineBuffer => new IncrementalLineBuffer(onLine);

export const truncateText = (value: string, maxBytes = 4096): string => {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = '\u2026[truncated]';
  const suffixBytes = Buffer.byteLength(suffix);
  let end = Math.min(value.length, maxBytes - suffixBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes - suffixBytes) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
};

export const stringifyToolValue = (value: unknown): string => {
  if (typeof value === 'string') return truncateText(value);
  try {
    return truncateText(JSON.stringify(value));
  } catch {
    return truncateText(String(value));
  }
};

export const parseJsonObject = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

export class ContentCoalescer {
  #current: { role: 'agent' | 'thinking'; kind: 'message' | 'thinking'; text: string } | undefined;
  #blockKind: 'message' | 'thinking' | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushCounts = new Map<'message' | 'thinking', number>();

  constructor(
    private readonly emit: (event: AdapterContentEvent) => void,
    private readonly flushMs = 1500,
    private readonly maxBytes = 2048,
  ) {}

  push(role: 'agent' | 'thinking', kind: 'message' | 'thinking', text: string): void {
    if (this.#blockKind !== kind) {
      if (this.#current) this.flush();
      this.#flushCounts.set(kind, 0);
      this.#blockKind = kind;
    }
    if (!this.#current) this.#current = { role, kind, text: '' };
    this.#current.text += text;
    if (Buffer.byteLength(this.#current.text) >= this.maxBytes) {
      this.flush();
      return;
    }
    this.#armTimer();
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const current = this.#current;
    this.#current = undefined;
    if (!current || current.text.length === 0) return;
    const count = this.#flushCounts.get(current.kind) ?? 0;
    this.emit({ ...current, ...(count > 0 ? { data: { continued: true } } : {}) });
    this.#flushCounts.set(current.kind, count + 1);
  }

  end(): void {
    this.flush();
    this.#blockKind = undefined;
  }

  #armTimer(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), this.flushMs);
    this.#timer.unref();
  }
}

const VERSION_SUCCESS_CACHE_TTL_MS = 10 * 60 * 1000;
const VERSION_FAILURE_CACHE_TTL_MS = 2 * 1000;
const versionCache = new Map<string, { expiresAt: number; value: Promise<{ ok: boolean; version?: string; detail?: string }> }>();

export function providerVersionProbeTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  // Windows CLI shims can take several seconds to cold-start after MAT or the
  // provider was updated. A short probe made a healthy CLI look uninstalled.
  return platform === 'win32' ? 15_000 : 8_000;
}

export function providerVersionCacheTtlMs(ok: boolean): number {
  // A transient failure must never poison detection for ten minutes. Keep only
  // a tiny failure window to collapse concurrent startup probes.
  return ok ? VERSION_SUCCESS_CACHE_TTL_MS : VERSION_FAILURE_CACHE_TTL_MS;
}

export function clearVersionCache(command?: string): void {
  if (command === undefined) versionCache.clear();
  else versionCache.delete(command);
}

export function probeVersion(command: string): Promise<{ ok: boolean; version?: string; detail?: string }> {
  const now = Date.now();
  const cached = versionCache.get(command);
  if (cached && cached.expiresAt > now) return cached.value;
  const timeoutMs = providerVersionProbeTimeoutMs();
  const value = new Promise<{ ok: boolean; version?: string; detail?: string }>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result: { ok: boolean; version?: string; detail?: string }): void => {
      if (settled) return;
      settled = true;
      const safeResult = {
        ...result,
        ...(result.version !== undefined ? { version: redactEnvironmentValues(result.version) } : {}),
        ...(result.detail !== undefined ? { detail: redactEnvironmentValues(result.detail) } : {}),
      };
      diag(null, 'probe', {
        command, ok: safeResult.ok,
        ...(safeResult.version ? { version: safeResult.version } : {}),
        ...(!safeResult.ok && safeResult.detail ? { detail: safeResult.detail } : {}),
      });
      resolve(safeResult);
    };
    let managed: ReturnType<typeof spawnManaged>;
    try {
      managed = spawnManaged({
        command,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs,
        onTimeout: () => finish({ ok: false, detail: `Version check timed out after ${String(timeoutMs / 1000)}s. The CLI may be starting slowly; retry detection.` }),
      });
    } catch (error) {
      finish({ ok: false, detail: humanizeError(error) });
      return;
    }
    const child: ChildProcess = managed.child;
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish({ ok: false, detail: humanizeError(error) }));
    child.once('close', (code) => {
      const output = (stdout.trim() || stderr.trim()).split(/\r?\n/, 1)[0]?.trim().slice(0, 120) ?? '';
      if (code === 0) finish({ ok: true, ...(output ? { version: output } : {}) });
      else finish({ ok: false, detail: output || `exit ${String(code)}` });
    });
  });
  // Keep an in-flight probe shared, then choose the cache lifetime from its
  // outcome. clearVersionCache() remains authoritative while it is running.
  versionCache.set(command, { expiresAt: Number.POSITIVE_INFINITY, value });
  void value.then((result) => {
    const cachedValue = versionCache.get(command);
    if (cachedValue?.value === value) cachedValue.expiresAt = Date.now() + providerVersionCacheTtlMs(result.ok);
  });
  return value;
}

interface ProviderSpawnSlotOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

const providerSpawnChains = new Map<string, Promise<void>>();
const providerLastSpawn = new Map<string, number>();

export function providerSpawnSlot(providerId: string, options: ProviderSpawnSlotOptions = {}): Promise<void> {
  if (providerId === 'mock') return Promise.resolve();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? 1500;
  const previous = providerSpawnChains.get(providerId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const last = providerLastSpawn.get(providerId);
    if (last !== undefined) {
      const waitMs = Math.max(0, intervalMs - (now() - last));
      if (waitMs > 0) await sleep(waitMs);
    }
    providerLastSpawn.set(providerId, now());
  });
  providerSpawnChains.set(providerId, current);
  const cleanup = (): void => { if (providerSpawnChains.get(providerId) === current) providerSpawnChains.delete(providerId); };
  void current.then(cleanup, cleanup);
  return current;
}

export function clearProviderSpawnSlots(): void {
  providerSpawnChains.clear();
  providerLastSpawn.clear();
}
