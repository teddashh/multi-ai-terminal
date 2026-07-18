import type { AdapterContentEvent, AgentBinding, ProviderId, Usage } from '@mat/shared';
import type { ChildProcess } from 'node:child_process';
import { spawnManaged } from '../spawn.js';

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
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushCounts = new Map<'message' | 'thinking', number>();

  constructor(
    private readonly emit: (event: AdapterContentEvent) => void,
    private readonly flushMs = 1500,
    private readonly maxBytes = 2048,
  ) {}

  push(role: 'agent' | 'thinking', kind: 'message' | 'thinking', text: string): void {
    if (this.#current && this.#current.kind !== kind) this.flush();
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
  }

  #armTimer(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), this.flushMs);
    this.#timer.unref();
  }
}

export function probeVersion(command: string): Promise<{ ok: boolean; version?: string; detail?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result: { ok: boolean; version?: string; detail?: string }): void => {
      if (settled) return;
      settled = true;
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
      finish({ ok: false, detail: (error as Error).message });
      return;
    }
    const child: ChildProcess = managed.child;
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish({ ok: false, detail: error.message }));
    child.once('close', (code) => {
      const output = (stdout.trim() || stderr.trim());
      if (code === 0) finish({ ok: true, ...(output ? { version: output } : {}) });
      else finish({ ok: false, detail: output || `version probe exited ${String(code)}` });
    });
  });
}
