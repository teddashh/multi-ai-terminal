// @vitest-environment jsdom

import type { ProviderInfo } from '@mat/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { matStore } from '../app/store.js';
import { UiPreferencesProvider } from '../i18n/UiPreferences.js';
import { ProviderSetupButton } from './ProviderSetup.js';
import { SideDrawer } from './SideDrawer.js';

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));

const apiMocks = { installProvider: vi.fn(), getProviders: vi.fn(), refreshProviders: vi.fn() };
const api = apiMocks as unknown as ApiClient;
const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function render(ui: ReactElement): void {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  mounted.push({ container, root });
}

const unavailable: ProviderInfo = {
  id: 'grok', tier: 'rich', ok: false, detail: 'binary missing', installable: true,
  models: ['grok'], defaultModel: 'grok', signInCommand: 'grok login --device-code',
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.refreshProviders.mockResolvedValue([unavailable]);
  matStore.setState({ providers: [unavailable] });
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
  localStorage.clear();
});

describe('ProviderSetupButton', () => {
  it('shows the canonical missing-CLI guidance in Traditional Chinese without rewriting arbitrary errors', () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    const codex: ProviderInfo = {
      ...unavailable,
      id: 'codex',
      detail: '`codex` CLI not found on PATH — install it or remove this agent from the workflow.',
    };
    render(<UiPreferencesProvider><ProviderSetupButton provider={codex} api={api} /></UiPreferencesProvider>);
    act(() => fireEvent.click(screen.getByRole('button', { name: '設定 codex' })));
    expect(screen.getByText('`codex` CLI 不在 PATH 中。請先安裝它，或從工作流程移除此代理程式。')).toBeTruthy();
  });

  it('hard-exempts mock even when passed impossible unavailable and auth state', () => {
    const mock: ProviderInfo = {
      id: 'mock', tier: 'rich', ok: false, installable: true, models: [], defaultModel: 'ok',
      authAlert: { message: 'ignored', at: 1, runId: 'run' }, signInCommand: 'never run this',
    };
    render(<ProviderSetupButton provider={mock} api={api} />);
    expect(screen.queryByRole('button', { name: 'Setup mock' })).toBeNull();
    expect(apiMocks.installProvider).not.toHaveBeenCalled();
  });

  it('uses provider-specific names, focuses the popup, and Escape closes only setup', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return <SideDrawer open={open} title="Host drawer" onClose={() => setOpen(false)}>
        <ProviderSetupButton provider={unavailable} api={api} />
      </SideDrawer>;
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Setup grok' });
    act(() => fireEvent.click(trigger));
    const setup = screen.getByRole('dialog', { name: 'Setup grok' });
    const close = within(setup).getByRole('button', { name: 'Close grok setup' });
    expect(document.activeElement).toBe(close);
    expect(within(setup).getByRole('button', { name: 'Copy grok sign-in command' })).toBeTruthy();
    expect(within(setup).getByRole('button', { name: 'Install grok' })).toBeTruthy();
    expect(apiMocks.installProvider).not.toHaveBeenCalled();

    act(() => fireEvent.keyDown(close, { key: 'Escape' }));

    expect(screen.queryByRole('dialog', { name: 'Setup grok' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Host drawer' })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    expect(apiMocks.installProvider).not.toHaveBeenCalled();
  });

  it('closes and resets an open popup when an external refresh clears the provider issue', async () => {
    let updateProvider: (next: ProviderInfo) => void = () => undefined;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    function Harness() {
      const [provider, setProvider] = useState(unavailable);
      updateProvider = setProvider;
      return <SideDrawer open title="Host drawer" onClose={() => undefined}>
        <ProviderSetupButton provider={provider} api={api} />
      </SideDrawer>;
    }

    render(<Harness />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));
    const setup = screen.getByRole('dialog', { name: 'Setup grok' });
    const copy = within(setup).getByRole('button', { name: 'Copy grok sign-in command' });
    await act(async () => { fireEvent.click(copy); await Promise.resolve(); });
    expect(copy.textContent).toBe('Copied');

    act(() => updateProvider({ ...unavailable, ok: true, detail: 'grok 1.0' }));

    expect(screen.queryByRole('dialog', { name: 'Setup grok' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Setup grok' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close Host drawer' }));

    act(() => updateProvider(unavailable));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));
    expect(within(screen.getByRole('dialog', { name: 'Setup grok' })).getByRole('button', { name: 'Copy grok sign-in command' }).textContent).toBe('Copy');
    expect(apiMocks.installProvider).not.toHaveBeenCalled();
  });

  it('bypasses cached detection and reports recovery without requiring a restart', async () => {
    const detected = { ...unavailable, ok: true, version: 'grok 1.0.0', detail: undefined };
    apiMocks.refreshProviders.mockResolvedValueOnce([detected]);
    render(<ProviderSetupButton provider={unavailable} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recheck grok detection' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(/was detected and is ready/)).toBeTruthy());
    expect(apiMocks.refreshProviders).toHaveBeenCalledOnce();
    expect(matStore.getState().providers[0]?.ok).toBe(true);
  });

  it('keeps a clear completion message visible after an automatic post-install recheck', async () => {
    const detected = { ...unavailable, ok: true, version: 'grok 1.0.0', detail: undefined };
    apiMocks.installProvider.mockResolvedValueOnce({ ok: true, exitCode: 0, provider: detected });
    apiMocks.refreshProviders.mockResolvedValueOnce([detected]);
    render(<ProviderSetupButton provider={unavailable} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install grok' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(/installed and detected/)).toBeTruthy());
    expect(screen.getByText(/no restart needed/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Setup grok' })).toBeTruthy();
    expect(apiMocks.installProvider).toHaveBeenCalledWith('grok');
    expect(apiMocks.refreshProviders).toHaveBeenCalledOnce();
  });

  it('preserves a successful server-side install result when the extra UI refresh fails', async () => {
    const detected = { ...unavailable, ok: true, version: 'grok 1.0.0', detail: undefined };
    apiMocks.installProvider.mockResolvedValueOnce({ ok: true, exitCode: 0, provider: detected });
    apiMocks.refreshProviders.mockRejectedValueOnce(new Error('refresh disconnected'));
    render(<ProviderSetupButton provider={unavailable} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install grok' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(/installed and detected/)).toBeTruthy());
    expect(screen.queryByText('refresh disconnected')).toBeNull();
    expect(matStore.getState().providers[0]?.ok).toBe(true);
  });
});
