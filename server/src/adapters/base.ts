import type { AdapterContentEvent, AgentBinding, ProviderId, Usage } from '@mat/shared';
import type { ChildProcess } from 'node:child_process';
import { spawnManaged } from '../spawn.js';
import { diag } from '../diag.js';

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

const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const versionCache = new Map<string, { expiresAt: number; value: Promise<{ ok: boolean; version?: string; detail?: string }> }>();

export function probeVersion(command: string): Promise<{ ok: boolean; version?: string; detail?: string }> {
  const now = Date.now();
  const cached = versionCache.get(command);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = new Promise<{ ok: boolean; version?: string; detail?: string }>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result: { ok: boolean; version?: string; detail?: string }): void => {
      if (settled) return;
      settled = true;
      diag(null, 'probe', { command, ok: result.ok, ...(result.version ? { version: result.version } : {}) });
      resolve(result);
    };
    let managed: ReturnType<typeof spawnManaged>;
    try {
      managed = spawnManaged({
        command,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 5000,
        onTimeout: () => finish({ ok: false, detail: 'version probe timed out after 5s' }),
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
      else finish({ ok: false, detail: output || `version probe exited ${String(code)}` });
    });
  });
  versionCache.set(command, { expiresAt: now + VERSION_CACHE_TTL_MS, value });
  return value;
}
