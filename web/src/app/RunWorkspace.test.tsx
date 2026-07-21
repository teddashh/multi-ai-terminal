// @vitest-environment jsdom
import type { RunSnapshot } from '@mat/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return {
    useStore: <TState, TSlice>(store: { subscribe(listener: () => void): () => void; getState(): TState; getInitialState(): TState }, selector: (state: TState) => TSlice) => useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getInitialState())),
  };
});
const mocks = vi.hoisted(() => ({ loadReplayPages: vi.fn(), getRuns: vi.fn(), getRun: vi.fn() }));
vi.mock('../panels/narrative/NarrativePanel.js', () => ({ NarrativePanel: ({ loading, loadError }: { loading?: boolean; loadError?: string }) => <div>Conversation view{loading ? ' loading' : ''}{loadError ? ` ${loadError}` : ''}</div> }));
vi.mock('../panels/stream/StreamPanel.js', () => ({ StreamPanel: ({ embedded }: { embedded?: boolean }) => <div>Timeline view {embedded ? 'embedded' : ''}</div>, loadReplayPages: mocks.loadReplayPages }));
vi.mock('../api/client.js', () => ({ apiClient: { getRuns: mocks.getRuns, getRun: mocks.getRun, getEvents: vi.fn() } }));

import { matStore } from './store.js';
import { RunWorkspace } from './RunWorkspace.js';

const workflow = {
  schemaVersion: 1 as const, id: 'wf', name: 'Planning', description: '', maxParallel: 2, maxRetriesPerStage: 1,
  orchestrator: { enabled: false, agent: { provider: 'mock' as const, permission: 'safe' as const }, gateTimeoutSec: 30 },
  stages: [{ id: 's1', name: 'Plan', slots: [], isolation: 'none' as const, join: 'all' as const, timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false }],
};
const liveRun: RunSnapshot = {
  runId: 'live', workspaceId: 'w1', workflow, task: 'Live task', status: 'running', currentStageId: 's1', createdAt: 20, gateDecisions: [],
  nodes: [
    { nodeRunId: 'n1', stageId: 's1', slotId: 'r1', instanceIndex: 0, agent: { provider: 'codex', model: 'gpt-test', permission: 'safe' }, label: 'R1', status: 'running', attempt: 1, cwd: '/fixture' },
    { nodeRunId: 'n2', stageId: 's1', slotId: 'r2', instanceIndex: 0, agent: { provider: 'claude', permission: 'safe' }, label: 'R2', status: 'failed', attempt: 1, cwd: '/fixture', verification: { status: 'failed' } },
  ],
};
const historicalRun: RunSnapshot = { ...liveRun, runId: 'history', task: 'Prior task', status: 'done', createdAt: 10, endedAt: 15, nodes: liveRun.nodes.map((node) => ({ ...node, status: node.nodeRunId === 'n2' ? 'failed' as const : 'done' as const })) };

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function renderWorkspace(element: ReactElement) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  act(() => root.render(element));
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.loadReplayPages.mockReset().mockResolvedValue(undefined);
  mocks.getRuns.mockReset().mockResolvedValue([]);
  mocks.getRun.mockReset();
  matStore.setState({
    selectedWorkspaceId: 'w1', activeRunId: 'live', viewedRunId: 'live', runsLoading: false,
    runs: { live: liveRun, history: historicalRun }, events: {}, filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true }, ui: { focusedNodeRunId: undefined },
  });
});
afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
});

describe('RunWorkspace', () => {
  it('defaults to the readable conversation and keeps Timeline available', () => {
    renderWorkspace(<RunWorkspace />);
    expect(screen.getByText('Conversation view')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    act(() => fireEvent.click(screen.getByRole('tab', { name: 'Timeline' })));
    expect(screen.getByText('Timeline view embedded')).toBeTruthy();
  });

  it('switches shared evidence to a replay without replacing the active run', async () => {
    renderWorkspace(<RunWorkspace />);
    act(() => fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'history' } }));
    await waitFor(() => expect(mocks.loadReplayPages).toHaveBeenCalledWith('history', expect.any(Function), expect.any(Function), expect.objectContaining({ isCurrent: expect.any(Function) })));
    expect(matStore.getState()).toMatchObject({ activeRunId: 'live', viewedRunId: 'history' });
    expect(screen.getByText(/Replay · done/)).toBeTruthy();
  });

  it('does not restart replay hydration when the run finishes in the open live session', async () => {
    renderWorkspace(<RunWorkspace />);
    act(() => matStore.setState((state) => ({
      activeRunId: undefined,
      runs: { ...state.runs, live: { ...liveRun, status: 'done', endedAt: 30 } },
    })));

    await waitFor(() => expect(screen.getByText(/Completed · done/)).toBeTruthy());
    expect(mocks.loadReplayPages).not.toHaveBeenCalled();
    expect(matStore.getState().filters.follow).toBe(true);
  });

  it('offers quick running and attention focus presets', () => {
    renderWorkspace(<RunWorkspace />);
    act(() => fireEvent.click(screen.getByRole('button', { name: /Attention/ })));
    expect(matStore.getState().filters.nodeRunIds).toEqual(['n2']);
    act(() => fireEvent.click(screen.getByRole('button', { name: /Running/ })));
    expect(matStore.getState().filters.nodeRunIds).toEqual(['n1']);
    act(() => fireEvent.click(screen.getByRole('button', { name: /R2 · failed/ })));
    expect(matStore.getState().ui.focusedNodeRunId).toBe('n2');
  });

  it('clears an older-runs loading state when the workspace changes', async () => {
    mocks.getRuns.mockImplementationOnce(() => new Promise<RunSnapshot[]>(() => undefined));
    renderWorkspace(<RunWorkspace />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Older runs' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Loading…' })).toBeTruthy());

    act(() => matStore.getState().setSelectedWorkspaceId('w2'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Older runs' })).toBeTruthy());
  });
});
