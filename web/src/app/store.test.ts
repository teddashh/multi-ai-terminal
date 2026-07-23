import type { AgentEvent, RunSnapshot, WorkflowDef } from '@mat/shared';
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

  it('pauses trust on a live sequence gap and restores it after REST backfill', async () => {
    const getEvents = vi.fn().mockResolvedValue([event(2), event(3)]);
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(3) });
    expect(store.getState().evidenceIntegrity.r1).toMatchObject({ status: 'recovering', expectedSeq: 2, receivedSeq: 3 });
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(getEvents).toHaveBeenCalledWith('r1', 1, 1000);
  });

  it('buffers websocket events that arrive while a gap recovery is in flight', async () => {
    let resolve!: (events: AgentEvent[]) => void;
    const getEvents = vi.fn().mockImplementationOnce(() => new Promise<AgentEvent[]>((done) => { resolve = done; }));
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(3) });
    store.getState().applyWsMsg({ type: 'event', event: event(4) });
    expect(store.getState().evidenceIntegrity.r1).toMatchObject({ status: 'recovering', receivedSeq: 4 });
    resolve([event(2), event(3)]);
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it('ignores websocket frames at or below the active recovery base', async () => {
    let resolve!: (events: AgentEvent[]) => void;
    const getEvents = vi.fn().mockImplementationOnce(() => new Promise<AgentEvent[]>((done) => { resolve = done; }));
    const store = createMatStore({ getEvents } as any);
    store.getState().setEvents('r1', [event(100)]);
    store.getState().applyWsMsg({ type: 'event', event: event(102) });
    store.getState().applyWsMsg({ type: 'event', event: event(1) });

    resolve([event(101), event(102)]);
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([100, 101, 102]);
  });

  it('keeps an incomplete state visible and supports an explicit recovery retry', async () => {
    const getEvents = vi.fn().mockRejectedValueOnce(new Error('SECRET_ENV_VALUE=do-not-display')).mockResolvedValueOnce([event(2), event(3)]);
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(3) });
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toMatchObject({
      status: 'incomplete', expectedSeq: 2,
      message: 'Evidence recovery did not complete. Retry to recover missing events.',
    }));
    expect(JSON.stringify(store.getState().evidenceIntegrity.r1)).not.toContain('SECRET_ENV_VALUE');
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 3]);
    store.getState().retryEvidenceRecovery('r1');
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('does not abandon an older incomplete range when a later websocket gap arrives', async () => {
    const getEvents = vi.fn()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce([event(2), event(3), event(4), event(5)]);
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(3) });
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1?.status).toBe('incomplete'));

    store.getState().applyWsMsg({ type: 'event', event: event(5) });
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));

    expect(getEvents).toHaveBeenNthCalledWith(2, 'r1', 1, 1000);
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps a large gap recovery bounded to the visible event ring', async () => {
    const targetSeq = EVENT_RING_LIMIT + 1_501;
    const getEvents = vi.fn().mockImplementation((_runId: string, afterSeq: number, limit: number) => {
      const count = Math.min(limit, Math.max(0, targetSeq - afterSeq));
      return Promise.resolve(Array.from({ length: count }, (_, index) => event(afterSeq + index + 1)));
    });
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(targetSeq) });

    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1).toHaveLength(EVENT_RING_LIMIT);
    expect(store.getState().events.r1?.[0]?.seq).toBe(targetSeq - EVENT_RING_LIMIT + 1);
    expect(store.getState().events.r1?.at(-1)?.seq).toBe(targetSeq);
    expect(getEvents.mock.calls.length).toBeLessThan(30);
  });

  it('does not let an obsolete recovery rejection undo a complete setEvents replay', async () => {
    let reject!: (reason: Error) => void;
    const getEvents = vi.fn().mockImplementationOnce(() => new Promise<AgentEvent[]>((_resolve, fail) => { reject = fail; }));
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().applyWsMsg({ type: 'event', event: event(3) });
    store.getState().setEvents('r1', [event(1), event(2), event(3)]);
    expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' });

    reject(new Error('obsolete recovery failure'));
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('shows a generic incomplete state when websocket catch-up fails and retries explicitly', async () => {
    const getEvents = vi.fn().mockResolvedValue([]);
    const store = createMatStore({ getEvents } as any);
    store.getState().setWsConnection('open');
    store.getState().setEvidenceCatchUpState('r1', 'started', 0);
    expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'recovering', expectedSeq: 1 });
    store.getState().setEvidenceCatchUpState('r1', 'failed');
    expect(store.getState().evidenceIntegrity.r1).toEqual({
      status: 'incomplete', expectedSeq: 1,
      message: 'Evidence synchronization did not complete. Retry to catch up.',
    });
    expect(store.getState().wsConnection).toBe('open');

    store.getState().retryEvidenceRecovery('r1');
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(getEvents).toHaveBeenCalledWith('r1', 0, 1000);
  });

  it('does not let catch-up success overwrite a newer live-gap recovery', async () => {
    let resolve!: (events: AgentEvent[]) => void;
    const getEvents = vi.fn().mockImplementationOnce(() => new Promise<AgentEvent[]>((done) => { resolve = done; }));
    const store = createMatStore({ getEvents } as any);
    store.getState().applyWsMsg({ type: 'event', event: event(1) });
    store.getState().setEvidenceCatchUpState('r1', 'started', 1);
    store.getState().applyWsMsg({ type: 'event', event: event(3) });
    store.getState().setEvidenceCatchUpState('r1', 'synchronized');

    expect(store.getState().evidenceIntegrity.r1).toMatchObject({ status: 'recovering', expectedSeq: 2, receivedSeq: 3 });
    resolve([event(2), event(3)]);
    await vi.waitFor(() => expect(store.getState().evidenceIntegrity.r1).toEqual({ status: 'live' }));
    expect(store.getState().events.r1?.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('auto-follows a new active run for the selected workspace after the prior run is terminal', () => {
    const store = createMatStore({} as any);
    const terminal = { runId: 'old', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'old', status: 'done', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    const live = { ...terminal, runId: 'new', task: 'new', status: 'created' as const, createdAt: 2 };
    store.setState({ selectedWorkspaceId: 'w1', activeRunId: terminal.runId, viewedRunId: terminal.runId, runs: { [terminal.runId]: terminal } });
    store.getState().applyWsMsg({ type: 'run', run: live });
    expect(store.getState().activeRunId).toBe('new');
    expect(store.getState().viewedRunId).toBe('new');

    store.setState({ selectedWorkspaceId: 'w2', activeRunId: undefined, viewedRunId: undefined });
    store.getState().applyWsMsg({ type: 'run', run: { ...live, runId: 'other' } });
    expect(store.getState().activeRunId).toBeUndefined();
  });

  it('keeps the viewed run after its live subscription reaches a terminal status', () => {
    const store = createMatStore({ getProviders: vi.fn().mockResolvedValue([]) } as any);
    const running = { runId: 'live', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'x', status: 'running', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    store.setState({ selectedWorkspaceId: 'w1', activeRunId: running.runId, viewedRunId: running.runId, runs: { [running.runId]: running } });
    store.getState().applyWsMsg({ type: 'run', run: { ...running, status: 'done', endedAt: 2 } });
    expect(store.getState().activeRunId).toBeUndefined();
    expect(store.getState().viewedRunId).toBe('live');
    expect(store.getState().runs.live?.status).toBe('done');
  });

  it('does not yank a historical view when the subscribed live run updates', () => {
    const store = createMatStore({} as any);
    const history = { runId: 'history', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'old', status: 'done', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    const live = { ...history, runId: 'live', task: 'new', status: 'running' as const, createdAt: 2 };
    store.setState({ selectedWorkspaceId: 'w1', activeRunId: live.runId, viewedRunId: history.runId, runs: { history, live } });
    store.getState().applyWsMsg({ type: 'run', run: { ...live, status: 'gating' } });
    expect(store.getState().activeRunId).toBe('live');
    expect(store.getState().viewedRunId).toBe('history');
  });

  it('clears run-scoped view state when the workspace changes', () => {
    const store = createMatStore({} as any);
    const builtin = { id: 'builtin', builtin: true } as WorkflowDef;
    const custom = { id: 'custom' } as WorkflowDef;
    store.setState({
      selectedWorkspaceId: 'w1', activeRunId: 'live', viewedRunId: 'history',
      workflows: [builtin, custom], ephemeralWorkflowEdits: { builtin, custom },
      filters: { ...store.getState().filters, nodeRunIds: ['node'], follow: false }, ui: { focusedNodeRunId: 'node' },
    });
    store.getState().setSelectedWorkspaceId('w2');
    expect(store.getState()).toMatchObject({
      selectedWorkspaceId: 'w2', activeRunId: undefined, viewedRunId: undefined,
      ephemeralWorkflowEdits: { custom }, filters: { nodeRunIds: [], follow: true }, ui: { focusedNodeRunId: undefined },
    });
    expect(store.getState().ephemeralWorkflowEdits).not.toHaveProperty('builtin');
  });

  it('refreshes providers once when a run reaches a terminal status', async () => {
    const providers = [{ id: 'codex', tier: 'rich', ok: true, installable: true, models: [], defaultModel: '', authAlert: { message: 'sign in', at: 1, runId: 'r1' } }];
    const getProviders = vi.fn().mockResolvedValue(providers);
    const store = createMatStore({ getProviders } as any);
    const running = { runId: 'r1', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'x', status: 'running', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    store.getState().applyWsMsg({ type: 'run', run: running });
    store.getState().applyWsMsg({ type: 'run', run: { ...running, status: 'failed', endedAt: 2 } });
    await vi.waitFor(() => expect(store.getState().providers).toEqual(providers));
    expect(getProviders).toHaveBeenCalledOnce();
    store.getState().applyWsMsg({ type: 'run', run: { ...running, status: 'failed', endedAt: 2 } });
    expect(getProviders).toHaveBeenCalledOnce();
  });

  it('refreshes runtime and provider discovery independently after an explicit runtime mutation', async () => {
    const providers = [{ id: 'codex', tier: 'rich', ok: true, installable: true, models: [], defaultModel: '' }];
    const getRuntimes = vi.fn().mockRejectedValue(new Error('runtime refresh failed'));
    const getProviders = vi.fn().mockResolvedValue(providers);
    const store = createMatStore({ getRuntimes, getProviders } as any);
    store.getState().applyWsMsg({
      type: 'runtime:changed',
      event: { family: 'codex', state: 'managed', managedVersion: '2.3.4' },
    });
    await vi.waitFor(() => expect(store.getState().providers).toEqual(providers));
    expect(getRuntimes).toHaveBeenCalledOnce();
    expect(getProviders).toHaveBeenCalledOnce();
  });

  it('toggles roles and limits event storage to the ring size', () => {
    const store = createMatStore({} as any);
    store.getState().toggleRole('thinking'); expect(store.getState().filters.roles).not.toContain('thinking');
    store.getState().setEvents('r1', Array.from({ length: EVENT_RING_LIMIT + 2 }, (_, index) => event(index + 1)));
    expect(store.getState().events.r1).toHaveLength(EVENT_RING_LIMIT);
    expect(store.getState().events.r1?.[0]?.seq).toBe(3);
  });

  it('bounds live and terminal replay events to the in-memory ring limit', () => {
    const store = createMatStore({} as any);
    const run = { runId: 'r1', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'x', status: 'running', nodes: [], gateDecisions: [], createdAt: 1 } as RunSnapshot;
    const complete = Array.from({ length: EVENT_RING_LIMIT + 2 }, (_, index) => event(index + 1));
    store.getState().upsertRun(run);
    store.getState().setEvents('r1', complete);
    expect(store.getState().events.r1).toHaveLength(EVENT_RING_LIMIT);
    expect(store.getState().events.r1?.[0]?.seq).toBe(3);

    store.getState().upsertRun({ ...run, status: 'done', endedAt: 2 });
    store.getState().setEvents('r1', complete);
    expect(store.getState().events.r1).toHaveLength(EVENT_RING_LIMIT);
    expect(store.getState().events.r1?.[0]?.seq).toBe(3);
  });

  it('uses a bounded older window when loading terminal-run history', async () => {
    const getEvents = vi.fn().mockResolvedValue([event(1), event(2)]);
    const store = createMatStore({ getEvents } as any);
    const terminal = { runId: 'r1', workspaceId: 'w1', workflow: {} as RunSnapshot['workflow'], task: 'x', status: 'done', nodes: [], gateDecisions: [], createdAt: 1, endedAt: 2 } as RunSnapshot;
    store.setState({
      runs: { r1: terminal },
      events: { r1: Array.from({ length: EVENT_RING_LIMIT }, (_, index) => event(index + 3)) },
    });
    await store.getState().loadOlderEvents('r1');
    expect(store.getState().events.r1).toHaveLength(EVENT_RING_LIMIT);
    expect(store.getState().events.r1?.[0]?.seq).toBe(1);
    expect(store.getState().events.r1?.at(-1)?.seq).toBe(EVENT_RING_LIMIT);
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
