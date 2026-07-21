// @vitest-environment jsdom
import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return {
    useStore: <TState, TSlice>(
      store: { subscribe(listener: () => void): () => void; getState(): TState; getInitialState(): TState },
      selector: (state: TState) => TSlice,
    ) => useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getInitialState())),
  };
});
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize(index: number): number }) => ({
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, size) => sum + size, 0),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: Array.from({ length: index }, (_, prior) => estimateSize(prior)).reduce((sum, size) => sum + size, 0) })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));
const apiMocks = vi.hoisted(() => ({
  getRuns: vi.fn(), getRun: vi.fn(), getEvents: vi.fn(), getWorkspaces: vi.fn(),
}));
vi.mock('../../api/client.js', () => ({
  apiClient: apiMocks,
}));

import { matStore } from '../../app/store.js';
import { loadReplayPages, StreamPanel } from './StreamPanel.js';

const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', task: 'Task', status: 'running', currentStageId: 's1', createdAt: 1,
  workflow: {
    schemaVersion: 1, id: 'wf', name: 'Planning', description: '', maxParallel: 2, maxRetriesPerStage: 1,
    orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 },
    stages: [{ id: 's1', name: 'Stage', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false }],
  },
  nodes: [{ nodeRunId: 's1.a.0', stageId: 's1', slotId: 'a', instanceIndex: 0, agent: { provider: 'mock', permission: 'safe' }, label: 'A · mock', status: 'running', attempt: 1, cwd: 'test-workspace' }], gateDecisions: [],
};
const base = { runId: 'r1', stageId: 's1', nodeRunId: 's1.a.0', attempt: 1 } as const;
const events: AgentEvent[] = [
  { ...base, id: 'e1', seq: 1, role: 'user', kind: 'message', text: 'Please inspect this', ts: 1 },
  { ...base, id: 'e2', seq: 2, role: 'thinking', kind: 'thinking', text: 'First ', ts: 2 },
  { ...base, id: 'e3', seq: 3, role: 'thinking', kind: 'thinking', text: 'thought', ts: 3 },
  { ...base, id: 'e4', seq: 4, role: 'tool', kind: 'tool_use', text: 'run tests', tool: { name: 'shell', toolCallId: 'call-1', input: 'npm test' }, ts: 4 },
  { ...base, id: 'e5', seq: 5, role: 'tool', kind: 'tool_result', text: 'tests passed', tool: { name: 'shell', toolCallId: 'call-1', output: 'PASS' }, ts: 5 },
  { ...base, id: 'e6', seq: 6, role: 'agent', kind: 'message', text: 'All done', ts: 6 },
  { ...base, id: 'e7', seq: 7, role: 'decision', kind: 'decision', text: 'Advance to review', ts: 7 },
];

beforeEach(() => {
  class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  apiMocks.getRuns.mockReset().mockResolvedValue([]);
  apiMocks.getRun.mockReset();
  apiMocks.getEvents.mockReset().mockResolvedValue([]);
  apiMocks.getWorkspaces.mockReset().mockResolvedValue([]);
  matStore.setState({ selectedWorkspaceId: 'w1', activeRunId: 'r1', viewedRunId: 'r1', runs: { r1: run }, events: { r1: events }, filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true }, ui: { focusedNodeRunId: undefined } });
});
const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
function renderWithWorkspaceReact(ui: ReactElement) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); act(() => root.render(ui)); mounted.push({ container, root });
  return { container };
}
afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
  vi.unstubAllGlobals();
});

describe('StreamPanel smoke', () => {
  it('stops a stale replay loader after its in-flight page resolves', async () => {
    const replayEvent = { ...events[0]!, id: 'cancel-1', runId: 'cancel', seq: 1 };
    matStore.setState({ events: { cancel: [replayEvent] } });
    let current = true;
    const getEvents = vi.fn().mockImplementation(async () => {
      current = false;
      return [{ ...replayEvent, id: 'cancel-2', seq: 2 }];
    });
    const setEvents = vi.fn();
    await loadReplayPages('cancel', vi.fn(), setEvents, { isCurrent: () => current, getEvents });
    expect(getEvents).toHaveBeenCalledOnce();
    expect(setEvents).not.toHaveBeenCalled();
  });

  it('renders all four raw content categories, a decision, and one matched tool block', async () => {
    const { container } = renderWithWorkspaceReact(<StreamPanel />);
    await waitFor(() => expect(screen.getByText('Please inspect this')).toBeTruthy());
    expect(screen.getAllByText('First').length).toBeGreaterThan(0);
    expect(screen.getAllByText('thought').length).toBeGreaterThan(0);
    expect(screen.getByText('All done')).toBeTruthy();
    expect(screen.getByText('Advance to review')).toBeTruthy();
    expect(container.querySelectorAll('[data-tool-call-id="call-1"]')).toHaveLength(1);
    expect(screen.getByText('PASS')).toBeTruthy();
  });

  it('shows an explicit in-feed notice when the memory ring starts after seq 1', async () => {
    matStore.setState({ events: { r1: events.map((event) => ({ ...event, seq: event.seq + 20 })) } });
    renderWithWorkspaceReact(<StreamPanel />);
    await waitFor(() => expect(screen.getByText('Older events trimmed from memory — showing from seq 21')).toBeTruthy());
  });

  it('leaves run history and replay hydration to its parent when embedded', async () => {
    const historical = { ...run, runId: 'r2', status: 'done' as const, task: 'Historical task', createdAt: 0, endedAt: 10 };
    const historicalEvents = events.map((event) => ({ ...event, id: `h-${event.id}`, runId: 'r2', text: event.seq === 6 ? 'Parent-loaded answer' : event.text }));
    matStore.setState({ runs: { r1: run, r2: historical }, events: { r1: events, r2: historicalEvents } });
    renderWithWorkspaceReact(<StreamPanel embedded />);

    await waitFor(() => expect(screen.getByText('All done')).toBeTruthy());
    expect(screen.queryByLabelText('Select run')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More runs' })).toBeNull();
    expect(apiMocks.getRuns).not.toHaveBeenCalled();

    act(() => matStore.getState().setViewedRunId('r2'));
    await waitFor(() => expect(screen.getByText('Parent-loaded answer')).toBeTruthy());
    expect(apiMocks.getRun).not.toHaveBeenCalled();
    expect(apiMocks.getEvents).not.toHaveBeenCalled();
  });

  it('keeps raw evidence controls and the virtualized timeline when embedded', async () => {
    renderWithWorkspaceReact(<StreamPanel embedded />);

    await waitFor(() => expect(screen.getByTestId('stream-scroll-region')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'tool' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search events' })).toBeTruthy();
    expect(screen.getByText('PASS')).toBeTruthy();
  });

  it('keeps the jump control when a live run finishes while the user is reading it', async () => {
    renderWithWorkspaceReact(<StreamPanel embedded />);
    await waitFor(() => expect(screen.getByTestId('stream-scroll-region')).toBeTruthy());

    act(() => matStore.setState((state) => ({
      activeRunId: undefined,
      runs: { ...state.runs, r1: { ...run, status: 'done', endedAt: 10 } },
      filters: { ...state.filters, follow: false },
    })));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Jump to live' })).toBeTruthy());
  });

  it('switches the shared viewed run without dropping the live subscription', async () => {
    const historical = { ...run, runId: 'r2', status: 'done' as const, task: 'Historical task', createdAt: 0, endedAt: 10 };
    const historicalEvents = events.map((event) => ({ ...event, id: `h-${event.id}`, runId: 'r2', text: event.seq === 6 ? 'Historical answer' : event.text }));
    matStore.setState({ runs: { r1: run, r2: historical }, events: { r1: events, r2: historicalEvents } });
    renderWithWorkspaceReact(<StreamPanel />);

    act(() => fireEvent.change(screen.getByLabelText('Select run'), { target: { value: 'r2' } }));
    await waitFor(() => expect(matStore.getState()).toMatchObject({ activeRunId: 'r1', viewedRunId: 'r2' }));
    await waitFor(() => expect(screen.getByText('Historical answer')).toBeTruthy());
    expect(screen.getByRole('option', { name: /Live · Planning · running/ })).toBeTruthy();
  });

  it('ignores a stale history response after the workspace changes', async () => {
    let resolveFirst!: (runs: RunSnapshot[]) => void;
    let resolveSecond!: (runs: RunSnapshot[]) => void;
    apiMocks.getRuns
      .mockImplementationOnce(() => new Promise<RunSnapshot[]>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<RunSnapshot[]>((resolve) => { resolveSecond = resolve; }));
    const other = { ...run, runId: 'other', workspaceId: 'w2', workflow: { ...run.workflow, name: 'Other Workflow' }, status: 'done' as const, task: 'Other workspace', createdAt: 2, endedAt: 3 };
    renderWithWorkspaceReact(<StreamPanel />);
    await waitFor(() => expect(apiMocks.getRuns).toHaveBeenCalledTimes(1));

    act(() => matStore.getState().setSelectedWorkspaceId('w2'));
    await waitFor(() => expect(apiMocks.getRuns).toHaveBeenCalledTimes(2));
    await act(async () => { resolveSecond([other]); await Promise.resolve(); });
    await act(async () => { resolveFirst([run]); await Promise.resolve(); });

    await waitFor(() => expect(screen.getByRole('option', { name: /Other Workflow/ })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /Planning · running/ })).toBeNull();
    expect(matStore.getState()).toMatchObject({ selectedWorkspaceId: 'w2', activeRunId: undefined, viewedRunId: undefined });
  });
});
