import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { describe, expect, it, vi } from 'vitest';
import { createMatStore, EVENT_RING_LIMIT } from './store.js';

const event = (seq: number): AgentEvent => ({ id: `e${seq}`, seq, runId: 'r1', stageId: 's1', nodeRunId: 's1.a.0', attempt: 1, role: 'agent', kind: 'message', text: String(seq), ts: seq });

describe('MAT store', () => {
  it('applies websocket run and event messages without duplicates', () => {
    const client = { getWorkspaces: vi.fn(), getEvents: vi.fn() } as any;
    const store = createMatStore(client);
    const run = { runId: 'r1', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'x', status: 'running', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    store.getState().applyWsMsg({ type: 'run', run });
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    expect(store.getState().runs.r1).toBe(run);
    expect(store.getState().events.r1).toEqual([event(1)]);
  });

  it('auto-follows a new active run for the selected workspace after the prior run is terminal', () => {
    const store = createMatStore({} as any);
    const terminal = { runId: 'old', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'old', status: 'done', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    const live = { ...terminal, runId: 'new', task: 'new', status: 'created' as const, createdAt: 2 };
    store.setState({ selectedWorkspaceId: 'w1', activeRunId: terminal.runId, runs: { [terminal.runId]: terminal } });
    store.getState().applyWsMsg({ type: 'run', run: live });
    expect(store.getState().activeRunId).toBe('new');

    store.setState({ selectedWorkspaceId: 'w2', activeRunId: undefined });
    store.getState().applyWsMsg({ type: 'run', run: { ...live, runId: 'other' } });
    expect(store.getState().activeRunId).toBeUndefined();
  });

  it('toggles roles and limits event storage to the ring size', () => {
    const store = createMatStore({} as any);
    store.getState().toggleRole('thinking'); expect(store.getState().filters.roles).not.toContain('thinking');
    store.getState().setEvents('r1', Array.from({ length: EVENT_RING_LIMIT + 2 }, (_, index) => event(index + 1)));
    expect(store.getState().events.r1).toHaveLength(EVENT_RING_LIMIT);
    expect(store.getState().events.r1?.[0]?.seq).toBe(3);
  });

  it('loads the page immediately before the oldest local event', async () => {
    const getEvents = vi.fn().mockResolvedValue([event(8), event(9)]);
    const store = createMatStore({ getEvents } as any); store.getState().setEvents('r1', [event(10)]);
    await store.getState().loadOlderEvents('r1');
    expect(getEvents).toHaveBeenCalledWith('r1', 0, 9);
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([8, 9, 10]);
  });

  it('keeps the oldest side for history loads while live appends keep the newest side', async () => {
    const older = Array.from({ length: 1000 }, (_, index) => event(index + 1));
    const getEvents = vi.fn().mockResolvedValue(older);
    const store = createMatStore({ getEvents } as any);
    store.setState({ events: { r1: Array.from({ length: EVENT_RING_LIMIT }, (_, index) => event(index + 1001)) } });
    await store.getState().loadOlderEvents('r1');
    expect(store.getState().events.r1?.[0]?.seq).toBe(1);
    expect(store.getState().events.r1?.at(-1)?.seq).toBe(EVENT_RING_LIMIT);

    store.getState().applyWsMsg({ type: 'event', event: event(EVENT_RING_LIMIT + 1) });
    expect(store.getState().events.r1?.[0]?.seq).toBe(2);
    expect(store.getState().events.r1?.at(-1)?.seq).toBe(EVENT_RING_LIMIT + 1);
  });
});
