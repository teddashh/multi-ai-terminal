// @vitest-environment jsdom
import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { screen, within } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));
vi.mock('../../api/client.js', () => ({
  apiClient: { getRuns: vi.fn().mockResolvedValue([]), getWorkspaces: vi.fn().mockResolvedValue([]) },
}));

import { matStore } from '../../app/store.js';
import { RunPanel } from './RunPanel.js';

const workflow: RunSnapshot['workflow'] = {
  schemaVersion: 1, id: 'wf', name: 'Planning', description: '', maxParallel: 2, maxRetriesPerStage: 2,
  orchestrator: { enabled: true, agent: { provider: 'claude', permission: 'safe' }, gateTimeoutSec: 30 },
  stages: [
    { id: 'round', name: 'Round Table', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true },
    { id: 'final', name: 'Final Review', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true },
  ],
};
const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', workflow, task: 'Build a plan', status: 'running', currentStageId: 'final', createdAt: 1,
  nodes: [
    { nodeRunId: 'round.r1.0', stageId: 'round', slotId: 'r1', instanceIndex: 0, agent: { provider: 'codex', permission: 'safe' }, label: 'R1 · codex', status: 'done', attempt: 2, cwd: '/tmp', startedAt: 1000, endedAt: 66_000, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 }, patchFile: 'r1.patch' },
    { nodeRunId: 'orchestrator', stageId: null, slotId: 'orchestrator', instanceIndex: 0, agent: { provider: 'claude', permission: 'safe' }, label: 'Orchestrator · claude', status: 'done', attempt: 1, cwd: '/tmp' },
    { nodeRunId: 'final.f1.0', stageId: 'final', slotId: 'f1', instanceIndex: 0, agent: { provider: 'grok', permission: 'safe' }, label: 'Final · grok', status: 'running', attempt: 1, cwd: '/tmp', startedAt: Date.now() },
  ],
  gateDecisions: [{ stageId: 'round', gateAttempt: 1, action: 'advance', rationale: 'The candidates agree.', contextForNext: 'Prefer the safe design.', degraded: true, ts: 100 }],
};
const events: AgentEvent[] = [
  { id: 'e1', seq: 1, runId: 'r1', stageId: 'final', nodeRunId: 'final.f1.0', attempt: 1, role: 'thinking', kind: 'thinking', text: 'checking ', ts: 10 },
  { id: 'e2', seq: 2, runId: 'r1', stageId: 'final', nodeRunId: 'final.f1.0', attempt: 1, role: 'thinking', kind: 'thinking', text: 'details', ts: 11 },
];

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
function renderWithWorkspaceReact(ui: ReactElement) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); act(() => root.render(ui)); mounted.push({ container, root });
  return { container };
}

beforeEach(() => matStore.setState({ activeRunId: 'r1', runs: { r1: run }, events: { r1: events }, filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true }, ui: { focusedNodeRunId: undefined } }));
afterEach(() => { for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); } });

describe('RunPanel smoke', () => {
  it('renders the pinned orchestrator, stage node grid, thinking status, usage, attempt, and degraded decision', () => {
    const { container } = renderWithWorkspaceReact(<RunPanel />);
    const orchestrator = within(screen.getByTestId('orchestrator-group')).getByText(/Orchestrator · claude/);
    const firstCardLabel = container.querySelector('[data-node-run-id]')?.textContent;
    expect(firstCardLabel).toContain(orchestrator.textContent);
    expect(screen.getByText('thinking')).toBeTruthy();
    expect(screen.getByText('attempt 2')).toBeTruthy();
    expect(screen.getByText(/30 tok/)).toBeTruthy();
    expect(screen.getByText('advance · degraded')).toBeTruthy();
    expect(screen.getByText('The candidates agree.')).toBeTruthy();
  });
});
