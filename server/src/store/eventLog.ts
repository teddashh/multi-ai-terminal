import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { AgentEventSchema, type AgentEvent } from '@mat/shared';
import { redactEnvironmentValues, redactJsonValue } from '../redact.js';

export type EventPartial = Omit<AgentEvent, 'id' | 'seq' | 'ts'>;
export type EventSubscriber = (event: AgentEvent) => void;
export interface AppendEventOptions {
  /** Use only for engine-generated or already-redacted protocol data. */
  trustedData?: boolean;
}

const INDEX_STRIDE = 512;
const READ_CHUNK_BYTES = 64 * 1024;
interface EventCheckpoint { seq: number; offset: number }
interface EventIndex { size: number; checkpoints: EventCheckpoint[] }

export class EventLog {
  readonly #nextSeq = new Map<string, number>();
  readonly #indexes = new Map<string, EventIndex>();
  readonly #subscribers = new Set<EventSubscriber>();
  constructor(readonly dataDir: string) { mkdirSync(join(dataDir, 'runs'), { recursive: true }); }

  appendEvent(runId: string, partial: EventPartial, options: AppendEventOptions = {}): AgentEvent {
    if (partial.runId !== runId) throw new Error(`runId mismatch: ${partial.runId} !== ${runId}`);
    const seq = this.#sequenceFor(runId);
    // Identity and enum fields are engine metadata, not transcript text. Keep
    // them schema-stable even when a host has an unfortunate value such as
    // USER=user; redact only evidence-bearing strings and JSON data.
    const tool = partial.tool ? {
      ...partial.tool,
      name: redactEnvironmentValues(partial.tool.name),
      ...(partial.tool.toolCallId !== undefined ? { toolCallId: redactEnvironmentValues(partial.tool.toolCallId) } : {}),
      ...(partial.tool.input !== undefined ? { input: redactEnvironmentValues(partial.tool.input) } : {}),
      ...(partial.tool.output !== undefined ? { output: redactEnvironmentValues(partial.tool.output) } : {}),
    } : undefined;
    const event = AgentEventSchema.parse({
      ...partial,
      text: redactEnvironmentValues(partial.text),
      ...(tool ? { tool } : {}),
      ...(partial.data ? { data: options.trustedData ? partial.data : redactJsonValue(partial.data) } : {}),
      id: nanoid(), seq, ts: Date.now(),
    }) as AgentEvent;
    const path = this.pathFor(runId);
    mkdirSync(dirname(path), { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(path, line, { encoding: 'utf8', flag: 'a' });
    const index = this.#indexes.get(runId);
    if (index) {
      if ((seq - 1) % INDEX_STRIDE === 0) index.checkpoints.push({ seq, offset: index.size });
      index.size += Buffer.byteLength(line);
    }
    this.#nextSeq.set(runId, seq + 1);
    for (const subscriber of [...this.#subscribers]) {
      try { subscriber(event); } catch { /* A broadcast failure must never make a durable append look unsuccessful. */ }
    }
    return event;
  }

  afterSeq(runId: string, afterSeq = 0, limit = 1000): AgentEvent[] {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError('afterSeq must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    const path = this.pathFor(runId);
    if (!existsSync(path)) { this.#indexes.delete(runId); return []; }
    const index = this.#indexFor(runId, path);
    const target = afterSeq + 1;
    let offset = 0;
    for (const checkpoint of index.checkpoints) {
      if (checkpoint.seq > target) break;
      offset = checkpoint.offset;
    }
    return this.#readPage(path, offset, afterSeq, limit);
  }

  #readPage(path: string, offset: number, afterSeq: number, limit: number): AgentEvent[] {
    const result: AgentEvent[] = [];
    const accept = (line: Buffer): boolean => {
      if (line.length === 0) return false;
      try {
        const parsed = AgentEventSchema.safeParse(JSON.parse(line.toString('utf8')));
        if (parsed.success && parsed.data.seq > afterSeq) result.push(parsed.data as AgentEvent);
      } catch { /* Ignore a torn or malformed line; valid immutable events remain readable. */ }
      return result.length >= limit;
    };
    const fd = openSync(path, 'r');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = offset;
    let pending = Buffer.alloc(0);
    try {
      while (result.length < limit) {
        const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (let newline = data.indexOf(0x0a, start); newline >= 0; newline = data.indexOf(0x0a, start)) {
          if (accept(data.subarray(start, newline))) return result;
          start = newline + 1;
        }
        pending = Buffer.from(data.subarray(start));
      }
      if (result.length < limit && pending.length > 0) accept(pending);
    } finally {
      closeSync(fd);
    }
    return result;
  }

  #indexFor(runId: string, path: string): EventIndex {
    const size = statSync(path).size;
    const cached = this.#indexes.get(runId);
    if (cached?.size === size) return cached;
    const checkpoints: EventCheckpoint[] = [];
    const fd = openSync(path, 'r');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    let pending = Buffer.alloc(0);
    let pendingOffset = 0;
    const inspect = (line: Buffer, offset: number): void => {
      if (line.length === 0) return;
      try {
        const value = JSON.parse(line.toString('utf8')) as { seq?: unknown };
        if (typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq > 0 && (value.seq - 1) % INDEX_STRIDE === 0) {
          checkpoints.push({ seq: value.seq, offset });
        }
      } catch { /* Malformed legacy lines do not invalidate later checkpoints. */ }
    };
    try {
      while (position < size) {
        const bytesRead = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (bytesRead === 0) break;
        const chunkOffset = position;
        position += bytesRead;
        const data = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const dataOffset = pending.length > 0 ? pendingOffset : chunkOffset;
        let start = 0;
        for (let newline = data.indexOf(0x0a, start); newline >= 0; newline = data.indexOf(0x0a, start)) {
          inspect(data.subarray(start, newline), dataOffset + start);
          start = newline + 1;
        }
        pending = Buffer.from(data.subarray(start));
        pendingOffset = dataOffset + start;
      }
      if (pending.length > 0) inspect(pending, pendingOffset);
    } finally {
      closeSync(fd);
    }
    const index = { size, checkpoints };
    this.#indexes.set(runId, index);
    return index;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  pathFor(runId: string): string { return join(this.dataDir, 'runs', runId, 'events.jsonl'); }

  #sequenceFor(runId: string): number {
    const cached = this.#nextSeq.get(runId);
    if (cached !== undefined) return cached;
    // Recovery may append a newline or truncate a torn suffix, invalidating a
    // read-built byte index from this EventLog instance.
    this.#indexes.delete(runId);
    const path = this.pathFor(runId);
    let recovered = 0;
    if (existsSync(path)) {
      let content = readFileSync(path);
      if (content.length > 0 && content[content.length - 1] !== 0x0a) {
        const newline = content.lastIndexOf(0x0a);
        const fragment = content.subarray(newline + 1).toString('utf8');
        try {
          AgentEventSchema.parse(JSON.parse(fragment));
          appendFileSync(path, '\n', 'utf8');
          content = Buffer.concat([content, Buffer.from('\n')]);
        } catch {
          truncateSync(path, newline + 1);
          content = content.subarray(0, newline + 1);
        }
      }
      const lines = content.toString('utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          const value = JSON.parse(line) as { seq?: unknown };
          if (typeof value.seq === 'number' && Number.isInteger(value.seq)) { recovered = value.seq; break; }
        } catch { /* Ignore a torn trailing line and recover from the prior complete event. */ }
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, 'a');
      closeSync(fd);
    }
    const next = recovered + 1;
    this.#nextSeq.set(runId, next);
    return next;
  }
}

let defaultLog: EventLog | undefined;
export const configureEventLog = (dataDir: string): EventLog => (defaultLog = new EventLog(dataDir));
export const appendEvent = (runId: string, partial: EventPartial, options: AppendEventOptions = {}): AgentEvent => {
  if (!defaultLog) throw new Error('eventLog is not configured');
  return defaultLog.appendEvent(runId, partial, options);
};
export const readEventsAfter = (runId: string, afterSeq = 0, limit = 1000): AgentEvent[] => {
  if (!defaultLog) throw new Error('eventLog is not configured');
  return defaultLog.afterSeq(runId, afterSeq, limit);
};
