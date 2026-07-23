import type { ClaudeAccountIndexResponse, CodexAccountIndex, ProviderInfo } from '@mat/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { apiClient, type ApiClient, type CodexApiKeyStatus } from '../api/client.js';
import { matStore, useMatStore } from '../app/store.js';
import { displayAuthAlertMessage, displayProviderDetail, displaySignInMessage } from '../i18n/displayText.js';
import { useUiPreferences } from '../i18n/UiPreferences.js';

interface SetupNotice {
  tone: 'success' | 'warning';
  text: string;
}

interface SignInProgress {
  phase: 'starting' | 'awaiting-code' | 'device-pending' | 'submitting' | 'failed';
  loginId?: string;
  url?: string;
  userCode?: string;
  outputExcerpt?: string;
  error?: string;
}

export function ProviderSetupButton({ provider, api = apiClient }: { provider: ProviderInfo; api?: ApiClient }) {
  const { locale, t } = useUiPreferences();
  const setProviders = useMatStore((state) => state.setProviders);
  const runtime = useMatStore((state) => state.runtimes.find((item) => item.family === provider.id));
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string>();
  const [logTail, setLogTail] = useState<string>();
  const [notice, setNotice] = useState<SetupNotice>();
  const [rechecking, setRechecking] = useState(false);
  const [actionStartedAt, setActionStartedAt] = useState<number>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [copied, setCopied] = useState<'install' | 'sign-in' | 'signin-url'>();
  const [signInProgress, setSignInProgress] = useState<SignInProgress>();
  const [signInCode, setSignInCode] = useState('');
  const [codexAccounts, setCodexAccounts] = useState<CodexAccountIndex>();
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccountIndexResponse>();
  const [apiKeyStatus, setApiKeyStatus] = useState<CodexApiKeyStatus>();
  const [accountBusy, setAccountBusy] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>();
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busy = installing || updating;
  const setupAvailable = provider.id !== 'mock' && (!provider.ok || Boolean(provider.authAlert) || provider.updatable === true || provider.id === 'codex' || provider.id === 'claude');
  const signInAvailable = provider.ok && provider.signIn !== undefined;

  useEffect(() => {
    setOpen(false); setInstalling(false); setUpdating(false); setError(undefined); setLogTail(undefined); setNotice(undefined); setRechecking(false); setCopied(undefined);
    setSignInProgress(undefined); setSignInCode(''); setCodexAccounts(undefined); setClaudeAccounts(undefined); setApiKeyStatus(undefined); setConfirmRemoveId(undefined);
  }, [provider.id]);
  useEffect(() => {
    if (setupAvailable || notice) return;
    setOpen(false); setInstalling(false); setUpdating(false); setError(undefined); setLogTail(undefined); setCopied(undefined);
  }, [notice, setupAvailable]);
  useEffect(() => {
    if (!busy || actionStartedAt === undefined) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - actionStartedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [actionStartedAt, busy]);
  useEffect(() => {
    if (!open) return;
    const returnTarget = triggerRef.current;
    const hostDialog = returnTarget?.closest<HTMLElement>('[role="dialog"]');
    closeRef.current?.focus();
    return () => {
      if (returnTarget?.isConnected) { returnTarget.focus(); return; }
      hostDialog?.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    };
  }, [open]);

  const refreshAccountData = async () => {
    if (provider.id === 'codex') {
      const [accounts, keyStatus] = await Promise.all([api.getCodexAccounts(), api.getCodexApiKey()]);
      setCodexAccounts(accounts);
      setApiKeyStatus(keyStatus);
    } else if (provider.id === 'claude') {
      setClaudeAccounts(await api.getClaudeAccounts());
    }
  };
  useEffect(() => {
    if (!open || (provider.id !== 'codex' && provider.id !== 'claude')) return;
    void refreshAccountData().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : t('provider.setupFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id]);

  const refreshAfterAction = async (fallback?: ProviderInfo): Promise<ProviderInfo | undefined> => {
    try {
      const nextProviders = await api.refreshProviders();
      setProviders(nextProviders);
      return nextProviders.find((candidate) => candidate.id === provider.id) ?? fallback;
    } catch {
      // The action response already carries the server's own post-action probe.
      return fallback;
    }
  };

  // Device sign-ins complete on the CLI's own polling; watch the session until
  // it settles instead of asking the user to do anything else.
  const signInLoginId = signInProgress?.phase === 'device-pending' ? signInProgress.loginId : undefined;
  useEffect(() => {
    if (!signInLoginId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const status = await api.signInStatus(provider.id, signInLoginId);
        if (stopped) return;
        if (status.phase === 'pending') {
          setSignInProgress((current) => current?.loginId === signInLoginId ? {
            ...current,
            ...(status.url ? { url: status.url } : {}),
            ...(status.userCode ? { userCode: status.userCode } : {}),
            ...(status.outputExcerpt ? { outputExcerpt: status.outputExcerpt } : {}),
          } : current);
          return;
        }
        stopped = true;
        window.clearInterval(timer);
        if (status.phase === 'succeeded') {
          setSignInProgress(undefined);
          setNotice({ tone: 'success', text: signInSuccessText(provider.id, status.statusDetail, locale, t) });
          await refreshAfterAction();
          await refreshAccountData();
        } else {
          setSignInProgress((current) => current?.loginId === signInLoginId ? {
            ...current, phase: 'failed',
            ...(status.error ? { error: status.error } : {}),
            ...(status.outputExcerpt ? { outputExcerpt: status.outputExcerpt } : {}),
          } : current);
        }
      } catch {
        // Keep polling; transient request failures must not kill the ceremony.
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 2000);
    void poll();
    return () => { stopped = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signInLoginId]);

  const install = async () => {
    setInstalling(true); setActionStartedAt(Date.now()); setElapsedSeconds(0); setError(undefined); setLogTail(undefined); setNotice(undefined);
    try {
      if ((provider.id === 'claude' || provider.id === 'codex') && runtime?.canInstallManaged) {
        await api.installRuntime(provider.id);
        setNotice({ tone: 'success', text: t('runtime.installAccepted', { provider: provider.id }) });
        return;
      }
      const result = await api.installProvider(provider.id);
      if (result.provider) setProviders(matStore.getState().providers.map((candidate) => candidate.id === provider.id ? result.provider! : candidate));
      const refreshed = await refreshAfterAction(result.provider);
      const detected = result.ok || result.provider?.ok === true || refreshed?.ok === true;
      if (result.ok || detected) {
        setNotice({ tone: 'success', text: t('provider.installedReady', { provider: provider.id }) });
      } else if (result.exitCode === 0) {
        setNotice({ tone: 'warning', text: t('provider.installNotDetected', { provider: provider.id }) });
      } else {
        setError(result.exitCode === null
          ? t('provider.installTimeout')
          : t('provider.installExit', { code: String(result.exitCode) }));
      }
      if (!result.ok && result.logTail) setLogTail(result.logTail);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('provider.setupFailed')); }
    finally { setInstalling(false); setActionStartedAt(undefined); }
  };
  const update = async () => {
    setUpdating(true); setActionStartedAt(Date.now()); setElapsedSeconds(0); setError(undefined); setLogTail(undefined); setNotice(undefined);
    try {
      const result = await api.updateProvider(provider.id);
      if (result.provider) setProviders(matStore.getState().providers.map((candidate) => candidate.id === provider.id ? result.provider! : candidate));
      const refreshed = await refreshAfterAction(result.provider);
      // Unlike install, the provider was already detected before this action,
      // so a healthy refresh proves nothing — only the updater's own result does.
      if (result.ok) {
        const version = refreshed?.version ?? result.provider?.version;
        setNotice({ tone: 'success', text: t('provider.updated', { provider: provider.id, version: version ? ` · ${version}` : '' }) });
      } else if (result.exitCode === 0) {
        setNotice({ tone: 'warning', text: t('provider.updateNotDetected', { provider: provider.id }) });
      } else {
        setError(result.exitCode === null
          ? t('provider.installTimeout')
          : t('provider.updateExit', { code: String(result.exitCode) }));
      }
      if (!result.ok && result.logTail) setLogTail(result.logTail);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('provider.updateFailed')); }
    finally { setUpdating(false); setActionStartedAt(undefined); }
  };
  const recheck = async () => {
    setRechecking(true); setError(undefined); setNotice(undefined);
    try {
      const detected = await refreshAfterAction();
      setNotice(detected?.ok
        ? { tone: 'success', text: t('provider.detectedReady', { provider: provider.id }) }
        : { tone: 'warning', text: t('provider.stillUnavailable', { provider: provider.id }) });
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('provider.detectionFailed')); }
    finally { setRechecking(false); }
  };
  const startSignIn = async () => {
    setError(undefined); setNotice(undefined); setSignInCode('');
    setSignInProgress({ phase: 'starting' });
    try {
      const started = await api.startSignIn(provider.id);
      if (!started.ok || !started.loginId || !started.url) {
        setSignInProgress({
          phase: 'failed',
          ...(started.loginId ? { loginId: started.loginId } : {}),
          ...(started.error ? { error: started.error } : {}),
          ...(started.outputExcerpt ? { outputExcerpt: started.outputExcerpt } : {}),
        });
        return;
      }
      setSignInProgress({
        phase: started.mode === 'paste-code' ? 'awaiting-code' : 'device-pending',
        loginId: started.loginId, url: started.url,
        ...(started.userCode ? { userCode: started.userCode } : {}),
        ...(started.outputExcerpt ? { outputExcerpt: started.outputExcerpt } : {}),
      });
    } catch (caught) {
      setSignInProgress({ phase: 'failed', error: caught instanceof Error ? caught.message : t('provider.setupFailed') });
    }
  };
  const submitCode = async () => {
    const loginId = signInProgress?.loginId;
    const code = signInCode.trim();
    if (!loginId || !code) return;
    setSignInProgress((current) => current ? { ...current, phase: 'submitting' } : current);
    try {
      const result = await api.submitSignInCode(provider.id, loginId, code);
      if (result.ok) {
        setSignInProgress(undefined);
        setSignInCode('');
        setNotice({ tone: 'success', text: signInSuccessText(provider.id, result.statusDetail, locale, t) });
        await refreshAfterAction();
        await refreshAccountData();
      } else {
        setSignInProgress((current) => current ? {
          ...current, phase: 'failed',
          ...(result.error ? { error: result.error } : {}),
          ...(result.outputExcerpt ? { outputExcerpt: result.outputExcerpt } : {}),
        } : current);
      }
    } catch (caught) {
      setSignInProgress((current) => current ? { ...current, phase: 'failed', error: caught instanceof Error ? caught.message : t('provider.setupFailed') } : current);
    }
  };
  const cancelSignInFlow = async () => {
    const loginId = signInProgress?.loginId;
    setSignInProgress(undefined);
    setSignInCode('');
    if (!loginId) return;
    try { await api.cancelSignIn(provider.id, loginId); }
    catch { /* The server times abandoned sessions out on its own. */ }
  };
  const mutateCodexAccount = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setAccountBusy(true); setError(undefined);
    try {
      const result = await action();
      if (!result.ok) setError(result.error ?? t('provider.setupFailed'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('provider.setupFailed'));
    } finally {
      try { await refreshAccountData(); } catch { /* Preserve the mutation result. */ }
      setAccountBusy(false);
    }
  };
  const saveApiKey = async () => {
    const input = apiKeyRef.current;
    const key = input?.value ?? '';
    if (!key) return;
    setAccountBusy(true); setError(undefined);
    try {
      setApiKeyStatus(await api.setCodexApiKey(key));
      if (input) input.value = '';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('provider.setupFailed'));
    } finally {
      setAccountBusy(false);
    }
  };
  const clearApiKey = async () => {
    setAccountBusy(true); setError(undefined);
    try { setApiKeyStatus(await api.clearCodexApiKey()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('provider.setupFailed')); }
    finally { setAccountBusy(false); }
  };
  const copy = async (value: string, kind: 'install' | 'sign-in' | 'signin-url') => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); setError(undefined); }
    catch { setError(t('provider.copyFailed')); }
  };
  const close = () => setOpen(false);
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  // Keep the mounted controls for the close cycle so the open effect can clean
  // up and restore focus before an external provider refresh removes them.
  if (!setupAvailable && !open) return null;
  return <span className="relative inline-flex">
    <button ref={triggerRef} type="button" onClick={() => setOpen((value) => !value)} onKeyDown={closeOnEscape} aria-label={t('provider.setupNamed', { provider: provider.id })} aria-haspopup="dialog" aria-controls={dialogId} aria-expanded={open} className="rounded border border-border px-2 py-1 text-[10px] text-accentForeground hover:border-accent">{t('provider.setup')}</button>
    {open && <div id={dialogId} role="dialog" aria-label={t('provider.setupNamed', { provider: provider.id })} onKeyDown={closeOnEscape} className="absolute right-0 top-full z-40 mt-2 w-72 rounded border border-accent bg-panel p-3 text-left shadow-2xl">
      <div className="flex items-center justify-between"><strong className="text-xs">{t('provider.setupNamed', { provider: provider.id })}</strong><button ref={closeRef} type="button" onClick={close} aria-label={t('provider.closeSetup', { provider: provider.id })} className="text-muted">×</button></div>
      {runtime && <p className="mt-2 text-[10px] text-muted">{t('runtime.summary', { state: t(runtime.state === 'managed' ? 'runtime.state.managed' : runtime.state === 'external' ? 'runtime.state.external' : runtime.state === 'broken' ? 'runtime.state.broken' : 'runtime.state.missing'), version: runtime.managedVersion ?? '—' })}</p>}
      <p className="mt-2 text-xs text-muted">{provider.version ?? (provider.detail ? displayProviderDetail(provider.id, provider.detail, locale) : t('provider.notDetected'))}</p>
      {provider.authAlert && <p className="mt-2 whitespace-pre-line break-words text-xs text-amber-200">{displayAuthAlertMessage(provider.authAlert.message, locale)}</p>}
      {provider.id === 'codex' && <div className="mt-3 rounded border border-border/80 bg-canvas/50 p-2">
        <strong className="text-[11px] text-muted">{t('accounts.codexTitle')}</strong>
        <div className="mt-2 space-y-2">
          {codexAccounts?.accounts.map((account) => {
            const active = account.id === codexAccounts.activeAccountId;
            return <div key={account.id} className="rounded border border-border/60 p-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-1">
                <span className="break-all text-ink">{account.label}{account.email && account.email !== account.label ? ` · ${account.email}` : ''}</span>
                {active && <span className="rounded bg-emerald-900/50 px-1 text-emerald-200">{t('accounts.active')}</span>}
                {account.needsLogin && <span title={account.lastAuthError} className="rounded bg-amber-900/50 px-1 text-amber-200">{t('accounts.needsLogin')}</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {!active && <button type="button" disabled={accountBusy || account.needsLogin} onClick={() => void mutateCodexAccount(() => api.switchCodexAccount(account.id))} className="rounded border border-border px-1.5 py-0.5 disabled:opacity-50">{t('accounts.switch')}</button>}
                {confirmRemoveId === account.id
                  ? <><button type="button" disabled={accountBusy} onClick={() => { setConfirmRemoveId(undefined); void mutateCodexAccount(() => api.removeCodexAccount(account.id)); }} className="rounded border border-red-700 px-1.5 py-0.5 text-red-200">{t('accounts.confirmRemove')}</button><button type="button" onClick={() => setConfirmRemoveId(undefined)} className="px-1.5 py-0.5 text-muted">{t('accounts.cancel')}</button></>
                  : <button type="button" disabled={accountBusy} onClick={() => setConfirmRemoveId(account.id)} className="rounded border border-border px-1.5 py-0.5">{t('accounts.remove')}</button>}
              </div>
            </div>;
          })}
        </div>
        <button type="button" disabled={accountBusy} onClick={() => void mutateCodexAccount(() => api.captureCodexAccount())} className="mt-2 rounded border border-accent px-2 py-1 text-xs text-accentForeground disabled:opacity-50">{t('accounts.capture')}</button>
        <div className="mt-3 border-t border-border/60 pt-2">
          <div className="flex items-center justify-between gap-2"><strong className="text-[11px] text-muted">{t('apiKey.title')}</strong><span className="text-[10px] text-muted">{apiKeyStatus?.configured ? t(apiKeyStatus.source === 'env' ? 'apiKey.configuredEnv' : 'apiKey.configuredFile') : t('apiKey.notConfigured')}</span></div>
          <div className="mt-1 flex gap-1">
            <input ref={apiKeyRef} type="password" aria-label={t('apiKey.input')} autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded border border-border bg-canvas px-2 py-1 text-xs text-ink" />
            <button type="button" disabled={accountBusy} onClick={() => void saveApiKey()} className="rounded border border-accent px-2 py-1 text-xs">{t('apiKey.save')}</button>
            <button type="button" disabled={accountBusy || !apiKeyStatus?.configured} onClick={() => void clearApiKey()} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50">{t('apiKey.clear')}</button>
          </div>
          {apiKeyStatus?.source === 'env' && <p className="mt-1 text-[10px] text-muted">{t('apiKey.envNote')}</p>}
        </div>
      </div>}
      {provider.id === 'claude' && claudeAccounts && claudeAccounts.accounts.length > 0 && <div className="mt-3 rounded border border-border/80 bg-canvas/50 p-2">
        <strong className="text-[11px] text-muted">{t('accounts.claudeTitle')}</strong>
        <div className="mt-1 space-y-1">{claudeAccounts.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-1 text-[11px]"><span className="break-all text-ink">{account.email}</span>{account.subscriptionType && <span className="text-muted">· {account.subscriptionType}</span>}{(account.id === claudeAccounts.activeAccountId || account.isDefault) && <span className="rounded bg-emerald-900/50 px-1 text-emerald-200">{account.id === claudeAccounts.activeAccountId ? t('accounts.active') : t('accounts.default')}</span>}</div>)}</div>
      </div>}
      {signInAvailable && <div className="mt-3 rounded border border-border/80 bg-canvas/50 p-2">
        <strong className="text-[11px] text-muted">{t('signin.title')}</strong>
        {!signInProgress && <>
          {provider.signIn?.replacesExistingLogin && <p className="mt-1 text-[10px] leading-relaxed text-amber-300">{t('signin.replacesWarning', { provider: provider.id })}</p>}
          <button type="button" aria-label={t('signin.startNamed', { provider: provider.id })} disabled={busy || rechecking} onClick={() => void startSignIn()} className="mt-2 rounded bg-accent px-2 py-1.5 text-xs font-medium text-onAccent disabled:opacity-50">{t('signin.start')}</button>
        </>}
        {signInProgress?.phase === 'starting' && <p role="status" aria-live="polite" className="mt-2 text-[11px] text-muted">{t('signin.starting')}</p>}
        {(signInProgress?.phase === 'awaiting-code' || signInProgress?.phase === 'device-pending' || signInProgress?.phase === 'submitting') && <>
          {signInProgress.url && <div className="mt-2">
            <p className="text-[11px] text-muted">{t('signin.openUrl')}</p>
            <code className="mt-1 block select-all break-all rounded bg-canvas p-2 text-[11px] text-ink">{signInProgress.url}</code>
            <button type="button" aria-label={t('signin.copyUrl')} onClick={() => void copy(signInProgress.url!, 'signin-url')} className="mt-1 rounded border border-border px-2 py-1 text-xs">{copied === 'signin-url' ? t('provider.copied') : t('signin.copyUrl')}</button>
          </div>}
          {signInProgress.userCode && <div className="mt-2">
            <p className="text-[11px] text-muted">{t('signin.userCode')}</p>
            <code className="mt-1 block select-all rounded bg-canvas p-2 text-center text-sm font-semibold tracking-widest text-ink">{signInProgress.userCode}</code>
          </div>}
          {signInProgress.phase === 'device-pending' && <p role="status" aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-muted">{t('signin.devicePending')}</p>}
          {signInProgress.phase === 'awaiting-code' && <div className="mt-2">
            <label className="block text-[11px] text-muted">{t('signin.codeLabel')}
              <input value={signInCode} onChange={(event) => setSignInCode(event.target.value)} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
            </label>
            <button type="button" disabled={!signInCode.trim()} onClick={() => void submitCode()} className="mt-2 rounded bg-accent px-2 py-1.5 text-xs font-medium text-onAccent disabled:opacity-50">{t('signin.submitCode')}</button>
          </div>}
          {signInProgress.phase === 'submitting' && <p role="status" aria-live="polite" className="mt-2 text-[11px] text-muted">{t('signin.submitting')}</p>}
          <button type="button" onClick={() => void cancelSignInFlow()} className="mt-2 block text-[11px] text-muted hover:text-ink">{t('signin.cancel')}</button>
        </>}
        {signInProgress?.phase === 'failed' && <>
          <p role="alert" className="mt-2 text-xs text-red-300">{signInProgress.error ? displaySignInMessage(signInProgress.error, locale) : t('provider.setupFailed')}</p>
          {signInProgress.outputExcerpt && <details className="mt-1"><summary className="cursor-pointer text-[10px] text-muted">{t('signin.output')}</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-[10px] text-muted">{signInProgress.outputExcerpt}</pre></details>}
          <button type="button" onClick={() => void startSignIn()} className="mt-2 rounded border border-accent px-2 py-1.5 text-xs text-accentForeground">{t('signin.retry')}</button>
        </>}
      </div>}
      {provider.signInCommand && <div className="mt-3"><strong className="text-[11px] text-muted">{t('provider.signIn')}</strong><code className="mt-1 block select-all break-words rounded bg-canvas p-2 text-[11px] text-ink">{provider.signInCommand}</code><button type="button" aria-label={t('provider.copySignIn', { provider: provider.id })} onClick={() => void copy(provider.signInCommand!, 'sign-in')} className="mt-2 rounded border border-border px-2 py-1 text-xs">{copied === 'sign-in' ? t('provider.copied') : t('provider.copy')}</button></div>}
      {!provider.ok && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" aria-label={t('provider.recheckNamed', { provider: provider.id })} disabled={busy || rechecking} onClick={() => void recheck()} className="rounded border border-accent px-2 py-1.5 text-xs text-accentForeground disabled:opacity-50">{rechecking ? t('provider.rechecking') : t('provider.retryDetection')}</button>
        {provider.installable && <button type="button" aria-label={t('provider.installNamed', { provider: provider.id })} disabled={busy || rechecking} onClick={() => void install()} className="rounded bg-accent px-2 py-1.5 text-xs font-medium text-onAccent disabled:opacity-50">{installing ? t('provider.installing', { elapsed: formatElapsed(elapsedSeconds) }) : t('provider.install')}</button>}
      </div>}
      {provider.ok && provider.updatable && <div className="mt-3">
        <button type="button" aria-label={t('provider.updateNamed', { provider: provider.id })} disabled={busy || rechecking || signInProgress !== undefined} onClick={() => void update()} className="rounded border border-accent px-2 py-1.5 text-xs text-accentForeground disabled:opacity-50">{updating ? t('provider.updating', { elapsed: formatElapsed(elapsedSeconds) }) : t('provider.update')}</button>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">{t('provider.updateHint')}</p>
      </div>}
      {installing && <p role="status" aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-muted">{t('provider.installWait')}</p>}
      {updating && <p role="status" aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-muted">{t('provider.updateWait')}</p>}
      {!provider.ok && !provider.installable && provider.manualCommand && <div className="mt-3"><code className="block select-all break-all rounded bg-canvas p-2 text-[11px] text-ink">{provider.manualCommand}</code><button type="button" aria-label={t('provider.copyInstall', { provider: provider.id })} onClick={() => void copy(provider.manualCommand!, 'install')} className="mt-2 rounded border border-border px-2 py-1 text-xs">{copied === 'install' ? t('provider.copied') : t('provider.copy')}</button></div>}
      {notice && <p role="status" aria-live="polite" className={`mt-2 rounded border p-2 text-xs leading-relaxed ${notice.tone === 'success' ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-amber-800 bg-amber-950/30 text-amber-200'}`}>{notice.text}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      {logTail && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-[10px] text-red-200">{logTail}</pre>}
    </div>}
  </span>;
}

function signInSuccessText(providerId: string, statusDetail: string | undefined, locale: 'en' | 'zh-TW', t: (key: 'signin.succeeded', values: Record<string, string | number>) => string): string {
  const base = t('signin.succeeded', { provider: providerId });
  if (!statusDetail) return base;
  const localized = displaySignInMessage(statusDetail, locale);
  return localized === base ? base : `${base} ${localized}`;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
