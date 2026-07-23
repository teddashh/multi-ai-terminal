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

const apiMocks = {
  installProvider: vi.fn(), getProviders: vi.fn(), refreshProviders: vi.fn(), updateProvider: vi.fn(),
  installRuntime: vi.fn(),
  startSignIn: vi.fn(), signInStatus: vi.fn(), submitSignInCode: vi.fn(), cancelSignIn: vi.fn(),
  getCodexAccounts: vi.fn(), captureCodexAccount: vi.fn(), switchCodexAccount: vi.fn(), removeCodexAccount: vi.fn(),
  getCodexApiKey: vi.fn(), setCodexApiKey: vi.fn(), clearCodexApiKey: vi.fn(), getClaudeAccounts: vi.fn(),
};
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
  apiMocks.getCodexAccounts.mockResolvedValue({ schemaVersion: 1, migrated: false, accounts: [] });
  apiMocks.getCodexApiKey.mockResolvedValue({ configured: false });
  apiMocks.getClaudeAccounts.mockResolvedValue({ accounts: [] });
  matStore.setState({ providers: [unavailable], runtimes: [] });
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
  localStorage.clear();
});

describe('ProviderSetupButton', () => {
  it('shows the canonical missing-CLI guidance in Traditional Chinese without rewriting arbitrary errors', async () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    const codex: ProviderInfo = {
      ...unavailable,
      id: 'codex',
      detail: '`codex` CLI not found on PATH — install it or remove this agent from the workflow.',
    };
    render(<UiPreferencesProvider><ProviderSetupButton provider={codex} api={api} /></UiPreferencesProvider>);
    act(() => fireEvent.click(screen.getByRole('button', { name: '設定 codex' })));
    expect(screen.getByText('`codex` CLI 不在 PATH 中。請先安裝它，或從工作流程移除此代理程式。')).toBeTruthy();
    await waitFor(() => expect(apiMocks.getCodexAccounts).toHaveBeenCalledOnce());
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

  it('uses OpenRouter runtimeFamily to offer the managed codex runtime without inventing an OpenRouter CLI', async () => {
    const openrouter: ProviderInfo = {
      id: 'openrouter', tier: 'rich', ok: false, installable: false,
      models: ['openai/gpt-test'], defaultModel: 'openai/gpt-test',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: false },
    };
    apiMocks.installRuntime.mockResolvedValueOnce({ accepted: true });
    matStore.setState({
      providers: [openrouter],
      runtimes: [{ family: 'codex', state: 'missing', canInstallManaged: true }],
    });
    render(<ProviderSetupButton provider={openrouter} api={api} />);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup openrouter' })));
    const dialog = screen.getByRole('dialog', { name: 'Setup openrouter' });
    expect(within(dialog).getByText('Runtime: codex · — · missing')).toBeTruthy();
    expect(within(dialog).getByText('OPENROUTER_API_KEY', { selector: 'code' })).toBeTruthy();
    expect(within(dialog).getByText('No').getAttribute('data-configured')).toBe('false');
    expect(within(dialog).queryByText(/openrouter CLI/i)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Install openrouter' })).toBeNull();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Install managed codex runtime for openrouter' }));
      await Promise.resolve();
    });

    expect(apiMocks.installRuntime).toHaveBeenCalledWith('codex');
    expect(apiMocks.installProvider).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Managed codex runtime installation started/)).toBeTruthy();
  });

  it('keeps setup visible for a healthy missing environment credential and localizes the value-safe status', () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    const openrouter: ProviderInfo = {
      id: 'openrouter', tier: 'rich', ok: true, installable: false,
      models: ['openai/gpt-test'], defaultModel: 'openai/gpt-test',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: false },
    };
    matStore.setState({ providers: [openrouter], runtimes: [{ family: 'codex', state: 'managed', managedVersion: '0.144.5', canInstallManaged: true }] });
    render(<UiPreferencesProvider><ProviderSetupButton provider={openrouter} api={api} /></UiPreferencesProvider>);

    act(() => fireEvent.click(screen.getByRole('button', { name: '設定 openrouter' })));
    const dialog = screen.getByRole('dialog', { name: '設定 openrouter' });
    expect(within(dialog).getByText('環境憑證')).toBeTruthy();
    expect(within(dialog).getByText('OPENROUTER_API_KEY', { selector: 'code' })).toBeTruthy();
    expect(within(dialog).getByText('否').getAttribute('data-configured')).toBe('false');
    expect(within(dialog).getByText('只有憑證名稱與是否已設定會經由伺服器 API 傳到瀏覽器。憑證值只會傳入隔離的子程序環境，MAT 不會顯示、保存或寫入紀錄。')).toBeTruthy();
    expect(within(dialog).queryByText('從 MAT 登入')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /安裝 openrouter/i })).toBeNull();
  });

  it('localizes canonical OpenRouter auth evidence without inventing a sign-in flow', () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    const openrouter: ProviderInfo = {
      id: 'openrouter', tier: 'rich', ok: true, installable: false,
      models: ['openai/gpt-test'], defaultModel: 'openai/gpt-test',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: true },
      authAlert: {
        message: "openrouter authentication failed.\nFix: Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.",
        at: 1,
        runId: 'run-openrouter',
      },
    };
    render(<UiPreferencesProvider><ProviderSetupButton provider={openrouter} api={api} /></UiPreferencesProvider>);
    act(() => fireEvent.click(screen.getByRole('button', { name: '設定 openrouter' })));
    const dialog = screen.getByRole('dialog', { name: '設定 openrouter' });
    expect(within(dialog).getByText(/openrouter 驗證失敗。/)).toBeTruthy();
    expect(within(dialog).queryByText(/authentication failed/)).toBeNull();
    expect(within(dialog).queryByText('從 MAT 登入')).toBeNull();
  });

  it('keeps setup visible for a healthy provider with a manual sign-in command', () => {
    const commandOnly: ProviderInfo = {
      id: 'agy', tier: 'rich', ok: true, installable: false,
      models: ['gemini-test'], defaultModel: 'gemini-test', signInCommand: 'agy',
    };
    render(<ProviderSetupButton provider={commandOnly} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup agy' })));
    expect(within(screen.getByRole('dialog', { name: 'Setup agy' })).getByText('agy', { selector: 'code' })).toBeTruthy();
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

    const { signInCommand: _signInCommand, ...detected } = unavailable;
    act(() => updateProvider({ ...detected, ok: true, detail: 'grok 1.0' }));

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

const claudeNeedsLogin: ProviderInfo = {
  id: 'claude', tier: 'rich', ok: true, version: 'claude 3.0.0', installable: true,
  models: ['claude'], defaultModel: 'claude',
  authAlert: { message: 'claude is not signed in.', at: 1, runId: 'run' },
  signIn: { mode: 'paste-code' }, updatable: true,
};

const codexNeedsLogin: ProviderInfo = {
  id: 'codex', tier: 'rich', ok: true, version: 'codex 0.9.0', installable: true,
  models: ['gpt'], defaultModel: 'gpt',
  authAlert: { message: 'codex is not signed in.', at: 1, runId: 'run' },
  signIn: { mode: 'device', replacesExistingLogin: true },
};

describe('ProviderSetupButton sign-in wizard', () => {
  it('runs the paste-code ceremony: URL, pasted code, success notice, refresh', async () => {
    apiMocks.startSignIn.mockResolvedValueOnce({ ok: true, loginId: 'L1', mode: 'paste-code', url: 'https://claude.ai/oauth/authorize?flow=cli' });
    apiMocks.submitSignInCode.mockResolvedValueOnce({ ok: true, statusDetail: 'Signed in.' });
    render(<ProviderSetupButton provider={claudeNeedsLogin} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup claude' })));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to claude' }));
      await Promise.resolve();
    });
    expect(apiMocks.startSignIn).toHaveBeenCalledWith('claude');
    await waitFor(() => expect(screen.getByText('https://claude.ai/oauth/authorize?flow=cli')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();

    act(() => fireEvent.change(screen.getByLabelText(/paste the code shown in the browser/), { target: { value: ' AUTH-1234 ' } }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
      await Promise.resolve();
    });

    expect(apiMocks.submitSignInCode).toHaveBeenCalledWith('claude', 'L1', 'AUTH-1234');
    await waitFor(() => expect(screen.getByText(/claude is signed in\./)).toBeTruthy());
    expect(apiMocks.refreshProviders).toHaveBeenCalled();
  });

  it('warns about the codex clobber, shows the device code, and completes on its own polling', async () => {
    apiMocks.startSignIn.mockResolvedValueOnce({ ok: true, loginId: 'L2', mode: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'JKB2-U3B4T' });
    apiMocks.signInStatus.mockResolvedValue({ phase: 'succeeded', statusDetail: 'Logged in using ChatGPT' });
    render(<ProviderSetupButton provider={codexNeedsLogin} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup codex' })));

    expect(screen.getByText(/immediately signs the current codex login out/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to codex' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(/codex is signed in\. Logged in using ChatGPT/)).toBeTruthy());
    expect(apiMocks.signInStatus).toHaveBeenCalledWith('codex', 'L2');
    expect(apiMocks.refreshProviders).toHaveBeenCalled();
  });

  it('shows the sign-in URL and one-time code while a device ceremony is pending', async () => {
    apiMocks.startSignIn.mockResolvedValueOnce({ ok: true, loginId: 'L3', mode: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'JKB2-U3B4T' });
    apiMocks.signInStatus.mockResolvedValue({ phase: 'pending', url: 'https://auth.openai.com/codex/device', userCode: 'JKB2-U3B4T' });
    apiMocks.cancelSignIn.mockResolvedValue({ ok: true });
    render(<ProviderSetupButton provider={codexNeedsLogin} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup codex' })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to codex' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('JKB2-U3B4T')).toBeTruthy());
    expect(screen.getByText('https://auth.openai.com/codex/device')).toBeTruthy();
    expect(screen.getByText(/Waiting for you to approve in the browser/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await Promise.resolve();
    });
    expect(apiMocks.cancelSignIn).toHaveBeenCalledWith('codex', 'L3');
    expect(screen.getByRole('button', { name: 'Sign in to codex' })).toBeTruthy();
  });

  it('translates canonical sign-in errors in Traditional Chinese', async () => {
    localStorage.setItem('mat-ui-preferences-v1', JSON.stringify({ language: 'zh-TW', theme: 'dark' }));
    apiMocks.startSignIn.mockResolvedValueOnce({ ok: false, error: 'Another sign-in is already in progress.' });
    render(<UiPreferencesProvider><ProviderSetupButton provider={claudeNeedsLogin} api={api} /></UiPreferencesProvider>);
    act(() => fireEvent.click(screen.getByRole('button', { name: '設定 claude' })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登入 claude' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('另一個登入程序正在進行中。')).toBeTruthy());
    expect(screen.getByRole('button', { name: '再試一次' })).toBeTruthy();
  });

  it('offers Update CLI for a healthy updatable provider and reports the refreshed version', async () => {
    const { detail: _detail, ...detected } = unavailable;
    const healthy: ProviderInfo = { ...detected, ok: true, version: 'grok 1.0.0', updatable: true };
    const updated = { ...healthy, version: 'grok 2.0.0' };
    apiMocks.updateProvider.mockResolvedValueOnce({ ok: true, exitCode: 0, provider: updated });
    apiMocks.refreshProviders.mockResolvedValueOnce([updated]);
    matStore.setState({ providers: [healthy] });
    render(<ProviderSetupButton provider={healthy} api={api} />);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update the grok CLI' }));
      await Promise.resolve();
    });

    expect(apiMocks.updateProvider).toHaveBeenCalledWith('grok');
    await waitFor(() => expect(screen.getByText(/grok is up to date and ready · grok 2\.0\.0/)).toBeTruthy());
    expect(matStore.getState().providers[0]?.version).toBe('grok 2.0.0');
  });

  it('keeps the update failure log visible when the updater exits nonzero', async () => {
    const { detail: _detail, ...detected } = unavailable;
    const healthy: ProviderInfo = { ...detected, ok: true, version: 'grok 1.0.0', updatable: true };
    apiMocks.updateProvider.mockResolvedValueOnce({ ok: false, exitCode: 3, logTail: 'npm ERR! tarball corrupted', provider: healthy });
    apiMocks.refreshProviders.mockResolvedValueOnce([healthy]);
    matStore.setState({ providers: [healthy] });
    render(<ProviderSetupButton provider={healthy} api={api} />);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup grok' })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update the grok CLI' }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('The updater exited with code 3.')).toBeTruthy());
    expect(screen.getByText(/npm ERR! tarball corrupted/)).toBeTruthy();
  });
});

describe('ProviderSetupButton account and API-key controls', () => {
  const codexReady: ProviderInfo = {
    id: 'codex', tier: 'rich', ok: true, version: 'codex 1.0.0', installable: true,
    models: ['gpt'], defaultModel: 'gpt', signIn: { mode: 'device' },
  };
  const accountIndex = {
    schemaVersion: 1 as const,
    migrated: false,
    activeAccountId: 'active',
    accounts: [
      { id: 'active', email: 'active@example.test', label: 'Active account', createdAt: '2026-01-01T00:00:00.000Z', needsLogin: false },
      { id: 'stale', email: 'stale@example.test', label: 'Stale account', createdAt: '2026-01-02T00:00:00.000Z', needsLogin: true, lastAuthError: 'token expired' },
      { id: 'other', email: 'other@example.test', label: 'Other account', createdAt: '2026-01-03T00:00:00.000Z', needsLogin: false },
    ],
  };

  async function openCodex(): Promise<HTMLElement> {
    render(<ProviderSetupButton provider={codexReady} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup codex' })));
    await waitFor(() => expect(screen.getByText('Active account · active@example.test')).toBeTruthy());
    return screen.getByRole('dialog', { name: 'Setup codex' });
  }

  it('renders active and needs-login badges and disables switching to a stale account', async () => {
    apiMocks.getCodexAccounts.mockResolvedValue(accountIndex);
    const dialog = await openCodex();
    expect(within(dialog).getByText('Active')).toBeTruthy();
    expect(within(dialog).getByText('Needs login').getAttribute('title')).toBe('token expired');
    const staleRow = within(dialog).getByText('Stale account · stale@example.test').closest('div.rounded') as HTMLElement;
    expect((within(staleRow).getByRole('button', { name: 'Switch' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refetches after switch success and surfaces a server refusal verbatim', async () => {
    apiMocks.getCodexAccounts.mockResolvedValue(accountIndex);
    apiMocks.switchCodexAccount.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'Cannot switch codex account while a turn is running.' });
    const dialog = await openCodex();
    const otherRow = within(dialog).getByText('Other account · other@example.test').closest('div.rounded') as HTMLElement;
    await act(async () => { fireEvent.click(within(otherRow).getByRole('button', { name: 'Switch' })); await Promise.resolve(); });
    await waitFor(() => expect(apiMocks.getCodexAccounts).toHaveBeenCalledTimes(2));
    await act(async () => { fireEvent.click(within(otherRow).getByRole('button', { name: 'Switch' })); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Cannot switch codex account while a turn is running.'));
  });

  it('captures and removes only after confirmation', async () => {
    apiMocks.getCodexAccounts.mockResolvedValue(accountIndex);
    apiMocks.captureCodexAccount.mockResolvedValue({ ok: true });
    apiMocks.removeCodexAccount.mockResolvedValue({ ok: true });
    const dialog = await openCodex();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Capture current login' })); await Promise.resolve(); });
    expect(apiMocks.captureCodexAccount).toHaveBeenCalledOnce();
    const otherRow = within(dialog).getByText('Other account · other@example.test').closest('div.rounded') as HTMLElement;
    act(() => fireEvent.click(within(otherRow).getByRole('button', { name: 'Remove' })));
    expect(apiMocks.removeCodexAccount).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(otherRow).getByRole('button', { name: 'Confirm remove' })); await Promise.resolve(); });
    expect(apiMocks.removeCodexAccount).toHaveBeenCalledWith('other');
  });

  it.each([
    [{ configured: true, source: 'file' }, 'Configured (file)'],
    [{ configured: true, source: 'env' }, 'Configured (environment)'],
    [{ configured: false }, 'Not configured'],
  ])('renders API-key status %#', async (status, label) => {
    apiMocks.getCodexAccounts.mockResolvedValue({ ...accountIndex, accounts: [] });
    apiMocks.getCodexApiKey.mockResolvedValue(status);
    render(<ProviderSetupButton provider={codexReady} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup codex' })));
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
  });

  it('submits the key, clears it from the DOM, and supports DELETE', async () => {
    apiMocks.getCodexAccounts.mockResolvedValue({ ...accountIndex, accounts: [] });
    apiMocks.getCodexApiKey.mockResolvedValue({ configured: true, source: 'file' });
    apiMocks.setCodexApiKey.mockResolvedValue({ configured: true, source: 'file' });
    apiMocks.clearCodexApiKey.mockResolvedValue({ configured: false });
    render(<ProviderSetupButton provider={codexReady} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup codex' })));
    const input = await screen.findByLabelText('OpenAI API key') as HTMLInputElement;
    act(() => fireEvent.change(input, { target: { value: 'sk-test-secret' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); await Promise.resolve(); });
    expect(apiMocks.setCodexApiKey).toHaveBeenCalledWith('sk-test-secret');
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain('sk-test-secret');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear' })); await Promise.resolve(); });
    expect(apiMocks.clearCodexApiKey).toHaveBeenCalledOnce();
  });

  it('renders Claude accounts read-only without account mutation controls', async () => {
    const claudeReady: ProviderInfo = { id: 'claude', tier: 'rich', ok: true, version: 'claude 1', installable: true, models: ['sonnet'], defaultModel: 'sonnet', signIn: { mode: 'paste-code' } };
    apiMocks.getClaudeAccounts.mockResolvedValue({ activeAccountId: 'c1', accounts: [{ id: 'c1', email: 'one@example.test', subscriptionType: 'max' }, { id: 'c2', email: 'two@example.test', isDefault: true }] });
    render(<ProviderSetupButton provider={claudeReady} api={api} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Setup claude' })));
    await waitFor(() => expect(screen.getByText('one@example.test')).toBeTruthy());
    expect(screen.getByText(/max/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Switch|Remove|Capture current login/ })).toBeNull();
  });
});
