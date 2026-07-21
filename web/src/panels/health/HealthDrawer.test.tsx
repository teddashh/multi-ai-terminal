// @vitest-environment jsdom
import type { ProviderInfo, RunSnapshot, Workspace } from '@mat/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));

import type { ApiClient } from '../../api/client.js';
import { matStore } from '../../app/store.js';
import { HealthDrawer } from './HealthDrawer.js';

const workspace: Workspace = { id: 'w1', name: 'Example project', path: 'test-workspace', isGit: false };
const providers: ProviderInfo[] = [
  { id: 'codex', tier: 'rich', ok: true, version: 'codex 1.0', installable: true, models: [], defaultModel: '' },
  {
    id: 'claude', tier: 'rich', ok: true, version: 'claude 1.0', installable: true, models: [], defaultModel: '',
    authAlert: { message: 'claude sign-in expired.\nFix: claude, then /login', at: 2, runId: 'r1' }, signInCommand: 'claude, then /login',
  },
  { id: 'mock', tier: 'rich', ok: false, installable: false, models: [], defaultModel: '' },
];
const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', task: 'Inspect this run', status: 'failed', createdAt: 1,
  workspaceSnapshot: { name: 'Example project', path: 'test-workspace', isGit: false },
  workflow: {
    schemaVersion: 1, id: 'wf', name: 'Review', description: '', maxParallel: 1, maxRetriesPerStage: 1,
    orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 },
    stages: [{ id: 'review', name: 'Review', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: false, requireVerified: false }],
  },
  nodes: [{
    nodeRunId: 'review.a.0', stageId: 'review', slotId: 'a', instanceIndex: 0,
    agent: { provider: 'codex', permission: 'safe' }, label: 'Reviewer · codex', status: 'failed', attempt: 1, cwd: 'test-workspace',
  }],
  gateDecisions: [],
};

const apiMocks = {
  health: vi.fn(), getProviders: vi.fn(), getServerLog: vi.fn(), getDebugBundle: vi.fn(), installProvider: vi.fn(),
};
const api = apiMocks as unknown as ApiClient;
const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function render(ui: ReactElement): { root: Root } {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  mounted.push({ container, root });
  return { root };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.health.mockResolvedValue({ ok: true, version: '0.1.9' });
  apiMocks.getProviders.mockResolvedValue(providers);
  apiMocks.getServerLog.mockResolvedValue('{"cat":"probe","detail":"[REDACTED_ENV]"}\n');
  apiMocks.getDebugBundle.mockResolvedValue(new Blob(['zip']));
  matStore.setState({
    workspaces: [workspace], providers, selectedWorkspaceId: 'w1', viewedRunId: 'r1', activeRunId: undefined,
    runs: { r1: run }, events: { r1: [] }, wsConnection: 'open', evidenceIntegrity: { r1: { status: 'live' } },
    filters: { nodeRunIds: [], roles: ['user', 'agent', 'tool', 'thinking', 'system', 'decision'], follow: true },
    ui: { focusedNodeRunId: undefined },
  });
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});

describe('HealthDrawer', () => {
  it('renders honest provider, workspace, run, and evidence status after read-only refresh', async () => {
    render(<HealthDrawer open onClose={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByText('Local server reachable')).toBeTruthy());
    expect(apiMocks.health).toHaveBeenCalledOnce();
    expect(apiMocks.getProviders).toHaveBeenCalledOnce();
    expect(screen.getByText('codex: latest CLI check detected it')).toBeTruthy();
    expect(screen.getByText(/do not confirm/)).toBeTruthy();
    expect(screen.queryByText(/^Signed in$/i)).toBeNull();
    expect(screen.getByText('claude: recorded sign-in failure')).toBeTruthy();
    expect(screen.getByText('mock: deterministic test provider')).toBeTruthy();
    expect(screen.getByText('Not a Git workspace')).toBeTruthy();
    expect(screen.getByText('No verification command configured')).toBeTruthy();
    expect(screen.getByText('Evidence continuity intact')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Setup claude' })).toBeTruthy();
  });

  it('focuses and filters an affected node, delegates navigation, then closes', async () => {
    const onClose = vi.fn();
    const onInspectNode = vi.fn();
    render(<HealthDrawer open onClose={onClose} onInspectNode={onInspectNode} api={api} />);
    await waitFor(() => expect(screen.getByText('Local server reachable')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Reviewer · codex: failed' }));
    expect(matStore.getState().ui.focusedNodeRunId).toBe('review.a.0');
    expect(matStore.getState().filters.nodeRunIds).toEqual(['review.a.0']);
    expect(onInspectNode).toHaveBeenCalledWith('review.a.0');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('loads the already-redacted server diagnostic tail only after an explicit click', async () => {
    render(<HealthDrawer open onClose={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByText('Local server reachable')).toBeTruthy());
    expect(apiMocks.getServerLog).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load server log' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.getServerLog).toHaveBeenCalledOnce());
    expect(screen.getByTestId('server-log').textContent).toContain('[REDACTED_ENV]');
    expect(screen.getByText(/environment-derived values are redacted/)).toBeTruthy();
  });

  it('ignores a server-log response from an earlier drawer generation', async () => {
    let resolveLog!: (value: string) => void;
    apiMocks.getServerLog.mockReturnValueOnce(new Promise<string>((resolve) => { resolveLog = resolve; }));
    const view = render(<HealthDrawer open onClose={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByText('Local server reachable')).toBeTruthy());
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Load server log' })));

    await act(async () => { view.root.render(<HealthDrawer open={false} onClose={() => undefined} api={api} />); await Promise.resolve(); });
    await act(async () => { view.root.render(<HealthDrawer open onClose={() => undefined} api={api} />); await Promise.resolve(); });
    await waitFor(() => expect(apiMocks.health).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(apiMocks.getProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Local server reachable')).toBeTruthy());
    await act(async () => { resolveLog('stale diagnostic tail'); await Promise.resolve(); });

    expect(screen.queryByTestId('server-log')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load server log' })).toBeTruthy();
  });

  it('downloads a debug bundle for the viewed run without exposing run mutations', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:debug');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<HealthDrawer open onClose={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByText('Local server reachable')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download debug bundle' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.getDebugBundle).toHaveBeenCalledWith('r1'));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry|kill|apply/i })).toBeNull();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    click.mockRestore();
  });

  it('preserves current provider findings and reports a refresh failure', async () => {
    apiMocks.getProviders.mockRejectedValueOnce(new Error('Provider probe unavailable'));
    render(<HealthDrawer open onClose={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByText('Provider check could not refresh')).toBeTruthy());
    expect(screen.getByText('codex: latest CLI check detected it')).toBeTruthy();
    expect(screen.getByText('Provider probe unavailable')).toBeTruthy();
  });
});
