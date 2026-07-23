// @vitest-environment jsdom

import type { OpenRouterModelCatalog, ProviderInfo, RunSnapshot, WorkflowDef, Workspace } from '@mat/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matStore } from '../../app/store.js';
import { UiPreferencesProvider } from '../../i18n/UiPreferences.js';
import { WorkflowPanel } from './WorkflowPanel.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createRun: vi.fn(), duplicateWorkflow: vi.fn(), updateWorkflow: vi.fn(), installProvider: vi.fn(), getProviders: vi.fn(), getOpenRouterModels: vi.fn(), refreshProviders: vi.fn(),
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

async function openOpenRouterSlot(): Promise<HTMLElement> {
  const drawer = await openCustomize();
  act(() => fireEvent.click(within(drawer).getByRole('button', { name: /R1 openrouter/ })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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

const openRouterCatalog: OpenRouterModelCatalog = {
  source: 'live',
  groups: [
    {
      id: '~openai/gpt-latest',
      label: 'OpenAI GPT Latest',
      defaultVersion: '~openai/gpt-latest',
      versions: [
        { id: '~openai/gpt-latest', label: 'OpenAI GPT', kind: 'latest', supportsTools: true },
      ],
    },
    {
      id: 'openai/gpt-5.6-sol-20260709',
      label: 'OpenAI: GPT-5.6 Sol',
      defaultVersion: 'openai/gpt-5.6-sol',
      versions: [
        { id: 'openai/gpt-5.6-sol', label: 'openai/gpt-5.6-sol', kind: 'current', supportsTools: true, created: 1_783_590_850 },
        { id: 'openai/gpt-5.6-sol-preview', label: 'openai/gpt-5.6-sol-preview', kind: 'current', supportsTools: true, created: 1_783_590_850 },
        { id: 'openai/gpt-5.6-sol-20260709', label: 'GPT-5.6 Sol', kind: 'pinned', supportsTools: true, created: 1_783_590_850 },
      ],
    },
    {
      id: '~anthropic/claude-sonnet-latest',
      label: 'Anthropic Claude Sonnet Latest',
      defaultVersion: '~anthropic/claude-sonnet-latest',
      versions: [
        { id: '~anthropic/claude-sonnet-latest', label: 'Claude Sonnet', kind: 'latest', supportsTools: true },
      ],
    },
    {
      id: 'anthropic/claude-sonnet-4.6-20260612',
      label: 'Anthropic: Claude Sonnet 4.6',
      defaultVersion: 'anthropic/claude-sonnet-4.6',
      versions: [
        { id: 'anthropic/claude-sonnet-4.6', label: 'anthropic/claude-sonnet-4.6', kind: 'current', supportsTools: false, created: 1_781_225_600 },
        { id: 'anthropic/claude-sonnet-4.6-20260612', label: 'Claude Sonnet 4.6', kind: 'pinned', supportsTools: false, created: 1_781_225_600 },
      ],
    },
  ],
};

const openRouterProvider: ProviderInfo = {
  id: 'openrouter',
  tier: 'rich',
  ok: true,
  installable: false,
  models: ['~openai/gpt-latest', '~anthropic/claude-sonnet-latest'],
  defaultModel: '~openai/gpt-latest',
  runtimeFamily: 'codex',
  environmentCredential: { name: 'OPENROUTER_API_KEY', configured: true },
};

function useOpenRouterSlot(model: string | undefined): void {
  matStore.setState({
    providers: [openRouterProvider],
    workflows: [{
      ...workflow,
      orchestrator: { ...workflow.orchestrator, enabled: false },
      stages: [{
        ...workflow.stages[0]!,
        slots: [{
          ...workflow.stages[0]!.slots[0]!,
          agent: { provider: 'openrouter', ...(model ? { model } : {}), permission: 'safe' },
        }],
      }],
    }],
  });
}

beforeEach(() => {
  Object.values(apiMocks).forEach((mock) => mock.mockReset());
  apiMocks.getOpenRouterModels.mockResolvedValue(openRouterCatalog);
  matStore.setState({
    workflows: [workflow], providers, workspaces: [workspace], selectedWorkspaceId: 'w1',
    ephemeralWorkflowEdits: {}, runs: {}, activeRunId: undefined, viewedRunId: undefined,
    runsLoading: false, runtimes: [],
  });
});

afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
  localStorage.clear();
});

describe('WorkflowPanel', () => {
  it('renders built-in workflow, stage, effort, and permission chrome in Traditional Chinese', async () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    matStore.setState({ workflows: [{
      ...workflow,
      name: 'Planning Mode',
      description: 'Independent plans followed by a consolidated final review.',
    }] });
    renderPanel(<UiPreferencesProvider><WorkflowPanel /></UiPreferencesProvider>);

    expect(await screen.findByRole('button', { name: /規劃模式/ })).toBeTruthy();
    expect(screen.getAllByText('由多個代理程式獨立提出計畫，再彙整成最終審查結果。').length).toBeGreaterThan(0);
    act(() => fireEvent.click(screen.getByRole('button', { name: '進階設定' })));
    const drawer = screen.getByRole('dialog', { name: '進階設定・規劃模式' });
    expect(within(drawer).getByRole('heading', { name: '圓桌討論' })).toBeTruthy();
    act(() => fireEvent.click(within(drawer).getByRole('button', { name: /R1 codex gpt-test 高/ })));
    const editor = within(drawer).getByRole('dialog', { name: '編輯 R1' });
    expect((within(editor).getByLabelText('推理強度') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('高');
    expect((within(editor).getByLabelText('權限') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('安全');
  });

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

  it('requires an OpenRouter model choice before version and stores the exact selected version slug', async () => {
    useOpenRouterSlot(undefined);
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openOpenRouterSlot();

    const model = within(slotEditor).getByLabelText('Model') as HTMLSelectElement;
    const version = within(slotEditor).getByLabelText('Version') as HTMLSelectElement;
    await waitFor(() => {
      expect(apiMocks.getOpenRouterModels).toHaveBeenCalledOnce();
      expect(Array.from(model.options).some((option) => option.value === 'openai/gpt-5.6-sol-20260709')).toBe(true);
    });
    expect(model.value).toBe('');
    expect(version.disabled).toBe(true);
    expect(version.selectedOptions[0]?.textContent).toBe('Select a model first');

    act(() => fireEvent.change(model, { target: { value: 'openai/gpt-5.6-sol-20260709' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('openai/gpt-5.6-sol');
    expect(version.disabled).toBe(false);
    expect(version.value).toBe('openai/gpt-5.6-sol');

    act(() => fireEvent.change(version, { target: { value: 'openai/gpt-5.6-sol-20260709' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('openai/gpt-5.6-sol-20260709');
    expect(model.value).toBe('openai/gpt-5.6-sol-20260709');
  });

  it('resolves an existing OpenRouter version and resets it when the model family changes', async () => {
    useOpenRouterSlot('openai/gpt-5.6-sol-20260709');
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openOpenRouterSlot();

    await waitFor(() => expect((within(slotEditor).getByLabelText('Model') as HTMLSelectElement).value).toBe('openai/gpt-5.6-sol-20260709'));
    const model = within(slotEditor).getByLabelText('Model') as HTMLSelectElement;
    const version = within(slotEditor).getByLabelText('Version') as HTMLSelectElement;
    expect(version.value).toBe('openai/gpt-5.6-sol-20260709');

    act(() => fireEvent.change(model, { target: { value: 'anthropic/claude-sonnet-4.6-20260612' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('anthropic/claude-sonnet-4.6');
    expect(version.value).toBe('anthropic/claude-sonnet-4.6');
    expect(Array.from(version.options).some((option) => option.textContent?.includes('tool calling not advertised'))).toBe(true);
  });

  it('keeps alternate OpenRouter aliases inside their shared canonical model group', async () => {
    useOpenRouterSlot('openai/gpt-5.6-sol-preview');
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openOpenRouterSlot();

    const model = within(slotEditor).getByLabelText('Model') as HTMLSelectElement;
    const version = within(slotEditor).getByLabelText('Version') as HTMLSelectElement;
    await waitFor(() => expect(model.value).toBe('openai/gpt-5.6-sol-20260709'));
    expect(version.value).toBe('openai/gpt-5.6-sol-preview');

    act(() => fireEvent.change(version, { target: { value: 'openai/gpt-5.6-sol-20260709' } }));
    expect(model.value).toBe('openai/gpt-5.6-sol-20260709');
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('openai/gpt-5.6-sol-20260709');
  });

  it('keeps an unknown OpenRouter variant in Custom without stripping its suffix or auto-collapsing', async () => {
    useOpenRouterSlot('vendor/model:thinking');
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openOpenRouterSlot();

    const custom = await within(slotEditor).findByLabelText('Custom model') as HTMLInputElement;
    expect(custom.value).toBe('vendor/model:thinking');
    expect(document.activeElement).toBe(custom);
    act(() => fireEvent.change(custom, { target: { value: '~openai/gpt-latest' } }));
    expect((within(slotEditor).getByLabelText('Custom model') as HTMLInputElement).value).toBe('~openai/gpt-latest');
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.stages[0]!.slots[0]!.agent.model).toBe('~openai/gpt-latest');
  });

  it('uses the same OpenRouter model-then-version editor for the orchestrator', async () => {
    matStore.setState({
      providers: [openRouterProvider],
      workflows: [{
        ...workflow,
        orchestrator: {
          enabled: true,
          gateTimeoutSec: 300,
          agent: { provider: 'openrouter', model: '~openai/gpt-latest', permission: 'auto' },
        },
      }],
    });
    renderPanel(<WorkflowPanel />);
    const drawer = await openCustomize();
    act(() => fireEvent.click(within(drawer).getByRole('button', { name: /openrouter · ~openai\/gpt-latest/ })));
    const editor = within(drawer).getByRole('dialog', { name: 'Orchestrator binding' });

    await waitFor(() => expect((within(editor).getByLabelText('Model') as HTMLSelectElement).value).toBe('~openai/gpt-latest'));
    act(() => fireEvent.change(within(editor).getByLabelText('Model'), { target: { value: 'openai/gpt-5.6-sol-20260709' } }));
    act(() => fireEvent.change(within(editor).getByLabelText('Version'), { target: { value: 'openai/gpt-5.6-sol-20260709' } }));
    expect(matStore.getState().ephemeralWorkflowEdits.planning?.orchestrator.agent.model).toBe('openai/gpt-5.6-sol-20260709');
  });

  it('keeps built-in OpenRouter model and version choices available when catalog refresh fails', async () => {
    apiMocks.getOpenRouterModels.mockRejectedValueOnce(new Error('remote catalog detail must stay hidden'));
    useOpenRouterSlot('~openai/gpt-latest');
    renderPanel(<WorkflowPanel />);
    const slotEditor = await openOpenRouterSlot();

    expect(await within(slotEditor).findByText('OpenRouter is unavailable; showing built-in choices. Custom model IDs remain available.')).toBeTruthy();
    expect((within(slotEditor).getByLabelText('Model') as HTMLSelectElement).value).toBe('~openai/gpt-latest');
    expect((within(slotEditor).getByLabelText('Version') as HTMLSelectElement).value).toBe('~openai/gpt-latest');
    expect(slotEditor.textContent).not.toContain('remote catalog detail');
  });

  it('labels the OpenRouter model-then-version flow in Traditional Chinese', async () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    useOpenRouterSlot('~openai/gpt-latest');
    renderPanel(<UiPreferencesProvider><WorkflowPanel /></UiPreferencesProvider>);

    const customize = await screen.findByRole('button', { name: '進階設定' });
    act(() => fireEvent.click(customize));
    const drawer = screen.getByRole('dialog', { name: /進階設定/ });
    act(() => fireEvent.click(within(drawer).getByRole('button', { name: /R1 openrouter/ })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const editor = within(drawer).getByRole('dialog', { name: '編輯 R1' });
    expect(within(editor).getByLabelText('模型')).toBeTruthy();
    expect(within(editor).getByLabelText('版本')).toBeTruthy();
    expect((within(editor).getByLabelText('版本') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('最新版本（自動更新）');
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

  it('marks a missing OpenRouter environment credential amber without claiming CLI/sign-in or blocking Start', async () => {
    const openrouter: ProviderInfo = {
      id: 'openrouter', tier: 'rich', ok: true, installable: false,
      models: ['openai/gpt-test'], defaultModel: 'openai/gpt-test',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: false },
      authAlert: { message: 'openrouter authentication failed. Set OPENROUTER_API_KEY.', at: 10, runId: 'run-key' },
    };
    const openrouterWorkflow: WorkflowDef = {
      ...workflow,
      orchestrator: { ...workflow.orchestrator, enabled: false },
      stages: [{
        ...workflow.stages[0]!,
        slots: [{
          ...workflow.stages[0]!.slots[0]!,
          agent: { provider: 'openrouter', model: 'openai/gpt-test', permission: 'safe' },
        }],
      }],
    };
    matStore.setState({ workflows: [openrouterWorkflow], providers: [openrouter] });
    renderPanel(<WorkflowPanel />);

    await screen.findByRole('heading', { name: 'Run task' });
    const mode = screen.getByRole('button', { name: /Planning/ });
    expect(mode.textContent).toContain('Available 0/1');
    const readiness = screen.getByText(/Needs setup · 0\/1/);
    expect(readiness.className).toContain('border-amber-800');
    expect(screen.getByText('OPENROUTER_API_KEY · not configured')).toBeTruthy();
    expect(screen.getByText('Environment credential warning: openrouter: OPENROUTER_API_KEY')).toBeTruthy();
    expect(screen.queryByText('CLI detected')).toBeNull();
    expect(screen.queryByText('Recent authentication failure')).toBeNull();
    expect(screen.queryByText(/Sign-in warning/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Setup openrouter' })).toBeTruthy();

    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Use OpenRouter' } }));
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);

    const drawer = await openCustomize();
    expect(within(drawer).getByRole('button', { name: 'openrouter provider environment credential required' })).toBeTruthy();
    expect(within(drawer).getByText('credential')).toBeTruthy();
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
