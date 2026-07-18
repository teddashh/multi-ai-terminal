import type { AdapterContentEvent, AgentBinding, ProviderId, Usage } from '@mat/shared';

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
