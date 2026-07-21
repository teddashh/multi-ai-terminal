// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mounts = vi.hoisted(() => ({ projects: 0, launch: 0, activity: 0, workspace: 0 }));
vi.mock('../panels/workspace/WorkspacePanel.js', () => ({ WorkspacePanel: () => { mounts.projects += 1; const [value, setValue] = useState(''); return <label>Project draft<input aria-label="Project draft" value={value} onChange={(event) => setValue(event.target.value)} /></label>; } }));
vi.mock('../panels/workflow/WorkflowPanel.js', () => ({ WorkflowPanel: () => { mounts.launch += 1; const [value, setValue] = useState(''); return <label>Task draft<input aria-label="Task draft" value={value} onChange={(event) => setValue(event.target.value)} /></label>; } }));
vi.mock('../panels/run/RunPanel.js', () => ({ RunPanel: () => { mounts.activity += 1; return <div>Activity content</div>; } }));
vi.mock('./RunWorkspace.js', () => ({ RunWorkspace: () => { mounts.workspace += 1; return <div>Conversation content</div>; } }));

import { AppShell, fitShellLayout, loadShellLayout } from './AppShell.js';

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function renderShell(element: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  localStorage.clear();
  Object.assign(mounts, { projects: 0, launch: 0, activity: 0, workspace: 0 });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  for (const item of mounted.splice(0)) { act(() => item.root.unmount()); item.container.remove(); }
});

describe('AppShell', () => {
  it('keeps both Launchpad views mounted and preserves drafts while navigating', () => {
    const container = renderShell(<AppShell />);
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    const task = screen.getByLabelText('Task draft') as HTMLInputElement;
    act(() => fireEvent.change(task, { target: { value: 'Keep this task' } }));

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Projects' })));
    expect((container.querySelector('#launchpad-launch') as HTMLElement).hidden).toBe(true);
    expect((container.querySelector('#launchpad-projects') as HTMLElement).hidden).toBe(false);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Launch' })));

    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe('Keep this task');
    expect(mounts.projects).toBeGreaterThan(0);
    expect(mounts.launch).toBeGreaterThan(0);
    expect(screen.getByText('Activity content')).toBeTruthy();
    expect(screen.getByText('Conversation content')).toBeTruthy();
  });

  it('collapses either side region without unmounting it', () => {
    renderShell(<AppShell />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Hide settings' })));
    expect(screen.getByTestId('app-shell').style.gridTemplateColumns).toContain('0px 0px');
    expect(screen.getByRole('button', { name: 'Show settings' })).toBeTruthy();
    expect(document.querySelector('[aria-label="Launchpad"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('launchpad-content').hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('[aria-label="Task draft"]')).toBeTruthy();

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Hide activity' })));
    expect(screen.getByRole('button', { name: 'Show activity' })).toBeTruthy();
    expect(document.querySelector('[aria-label="Activity inspector"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('inspector-content').hasAttribute('hidden')).toBe(true);
    expect(document.body.textContent).toContain('Activity content');
  });

  it('supports keyboard resizing and stores the v2 layout independently', async () => {
    renderShell(<AppShell />);
    const divider = screen.getByRole('separator', { name: 'Resize Launchpad' });
    expect(divider.getAttribute('aria-valuenow')).toBe('320');
    act(() => fireEvent.keyDown(divider, { key: 'ArrowRight' }));
    expect(divider.getAttribute('aria-valuenow')).toBe('330');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('mat-shell-layout-v2') ?? '{}')).toMatchObject({ launchpadWidth: 330, inspectorWidth: 280 }));
  });

  it('rejects malformed persistence and clamps valid widths', () => {
    localStorage.setItem('mat-shell-layout-v2', '{broken');
    expect(loadShellLayout()).toEqual({ launchpadWidth: 320, inspectorWidth: 280 });
    localStorage.setItem('mat-shell-layout-v2', JSON.stringify({ launchpadWidth: 12, inspectorWidth: 900 }));
    expect(loadShellLayout()).toEqual({ launchpadWidth: 280, inspectorWidth: 520 });
  });

  it('fits oversized persisted side panels without clipping the run workspace', () => {
    const fitted = fitShellLayout({ launchpadWidth: 520, inspectorWidth: 520 }, 1024, true, true);
    expect(84 + fitted.launchpadWidth + 5 + fitted.inspectorWidth + 5 + 320).toBeLessThanOrEqual(1024);
  });
});
