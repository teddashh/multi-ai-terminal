// @vitest-environment jsdom
import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { screen, waitFor } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize(index: number): number }) => ({
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, size) => sum + size, 0),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: Array.from({ length: index }, (_, prior) => estimateSize(prior)).reduce((sum, size) => sum + size, 0) })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));
vi.mock('../../api/client.js', () => ({
  apiClient: {
    getRuns: vi.fn().mockResolvedValue([]), getRun: vi.fn(), getEvents: vi.fn().mockResolvedValue([]), getWorkspaces: vi.fn().mockResolvedValue([]),
  },
}));

import { matStore } from '../../app/store.js';
import { StreamPanel } from './StreamPanel.js';

const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', task: 'Task', status: 'running', currentStageId: 's1', createdAt: 1,
  workflow: {
    schemaVersion: 1, id: 'wf', name: 'Planning', description: '', maxParallel: 2, maxRetriesPerStage: 1,
    orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 },
    stages: [{ id: 's1', name: 'Stage', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true }],
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
  matStore.setState({ selectedWorkspaceId: 'w1', activeRunId: 'r1', runs: { r1: run }, events: { r1: events }, filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true }, ui: { focusedNodeRunId: undefined } });
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
  it('renders all four content categories, a decision, merged thinking, and one matched tool block', async () => {
    const { container } = renderWithWorkspaceReact(<StreamPanel />);
    await waitFor(() => expect(screen.getByText('Please inspect this')).toBeTruthy());
    expect(screen.getAllByText('First thought').length).toBeGreaterThan(0);
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
});
