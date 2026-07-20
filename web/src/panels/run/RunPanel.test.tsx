// @vitest-environment jsdom
import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));
const apiMocks = vi.hoisted(() => ({ steerRun: vi.fn(), getDebugBundle: vi.fn() }));
vi.mock('../../api/client.js', () => ({
  apiClient: { getRuns: vi.fn().mockResolvedValue([]), getWorkspaces: vi.fn().mockResolvedValue([]), steerRun: apiMocks.steerRun, getDebugBundle: apiMocks.getDebugBundle },
}));

import { matStore } from '../../app/store.js';
import { NodeCard, RunPanel } from './RunPanel.js';

const workflow: RunSnapshot['workflow'] = {
  schemaVersion: 1, id: 'wf', name: 'Planning', description: '', maxParallel: 2, maxRetriesPerStage: 2,
  orchestrator: { enabled: true, agent: { provider: 'claude', permission: 'safe' }, gateTimeoutSec: 30 },
  stages: [
    { id: 'round', name: 'Round Table', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false },
    { id: 'final', name: 'Final Review', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false },
  ],
};
const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', workflow, task: 'Build a plan', status: 'running', currentStageId: 'final', createdAt: 1,
  nodes: [
    { nodeRunId: 'round.r1.0', stageId: 'round', slotId: 'r1', instanceIndex: 0, agent: { provider: 'codex', permission: 'safe' }, label: 'R1 · codex', status: 'done', attempt: 2, cwd: 'test-workspace', startedAt: 1000, endedAt: 66_000, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 }, patchFile: 'r1.patch', verification: { status: 'passed', command: 'npm test' }, handoff: { priorNodeRunIds: ['prior.a.0'], orchestratorContext: true, retryAddendum: true } },
    { nodeRunId: 'orchestrator', stageId: null, slotId: 'orchestrator', instanceIndex: 0, agent: { provider: 'claude', permission: 'safe' }, label: 'Orchestrator · claude', status: 'done', attempt: 1, cwd: 'test-workspace' },
    { nodeRunId: 'final.f1.0', stageId: 'final', slotId: 'f1', instanceIndex: 0, agent: { provider: 'grok', permission: 'safe' }, label: 'Final · grok', status: 'running', attempt: 1, cwd: 'test-workspace', startedAt: Date.now() },
  ],
  gateDecisions: [{ stageId: 'round', gateAttempt: 1, action: 'advance', rationale: 'The candidates agree.', contextForNext: 'Prefer the safe design.', degraded: true, ts: 100 }],
};
const events: AgentEvent[] = [
  { id: 'e0', seq: 1, runId: 'r1', stageId: 'round', nodeRunId: 'round.r1.0', attempt: 2, role: 'user', kind: 'message', text: 'seed evidence prompt', ts: 9 },
  { id: 'e1', seq: 2, runId: 'r1', stageId: 'final', nodeRunId: 'final.f1.0', attempt: 1, role: 'thinking', kind: 'thinking', text: 'checking ', ts: 10 },
  { id: 'e2', seq: 3, runId: 'r1', stageId: 'final', nodeRunId: 'final.f1.0', attempt: 1, role: 'thinking', kind: 'thinking', text: 'details', ts: 11 },
];

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
function renderWithWorkspaceReact(ui: ReactElement) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); act(() => root.render(ui)); mounted.push({ container, root });
  return { container };
}

beforeEach(() => {
  apiMocks.steerRun.mockReset().mockResolvedValue(run);
  apiMocks.getDebugBundle.mockReset().mockResolvedValue(new Blob(['zip']));
  matStore.setState({ activeRunId: 'r1', runs: { r1: run }, events: { r1: events }, filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true }, ui: { focusedNodeRunId: undefined } });
});
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
    expect(screen.getByText('✓ verified')).toBeTruthy();
    expect(screen.getByText(/1 upstream node/)).toBeTruthy();
    expect(screen.getByText('Seed prompt')).toBeTruthy();
    expect(screen.getByText('1 passed / 0 failed / 0 skipped')).toBeTruthy();
  });

  it('submits the default interrupt mode and renders steer groups with review decisions', async () => {
    const steered: RunSnapshot = {
      ...run,
      nodes: [...run.nodes, { ...run.nodes[0]!, nodeRunId: 'steer-1.agent.0', stageId: 'steer-1', slotId: 'agent', label: 'Steer · codex', attempt: 1 }],
      steers: [{ steerId: 's_1', text: 'change direction', mode: 'interrupt', status: 'reviewed', createdAt: 1, steerStageId: 'steer-1' }],
      gateDecisions: [...run.gateDecisions, { stageId: 'steer-1', gateAttempt: 1, action: 'advance', rationale: 'Steer accepted.', ts: 200 }],
    };
    apiMocks.steerRun.mockResolvedValue(steered);
    matStore.setState({ runs: { r1: steered } });
    renderWithWorkspaceReact(<RunPanel />);
    expect(screen.getByTestId('steer-group')).toBeTruthy();
    expect(screen.getByText('steer review')).toBeTruthy();
    const input = screen.getByLabelText('Steer instruction');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'new instruction' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.steerRun).toHaveBeenCalledWith('r1', { text: 'new instruction', mode: 'interrupt' }));
  });

  it('renders errorReason for a failed node as amber multi-line guidance', () => {
    const failed = { ...run.nodes[0]!, status: 'failed' as const, error: 'exit 1', errorReason: 'codex sign-in expired.\nFix: codex logout && codex login' };
    const { container } = renderWithWorkspaceReact(<NodeCard node={failed} latestEvent={undefined} now={Date.now()} confirmingKill={false} onRequestKill={() => undefined} onCancelKill={() => undefined} onKill={() => undefined} onPatch={() => undefined} onFocus={() => undefined} />);
    const reason = container.querySelector('p[title*="codex sign-in expired"]')!;
    expect(reason.getAttribute('title')).toBe('codex sign-in expired.\nFix: codex logout && codex login');
    expect(reason.textContent).toBe('codex sign-in expired.\nFix: codex logout && codex login');
    expect(reason.className).toContain('line-clamp-3');
    expect(reason.className).toContain('whitespace-pre-line');
    expect(reason.className).toContain('text-amber-200');
    expect(screen.queryByText('exit 1')).toBeNull();
  });

  it('downloads the debug bundle from the Debug button', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:debug');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderWithWorkspaceReact(<RunPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.getDebugBundle).toHaveBeenCalledWith('r1'));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    click.mockRestore();
  });
});
