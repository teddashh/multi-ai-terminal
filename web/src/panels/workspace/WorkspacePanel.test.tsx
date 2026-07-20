// @vitest-environment jsdom

import type { RunSnapshot, Workspace } from '@mat/shared';
import { fireEvent, screen } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matStore } from '../../app/store.js';
import { WorkspacePanel } from './WorkspacePanel.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(), updateWorkspace: vi.fn(), deleteWorkspace: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('../../api/client.js', () => ({ apiClient: apiMocks }));
vi.mock('@tauri-apps/plugin-dialog', () => dialogMocks);
vi.mock('zustand', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  return {
    useStore: <TState, TSlice>(
      store: { subscribe(listener: () => void): () => void; getState(): TState; getInitialState(): TState },
      selector: (state: TState) => TSlice,
    ) => useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getInitialState())),
  };
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function renderPanel(element: ReactElement): void {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  act(() => root.render(element));
}

const workspaces: Workspace[] = [
  {
    id: 'w1', name: 'Castle', path: '/home/ted/projects/castle', isGit: true, verifyCommand: 'npm test', verifyTimeoutSec: 90,
    lastRun: { runId: 'r1', workflowName: 'Planning', status: 'done', at: Date.now() - 2 * 60 * 60_000 },
  },
  { id: 'w2', name: 'Notes', path: '/srv/notes', isGit: false },
];

beforeEach(() => {
  apiMocks.createWorkspace.mockReset(); apiMocks.updateWorkspace.mockReset(); apiMocks.deleteWorkspace.mockReset();
  dialogMocks.open.mockReset();
  delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  matStore.setState({ workspaces, selectedWorkspaceId: 'w1', runs: {
    live: { runId: 'live', workspaceId: 'w1', status: 'running' } as RunSnapshot,
  } });
});

afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
});

describe('WorkspacePanel', () => {
  it('hides Browse outside Tauri', () => {
    renderPanel(<WorkspacePanel />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add workspace' })));
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
  });

  it('fills the path from the Tauri folder picker', async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    dialogMocks.open.mockResolvedValueOnce(String.raw`C:\projects\castle`);
    renderPanel(<WorkspacePanel />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add workspace' })));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Browse…' })); });
    expect(dialogMocks.open).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect((screen.getByLabelText('Absolute path') as HTMLInputElement).value).toBe(String.raw`C:\projects\castle`);
  });

  it('renders workspace metadata, last-run time, git state, and a live pulse', () => {
    renderPanel(<WorkspacePanel />);

    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByText('Castle')).toBeTruthy();
    expect(screen.getByText('…/projects/castle')).toBeTruthy();
    expect(screen.getByText(/Planning · done · 2h ago/)).toBeTruthy();
    expect(screen.getByText('git')).toBeTruthy();
    expect(screen.getByLabelText('Run in progress')).toBeTruthy();

    act(() => fireEvent.click(screen.getByRole('button', { name: /Notes/ })));
    expect(matStore.getState().selectedWorkspaceId).toBe('w2');
  });

  it('keeps server validation errors inside the add-workspace dialog', async () => {
    apiMocks.createWorkspace.mockRejectedValueOnce(new Error('Path does not exist'));
    renderPanel(<WorkspacePanel />);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add workspace' })));
    act(() => fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Missing' } }));
    act(() => fireEvent.change(screen.getByLabelText('Absolute path'), { target: { value: '/missing' } }));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Add workspace' })); });

    expect((await screen.findByRole('alert')).textContent).toContain('Path does not exist');
  });

  it('edits and clears verification settings with null', async () => {
    apiMocks.updateWorkspace.mockResolvedValueOnce({ ...workspaces[0], name: 'Castle Updated', verifyCommand: undefined, verifyTimeoutSec: undefined });
    renderPanel(<WorkspacePanel />);
    act(() => fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!));
    expect((screen.getByLabelText('Verify command') as HTMLInputElement).value).toBe('npm test');
    act(() => fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Castle Updated' } }));
    act(() => fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: '' } }));
    act(() => fireEvent.change(screen.getByLabelText('Verify timeout (seconds)'), { target: { value: '' } }));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit workspace' })); });
    expect(apiMocks.updateWorkspace).toHaveBeenCalledWith('w1', { name: 'Castle Updated', verifyCommand: null, verifyTimeoutSec: null });
  });
});
