// @vitest-environment jsdom
import type { AgentEvent } from '@mat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectingWsClient, type WsCatchUpUpdate } from './ws.js';

const event = (seq: number): AgentEvent => ({
  id: `e${seq}`, seq, runId: 'r1', stageId: 's1', nodeRunId: 's1.a.0', attempt: 1,
  role: 'agent', kind: 'message', text: String(seq), ts: seq,
});

let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string | URL) { sockets.push(this); }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(value: string): void { this.sent.push(value); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.#emit('open'); }
  close(): void { this.readyState = 3; this.#emit('close'); }

  #emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('ReconnectingWsClient catch-up visibility', () => {
  it('reports catch-up rejection without exposing the rejected error', async () => {
    const updates: WsCatchUpUpdate[] = [];
    const getEvents = vi.fn().mockRejectedValue(new Error('SECRET_ENV_VALUE=do-not-display'));
    const client = new ReconnectingWsClient({
      api: { getEvents } as any,
      onMessage: vi.fn(),
      onCatchUpState: (update) => updates.push(update),
    });

    client.connect();
    client.subscribe('r1');
    sockets[0]!.open();

    await vi.waitFor(() => expect(updates).toEqual([
      { runId: 'r1', status: 'started', afterSeq: 0 },
      { runId: 'r1', status: 'failed' },
    ]));
    expect(JSON.stringify(updates)).not.toContain('SECRET_ENV_VALUE');
    client.close();
  });

  it('reports synchronization after delivering persisted events once', async () => {
    const updates: WsCatchUpUpdate[] = [];
    const onMessage = vi.fn();
    const getEvents = vi.fn().mockResolvedValue([event(1)]);
    const client = new ReconnectingWsClient({
      api: { getEvents } as any,
      onMessage,
      onCatchUpState: (update) => updates.push(update),
    });

    client.connect();
    client.subscribe('r1');
    client.subscribe('r1');
    sockets[0]!.open();

    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ runId: 'r1', status: 'synchronized' }));
    expect(getEvents).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({ type: 'event', event: event(1) });
    client.close();
  });

  it('invalidates an in-flight catch-up on unsubscribe and makes it retryable', async () => {
    let resolve!: (events: AgentEvent[]) => void;
    const updates: WsCatchUpUpdate[] = [];
    const onMessage = vi.fn();
    const getEvents = vi.fn().mockImplementationOnce(() => new Promise<AgentEvent[]>((done) => { resolve = done; }));
    const client = new ReconnectingWsClient({
      api: { getEvents } as any,
      onMessage,
      onCatchUpState: (update) => updates.push(update),
    });

    client.connect();
    client.subscribe('r1');
    sockets[0]!.open();
    await vi.waitFor(() => expect(updates).toEqual([{ runId: 'r1', status: 'started', afterSeq: 0 }]));

    client.unsubscribe('r1');
    expect(updates).toEqual([
      { runId: 'r1', status: 'started', afterSeq: 0 },
      { runId: 'r1', status: 'failed' },
    ]);
    resolve([event(1)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onMessage).not.toHaveBeenCalled();
    expect(updates).not.toContainEqual({ runId: 'r1', status: 'synchronized' });
    client.close();
  });
});
