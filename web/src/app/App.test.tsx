// @vitest-environment jsdom
import type { RunSnapshot, Workspace } from '@mat/shared';
import { waitFor } from '@testing-library/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuns: vi.fn(),
  subscriptions: [] as string[],
  catchUpState: undefined as undefined | ((update:
    | { runId: string; status: 'started'; afterSeq: number }
    | { runId: string; status: 'synchronized' | 'failed' }
  ) => void),
}));

vi.mock('zustand', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return {
    useStore: <TState, TSlice>(store: { subscribe(listener: () => void): () => void; getState(): TState; getInitialState(): TState }, selector: (state: TState) => TSlice) => useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getInitialState())),
  };
});
vi.mock('../api/client.js', () => ({
  apiClient: {
    getWorkspaces: vi.fn(), getWorkflows: vi.fn(), getProviders: vi.fn(), getRuns: mocks.getRuns,
    abortRun: vi.fn(),
  },
}));
vi.mock('../api/ws.js', () => ({
  ReconnectingWsClient: class {
    constructor(options: { onCatchUpState?: typeof mocks.catchUpState }) { mocks.catchUpState = options.onCatchUpState; }
    connect() {}
    close() {}
    subscribe(runId: string) { mocks.subscriptions.push(runId); }
    unsubscribe() {}
  },
}));
vi.mock('./AppShell.js', () => ({ AppShell: () => <div data-testid="app-shell">shell</div> }));

import { apiClient } from '../api/client.js';
import { App } from './App.js';
import { matStore } from './store.js';

const workspace: Workspace = { id: 'w1', name: 'Workspace', path: 'test-workspace', isGit: false };
const activeRun = {
  runId: 'active-run', workspaceId: 'w1', task: 'Resume monitoring', status: 'running', createdAt: 2, nodes: [], gateDecisions: [],
  workflow: { schemaVersion: 1, id: 'wf', name: 'Workflow', description: '', orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 }, stages: [], maxParallel: 1, maxRetriesPerStage: 1 },
} as RunSnapshot;

afterEach(() => {
  vi.clearAllMocks();
  mocks.subscriptions.length = 0;
  mocks.catchUpState = undefined;
  document.body.replaceChildren();
});

describe('App boot run discovery', () => {
  it('loads newest workspace runs, selects an active run, and subscribes before discovery completes', async () => {
    vi.mocked(apiClient.getWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(apiClient.getWorkflows).mockResolvedValue([]);
    vi.mocked(apiClient.getProviders).mockResolvedValue([]);
    mocks.getRuns.mockResolvedValue([activeRun]);
    matStore.setState({ workspaces: [workspace], workflows: [], providers: [], selectedWorkspaceId: 'w1', activeRunId: undefined, viewedRunId: undefined, runsLoading: true, runs: {}, events: {} });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(<App />));

    await waitFor(() => expect(mocks.getRuns).toHaveBeenCalledWith({ workspaceId: 'w1', limit: 100 }));
    await waitFor(() => expect(matStore.getState()).toMatchObject({ activeRunId: 'active-run', viewedRunId: 'active-run', runsLoading: false }));
    expect(matStore.getState().runs['active-run']).toEqual(activeRun);
    expect(mocks.subscriptions).toContain('active-run');
    expect(mocks.subscriptions.filter((runId) => runId === 'active-run')).toHaveLength(1);
    act(() => mocks.catchUpState?.({ runId: 'active-run', status: 'started', afterSeq: 0 }));
    expect(matStore.getState().evidenceIntegrity['active-run']).toEqual({ status: 'recovering', expectedSeq: 1 });
    act(() => mocks.catchUpState?.({ runId: 'active-run', status: 'synchronized' }));
    expect(matStore.getState().evidenceIntegrity['active-run']).toEqual({ status: 'live' });
    act(() => root.unmount());
  });

  it('selects the newest terminal run for evidence replay without treating it as live', async () => {
    const terminalRun = { ...activeRun, runId: 'terminal-run', status: 'done' as const, createdAt: 3, endedAt: 4 };
    vi.mocked(apiClient.getWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(apiClient.getWorkflows).mockResolvedValue([]);
    vi.mocked(apiClient.getProviders).mockResolvedValue([]);
    mocks.getRuns.mockResolvedValue([terminalRun]);
    matStore.setState({ workspaces: [workspace], workflows: [], providers: [], selectedWorkspaceId: 'w1', activeRunId: undefined, viewedRunId: undefined, runsLoading: true, runs: {}, events: {} });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(<App />));

    await waitFor(() => expect(matStore.getState()).toMatchObject({ activeRunId: undefined, viewedRunId: 'terminal-run', runsLoading: false }));
    expect(mocks.subscriptions).not.toContain('terminal-run');
    act(() => root.unmount());
  });
});
