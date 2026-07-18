// @vitest-environment jsdom
import type { RunSnapshot, Workspace } from '@mat/shared';
import { waitFor } from '@testing-library/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuns: vi.fn(),
  subscriptions: [] as string[],
}));

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));
vi.mock('../api/client.js', () => ({
  apiClient: {
    getWorkspaces: vi.fn(), getWorkflows: vi.fn(), getProviders: vi.fn(), getRuns: mocks.getRuns,
    abortRun: vi.fn(),
  },
}));
vi.mock('../api/ws.js', () => ({
  ReconnectingWsClient: class {
    connect() {}
    close() {}
    subscribe(runId: string) { mocks.subscriptions.push(runId); }
    unsubscribe() {}
  },
}));
vi.mock('../panels/run/RunPanel.js', () => ({ RunPanel: () => <div>run</div> }));
vi.mock('../panels/stream/StreamPanel.js', () => ({ StreamPanel: () => <div>stream</div> }));
vi.mock('../panels/workflow/WorkflowPanel.js', () => ({ WorkflowPanel: () => <div>workflow</div> }));
vi.mock('../panels/workspace/WorkspacePanel.js', () => ({ WorkspacePanel: () => <div>workspace</div> }));

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
  document.body.replaceChildren();
});

describe('App boot run discovery', () => {
  it('loads newest workspace runs, selects an active run, and subscribes before discovery completes', async () => {
    vi.mocked(apiClient.getWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(apiClient.getWorkflows).mockResolvedValue([]);
    vi.mocked(apiClient.getProviders).mockResolvedValue([]);
    mocks.getRuns.mockResolvedValue([activeRun]);
    matStore.setState({ workspaces: [workspace], workflows: [], providers: [], selectedWorkspaceId: 'w1', activeRunId: undefined, runsLoading: true, runs: {}, events: {} });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(<App />));

    await waitFor(() => expect(mocks.getRuns).toHaveBeenCalledWith({ workspaceId: 'w1', limit: 100 }));
    await waitFor(() => expect(matStore.getState()).toMatchObject({ activeRunId: 'active-run', runsLoading: false }));
    expect(matStore.getState().runs['active-run']).toEqual(activeRun);
    expect(mocks.subscriptions).toContain('active-run');
    act(() => root.unmount());
  });
});
