import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { AgentEventSchema, type AgentEvent } from '@mat/shared';

export type EventPartial = Omit<AgentEvent, 'id' | 'seq' | 'ts'>;
export type EventSubscriber = (event: AgentEvent) => void;

export class EventLog {
  readonly #nextSeq = new Map<string, number>();
  readonly #subscribers = new Set<EventSubscriber>();
  constructor(readonly dataDir: string) { mkdirSync(join(dataDir, 'runs'), { recursive: true }); }

  appendEvent(runId: string, partial: EventPartial): AgentEvent {
    if (partial.runId !== runId) throw new Error(`runId mismatch: ${partial.runId} !== ${runId}`);
    const seq = this.#sequenceFor(runId);
    const event = AgentEventSchema.parse({ ...partial, id: nanoid(), seq, ts: Date.now() }) as AgentEvent;
    const path = this.pathFor(runId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
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
    if (!existsSync(path)) return [];
    const result: AgentEvent[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = AgentEventSchema.safeParse(JSON.parse(line));
        if (parsed.success && parsed.data.seq > afterSeq) result.push(parsed.data as AgentEvent);
      } catch { /* Ignore a torn or malformed line; valid immutable events remain readable. */ }
      if (result.length >= limit) break;
    }
    return result;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  pathFor(runId: string): string { return join(this.dataDir, 'runs', runId, 'events.jsonl'); }

  #sequenceFor(runId: string): number {
    const cached = this.#nextSeq.get(runId);
    if (cached !== undefined) return cached;
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
export const appendEvent = (runId: string, partial: EventPartial): AgentEvent => {
  if (!defaultLog) throw new Error('eventLog is not configured');
  return defaultLog.appendEvent(runId, partial);
};
export const readEventsAfter = (runId: string, afterSeq = 0, limit = 1000): AgentEvent[] => {
  if (!defaultLog) throw new Error('eventLog is not configured');
  return defaultLog.afterSeq(runId, afterSeq, limit);
};
