// @vitest-environment jsdom

import type { ProviderInfo, WorkflowDef, Workspace } from '@mat/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matStore } from '../../app/store.js';
import { WorkflowPanel } from './WorkflowPanel.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createRun: vi.fn(), duplicateWorkflow: vi.fn(), updateWorkflow: vi.fn(),
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

const providers: ProviderInfo[] = [
  { id: 'codex', tier: 'rich', ok: true, models: ['gpt-test', 'gpt-next'], defaultModel: 'gpt-test' },
  { id: 'grok', tier: 'rich', ok: false, detail: 'binary missing', models: ['grok-test'], defaultModel: 'grok-test' },
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
    ephemeralWorkflowEdits: {}, runs: {}, activeRunId: undefined,
    runsLoading: false,
  });
});

afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
});

describe('WorkflowPanel', () => {
  it('renders the default builtin workflow, stage controls, slot editor, run box, and provider palette', async () => {
    renderPanel(<WorkflowPanel />);

    expect(await screen.findByRole('heading', { name: 'Round Table' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '⭐ Planning (default)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /R1 codex gpt-test high/ })).toBeTruthy();
    expect((screen.getByLabelText('Round Table timeout seconds') as HTMLInputElement).value).toBe('1800');
    expect(screen.getByRole('heading', { name: 'Run task' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Agent palette' })).toBeTruthy();

    const unavailable = screen.getByRole('button', { name: /grok provider unavailable: binary missing/ });
    expect((unavailable as HTMLButtonElement).disabled).toBe(true);
    expect(unavailable.parentElement?.getAttribute('title')).toBe('Unavailable: binary missing');

    act(() => fireEvent.click(screen.getByRole('button', { name: /R1 codex gpt-test high/ })));
    const slotEditor = screen.getByRole('dialog', { name: 'Edit R1' });
    expect(within(slotEditor).getByLabelText('Model').getAttribute('list')).toBe('models-round-table-r1');
    expect((within(slotEditor).getByLabelText('Prompt template') as HTMLTextAreaElement).value).toBe('{{task}}');
  });

  it('adds a provider through the keyboard fallback as an ephemeral builtin edit', async () => {
    renderPanel(<WorkflowPanel />);
    await screen.findByRole('heading', { name: 'Round Table' });

    act(() => fireEvent.click(screen.getByRole('button', { name: '+ add agent' })));

    expect(await screen.findByText('editing a copy — Duplicate to save')).toBeTruthy();
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
    await screen.findByRole('heading', { name: 'Round Table' });
    act(() => fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Ship it' } }));
    const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText('Reviewer · grok unavailable: binary missing')).toBeTruthy();
    expect(apiMocks.createRun).not.toHaveBeenCalled();
  });
});
