// @vitest-environment jsdom
import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return { useStore: <TState, TSlice>(store: { subscribe(listener: () => void): () => void; getState(): TState; getInitialState(): TState }, selector: (state: TState) => TSlice) => useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getInitialState())) };
});
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize(index: number): number }) => ({
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, value) => sum + value, 0),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 100 })),
    measureElement: () => undefined, scrollToIndex: () => undefined,
  }),
}));
const apiMocks = vi.hoisted(() => ({ getEvents: vi.fn(), getWorkspaces: vi.fn(), getProviders: vi.fn() }));
vi.mock('../../api/client.js', () => ({ apiClient: apiMocks }));

import { matStore } from '../../app/store.js';
import { NarrativePanel } from './NarrativePanel.js';

const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', task: 'Audit the release', status: 'running', createdAt: 1, currentStageId: 'plan', gateDecisions: [],
  workflow: { schemaVersion: 1, id: 'wf', name: 'Planning', description: '', maxParallel: 2, maxRetriesPerStage: 1, orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 }, stages: [{ id: 'plan', name: 'Round Table', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false }] },
  nodes: [{ nodeRunId: 'plan.r1.0', stageId: 'plan', slotId: 'r1', instanceIndex: 0, agent: { provider: 'codex', model: 'gpt-test', permission: 'safe' }, label: 'R1', status: 'running', attempt: 2, cwd: '/fixture' }],
};
const base = { runId: 'r1', stageId: 'plan', nodeRunId: 'plan.r1.0', attempt: 2 } as const;
const events: AgentEvent[] = [
  { ...base, id: 'e1', seq: 1, ts: 1, role: 'user', kind: 'message', text: 'Check everything' },
  { ...base, id: 'e2', seq: 2, ts: 2, role: 'thinking', kind: 'thinking', text: 'Inspecting evidence' },
  { ...base, id: 'e3', seq: 3, ts: 3, role: 'tool', kind: 'tool_use', text: 'Run tests', tool: { name: 'shell', toolCallId: 'call-1', input: 'npm test' } },
  { ...base, id: 'e4', seq: 4, ts: 4, role: 'tool', kind: 'tool_result', text: 'Passed', tool: { name: 'shell', toolCallId: 'call-1', output: '66 passed' } },
  { ...base, id: 'e5', seq: 5, ts: 5, role: 'agent', kind: 'message', text: 'The release is ready.' },
];

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function renderPanel(element: ReactElement) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container }); act(() => root.render(element));
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMocks.getEvents.mockReset().mockResolvedValue([]);
  apiMocks.getWorkspaces.mockReset().mockResolvedValue([]);
  apiMocks.getProviders.mockReset().mockResolvedValue([]);
  matStore.setState({ activeRunId: 'r1', viewedRunId: 'r1', runs: { r1: run }, events: { r1: events }, evidenceIntegrity: { r1: { status: 'live' } }, filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true }, ui: { focusedNodeRunId: undefined } });
});
afterEach(() => { for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); } });

describe('NarrativePanel', () => {
  it('leads with readable agent identity and the answer', () => {
    renderPanel(<NarrativePanel />);
    expect(screen.getByText('The release is ready.')).toBeTruthy();
    expect(screen.getByText('R1')).toBeTruthy();
    expect(screen.getByText('codex · gpt-test')).toBeTruthy();
    expect(screen.getByText('Round Table')).toBeTruthy();
    expect(screen.getByText('attempt 2')).toBeTruthy();
    expect(screen.queryByText('Inspecting evidence')).toBeNull();
  });

  it('reveals paired tool evidence only when requested', () => {
    renderPanel(<NarrativePanel />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Tools & thinking' })));
    expect(screen.getAllByText('Inspecting evidence')).toHaveLength(2);
    expect(screen.getByText(/shell · paired/)).toBeTruthy();
    expect(screen.getByText(/66 passed/)).toBeTruthy();
  });

  it('makes an evidence gap visible and recovers it through the explicit retry', async () => {
    const withGap = [events[0]!, { ...events[4]!, id: 'e3-gap', seq: 3 }];
    apiMocks.getEvents.mockResolvedValue([{ ...events[1]!, seq: 2 }, withGap[1]!]);
    matStore.setState({ events: { r1: withGap }, evidenceIntegrity: { r1: { status: 'incomplete', expectedSeq: 2, receivedSeq: 3, message: 'Missing persisted evidence.' } } });
    renderPanel(<NarrativePanel />);
    expect(screen.getByText(/Evidence gap: events 2–2/)).toBeTruthy();
    expect(screen.getByText(/Live evidence is incomplete/)).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    await waitFor(() => expect(apiMocks.getEvents).toHaveBeenCalledWith('r1', 1, 1000));
    await waitFor(() => expect(screen.queryByText(/Live evidence is incomplete/)).toBeNull());
  });
});
