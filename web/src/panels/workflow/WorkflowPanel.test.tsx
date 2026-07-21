// @vitest-environment jsdom

import type { ProviderInfo, RunSnapshot, WorkflowDef, Workspace } from '@mat/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matStore } from '../../app/store.js';
import { WorkflowPanel } from './WorkflowPanel.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createRun: vi.fn(), duplicateWorkflow: vi.fn(), updateWorkflow: vi.fn(), installProvider: vi.fn(), getProviders: vi.fn(), refreshProviders: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ apiClient: apiMocks }));
vi.mock('zustand', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return {
    useStore: <TState, TSlice>(
      store: { subscribe(listener: () => void): () => void; getState(): TState; getInitialState(): TState },
      selector: (state: TState) => TSlice,
    ) => useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getInitialState())),
  };
});
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  KeyboardSensor: function KeyboardSensor() {}, PointerSensor: function PointerSensor() {},
  useSensor: () => ({}), useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => undefined, transform: undefined, isDragging: false }),
  useDroppable: () => ({ setNodeRef: () => undefined, isOver: false }),
}));

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function renderPanel(element: ReactElement): void {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  act(() => root.render(element));
}

async function openCustomize(): Promise<HTMLElement> {
  const customize = await screen.findByRole('button', { name: 'Customize' });
  act(() => fireEvent.click(customize));
  return screen.getByRole('dialog', { name: 'Customize · Planning' });
}

async function openPrimarySlot(): Promise<HTMLElement> {
  const drawer = await openCustomize();
  act(() => fireEvent.click(within(drawer).getByRole('button', { name: /R1 codex gpt-test high/ })));
  return within(drawer).getByRole('dialog', { name: 'Edit R1' });
}

const providers: ProviderInfo[] = [
  { id: 'codex', tier: 'rich', ok: true, installable: true, models: ['gpt-test', 'gpt-next'], defaultModel: 'gpt-test', signInCommand: 'codex logout && codex login' },
  { id: 'grok', tier: 'rich', ok: false, detail: 'binary missing', installable: true, models: ['grok-test'], defaultModel: 'grok-test', signInCommand: 'grok login --device-code' },
];

const workflow: WorkflowDef = {
  schemaVersion: 1, id: 'planning', name: 'Planning', description: 'Plan carefully', builtin: true,
  orchestrator: { enabled: true, gateTimeoutSec: 300, agent: { provider: 'codex', model: 'gpt-test', permission: 'auto' } },
  stages: [{
    id: 'round-table', name: 'Round Table', isolation: 'none', join: 'all', timeoutSec: 1_800,
    stallSec: 240, gate: true, requireVerified: false,
    slots: [{
      id: 'r1', label: 'R1', count: 1,
      agent: { provider: 'codex', model: 'gpt-test', effort: 'high', permission: 'safe' },
      promptTemplate: '{{task}}',
    }],
  }],
  maxParallel: 4, maxRetriesPerStage: 2,
};

const workspace: Workspace = {
  id: 'w1', name: 'Castle', path: '/home/ted/projects/castle', isGit: true, defaultWorkflowId: 'planning',
};

beforeEach(() => {
  Object.values(apiMocks).forEach((mock) => mock.mockReset());
  matStore.setState({
    workflows: [workflow], providers, workspaces: [workspace], selectedWorkspaceId: 'w1',
    ephemeralWorkflowEdits: {}, runs: {}, activeRunId: undefined, viewedRunId: undefined,
    runsLoading: false,
  });
});

afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
});

describe('WorkflowPanel', () => {
  it('starts with the workspace default in the simple Launchpad and reveals advanced controls only on request', async () => {
    renderPanel(<WorkflowPanel />);

    expect(await screen.findByRole('heading', { name: 'Launchpad' })).toBeTruthy();
    const selectedMode = screen.getByRole('button', { name: /Planning/ });
    expect(selectedMode.getAttribute('aria-pressed')).toBe('true');
    expect(selectedMode.textContent).toContain('default');
    expect(selectedMode.textContent).toContain('Available 2/2');
    expect(screen.getByRole('heading', { name: 'Run task' })).toBeTruthy();
    expect(screen.getByText('CLI detected')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Round Table' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Agent palette' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Customize' }).getAttribute('aria-expanded')).toBe('false');

    const drawer = await openCustomize();
    expect(screen.getByRole('button', { name: 'Customize' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(drawer).getByRole('heading', { name: 'Round Table' })).toBeTruthy();
    expect(within(drawer).getByRole('heading', { name: 'Agent palette' })).toBeTruthy();
    expect((within(drawer).getByLabelText('Round Table timeout seconds') as HTMLInputElement).value).toBe('1800');

    const unavailable = within(drawer).getByRole('button', { name: /grok provider unavailable: binary missing/ });
    expect((unavailable as HTMLButtonElement).disabled).toBe(true);
    expect(unavailable.parentElement?.getAttribute('title')).toBe('Unavailable: binary missing');

    act(() => fireEvent.click(within(drawer).getByRole('button', { name: /R1 codex gpt-test high/ })));
    const slotEditor = within(drawer).getByRole('dialog', { name: 'Edit R1' });
    expect((within(slotEditor).getByLabelText('Model') as HTMLSelectElement).value).toBe('gpt-test');
    expect((within(slotEditor).getByLabelText('Prompt template') as HTMLTextAreaElement).value).toBe('{{task}}');
  });

  it('closes the Customize drawer with Escape and restores focus to its trigger', async () => {
    renderPanel(<WorkflowPanel />);
    const customize = await screen.findByRole('button', { name: 'Customize' });
    customize.focus();
    await openCustomize();

    act(() => fireEvent.keyDown(document, { key: 'Escape' }));

    expect(screen.queryByRole('dialog', { name: 'Customize · Planning' })).toBeNull();
    expect(document.activeElement).toBe(customize);
  });

  it('selects a listed model', async () => {
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openPrimarySlot();
    act(() => fireEvent.change(within(slotEditor).getByLabelText('Model'), { target: { value: 'gpt-next' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('gpt-next');
    expect(screen.queryByLabelText('Custom model')).toBeNull();
  });

  it('keeps Custom open while a full model id passes through a listed model', async () => {
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openPrimarySlot();
    act(() => fireEvent.change(within(slotEditor).getByLabelText('Model'), { target: { value: '__custom__' } }));
    let custom = within(slotEditor).getByLabelText('Custom model') as HTMLInputElement;
    expect(document.activeElement).toBe(custom);
    act(() => fireEvent.change(custom, { target: { value: 'gpt-test' } }));
    custom = within(slotEditor).getByLabelText('Custom model') as HTMLInputElement;
    expect(custom.value).toBe('gpt-test');
    expect(document.activeElement).toBe(custom);
    act(() => fireEvent.change(custom, { target: { value: 'gpt-test[1m]' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('gpt-test[1m]');
  });

  it('switches a custom model back to the provider default and clears the key', async () => {
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openPrimarySlot();
    const model = within(slotEditor).getByLabelText('Model');
    act(() => fireEvent.change(model, { target: { value: '__custom__' } }));
    act(() => fireEvent.change(within(slotEditor).getByLabelText('Custom model'), { target: { value: 'claude-fable-5' } }));
    act(() => fireEvent.change(model, { target: { value: '' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent).not.toHaveProperty('model');
    expect(screen.queryByLabelText('Custom model')).toBeNull();
  });

  it('installs an unavailable provider and refreshes provider state', async () => {
    const refreshed = providers.map((provider) => provider.id === 'grok' ? { ...provider, ok: true, version: 'grok 1.0.0' } : provider);
    apiMocks.installProvider.mockResolvedValueOnce({ ok: true, exitCode: 0, logTail: '', provider: refreshed[1] });
    apiMocks.refreshProviders.mockResolvedValueOnce(refreshed);
    renderPanel(<WorkflowPanel />);
    const drawer = await openCustomize();
    const grok = within(drawer).getByRole('button', { name: /grok provider unavailable/ });
    const paletteItem = grok.parentElement!;
    act(() => fireEvent.click(within(paletteItem).getByRole('button', { name: 'Setup grok' })));
    await act(async () => { fireEvent.click(within(within(drawer).getByRole('dialog', { name: 'Setup grok' })).getByRole('button', { name: 'Install grok' })); });
    expect(apiMocks.installProvider).toHaveBeenCalledWith('grok');
    expect(apiMocks.refreshProviders).toHaveBeenCalledOnce();
    expect(matStore.getState().providers.find((provider) => provider.id === 'grok')?.ok).toBe(true);
  });

  it('shows an auth-marked chip, sign-in setup with copy, and a non-blocking composer warning', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    matStore.setState({ providers: providers.map((provider) => provider.id === 'codex' ? { ...provider, authAlert: { message: 'codex is not signed in.\nFix: codex logout && codex login', at: 10, runId: 'run-auth' } } : provider) });
    renderPanel(<WorkflowPanel />);
    expect(await screen.findByText('Recent authentication failure')).toBeTruthy();
    const drawer = await openCustomize();
    const chip = within(drawer).getByRole('button', { name: 'codex provider authentication required' });
    const paletteItem = chip.parentElement!;
    expect(within(paletteItem).getByText('auth')).toBeTruthy();
    expect(paletteItem.title).toContain('codex is not signed in.');
    act(() => fireEvent.click(within(paletteItem).getByRole('button', { name: 'Setup codex' })));
    const dialog = within(drawer).getByRole('dialog', { name: 'Setup codex' });
    expect(within(dialog).getByText('Sign in')).toBeTruthy();
    expect(within(dialog).getByText('codex logout && codex login', { selector: 'code' })).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Copy codex sign-in command' })); });
    expect(writeText).toHaveBeenCalledWith('codex logout && codex login');
    act(() => fireEvent.click(within(drawer).getByRole('button', { name: 'Close Customize · Planning' })));
    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Keep going' } }));
    expect(screen.getByText(/Sign-in warning: codex is not signed in/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds a provider through the keyboard fallback as an ephemeral builtin edit', async () => {
    renderPanel(<WorkflowPanel />);
    const drawer = await openCustomize();

    act(() => fireEvent.click(within(drawer).getByRole('button', { name: '+ add agent' })));

    expect(await within(drawer).findByText('Editing a run-scoped copy')).toBeTruthy();
    expect(workflow.stages[0]!.slots).toHaveLength(1);
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots).toHaveLength(2);
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[1]).toMatchObject({
      agent: { provider: 'codex', model: 'gpt-test', permission: 'auto' }, count: 1,
    });
  });

  it('blocks starting when a bound provider is unavailable', async () => {
    matStore.setState({
      ephemeralWorkflowEdits: {
        planning: {
          ...workflow,
          stages: [{ ...workflow.stages[0]!, slots: [{ ...workflow.stages[0]!.slots[0]!, label: 'Reviewer', agent: { provider: 'grok', model: 'grok-test', permission: 'safe' } }] }],
        },
      },
    });
    renderPanel(<WorkflowPanel />);
    await screen.findByRole('heading', { name: 'Run task' });
    const selectedMode = screen.getByRole('button', { name: /Planning/ });
    expect(selectedMode.textContent).toContain('Available 1/2');
    expect(screen.getByText(/Needs setup/).parentElement?.textContent).toContain('Needs setup · 1/2');
    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Ship it' } }));
    const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText('Reviewer · grok unavailable: binary missing')).toBeTruthy();
    expect(apiMocks.createRun).not.toHaveBeenCalled();
  });

  it('does not switch a new workspace back when an earlier create-run response arrives late', async () => {
    const secondWorkspace: Workspace = { ...workspace, id: 'w2', name: 'Keep', path: '/workspace/two' };
    matStore.setState({ workspaces: [workspace, secondWorkspace] });
    let resolveRun!: (run: RunSnapshot) => void;
    apiMocks.createRun.mockImplementationOnce(() => new Promise<RunSnapshot>((resolve) => { resolveRun = resolve; }));
    renderPanel(<WorkflowPanel />);
    await screen.findByRole('heading', { name: 'Run task' });
    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Slow create' } }));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Start' })));
    expect(apiMocks.createRun).toHaveBeenCalledOnce();

    act(() => matStore.getState().setSelectedWorkspaceId('w2'));
    const lateRun: RunSnapshot = {
      runId: 'late-w1', workspaceId: 'w1', workspaceSnapshot: { name: workspace.name, path: workspace.path, isGit: workspace.isGit },
      workflow, task: 'Slow create', status: 'running', nodes: [], gateDecisions: [], createdAt: 1,
    };
    await act(async () => { resolveRun(lateRun); await Promise.resolve(); });

    expect(matStore.getState().runs['late-w1']).toEqual(lateRun);
    expect(matStore.getState().selectedWorkspaceId).toBe('w2');
    expect(matStore.getState().activeRunId).toBeUndefined();
    expect(matStore.getState().viewedRunId).toBeUndefined();
  });

  it('clears the task and builtin run override when the workspace changes', async () => {
    const secondWorkspace: Workspace = { ...workspace, id: 'w2', name: 'Keep', path: '/workspace/two' };
    matStore.setState({ workspaces: [workspace, secondWorkspace] });
    renderPanel(<WorkflowPanel />);
    await screen.findByRole('heading', { name: 'Run task' });

    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Only for Castle' } }));
    const drawer = await openCustomize();
    act(() => fireEvent.click(within(drawer).getByRole('button', { name: '+ add agent' })));
    expect(matStore.getState().ephemeralWorkflowEdits.planning).toBeDefined();

    act(() => matStore.getState().setSelectedWorkspaceId('w2'));

    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe('');
    expect(matStore.getState().ephemeralWorkflowEdits).not.toHaveProperty('planning');
    expect(screen.queryByRole('dialog', { name: 'Customize · Planning' })).toBeNull();
    expect(screen.queryByText('Customized for this run · duplicate it to save permanently.')).toBeNull();
  });

  it('warns without blocking when requireVerified cannot produce verification evidence', async () => {
    matStore.setState({
      ephemeralWorkflowEdits: {
        planning: {
          ...workflow,
          stages: [{ ...workflow.stages[0]!, isolation: 'none', gate: false, requireVerified: true }],
        },
      },
    });
    renderPanel(<WorkflowPanel />);
    await screen.findByRole('heading', { name: 'Run task' });
    expect(screen.getByText('Verification readiness warning')).toBeTruthy();
    expect(screen.getByText(/needs an enabled gate; the policy will not run/)).toBeTruthy();
    expect(screen.getByText(/needs worktree isolation; verification will be skipped/)).toBeTruthy();
    expect(screen.getByText(/needs a workspace verify command; verification will be skipped/)).toBeTruthy();

    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Proceed with an honest warning' } }));
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
