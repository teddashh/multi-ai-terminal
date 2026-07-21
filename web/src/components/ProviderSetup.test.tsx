// @vitest-environment jsdom

import type { ProviderInfo } from '@mat/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { matStore } from '../app/store.js';
import { ProviderSetupButton } from './ProviderSetup.js';
import { SideDrawer } from './SideDrawer.js';

vi.mock('zustand', () => ({ useStore: (store: { getState(): unknown }, selector: (state: never) => unknown) => selector(store.getState() as never) }));

const apiMocks = { installProvider: vi.fn(), getProviders: vi.fn() };
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
  matStore.setState({ providers: [unavailable] });
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});

describe('ProviderSetupButton', () => {
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
});
