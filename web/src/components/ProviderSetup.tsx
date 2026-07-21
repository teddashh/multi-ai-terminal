import type { ProviderInfo } from '@mat/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { apiClient, type ApiClient } from '../api/client.js';
import { matStore, useMatStore } from '../app/store.js';
import { useUiPreferences } from '../i18n/UiPreferences.js';

interface SetupNotice {
  tone: 'success' | 'warning';
  text: string;
}

export function ProviderSetupButton({ provider, api = apiClient }: { provider: ProviderInfo; api?: ApiClient }) {
  const { t } = useUiPreferences();
  const setProviders = useMatStore((state) => state.setProviders);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const [logTail, setLogTail] = useState<string>();
  const [notice, setNotice] = useState<SetupNotice>();
  const [rechecking, setRechecking] = useState(false);
  const [installStartedAt, setInstallStartedAt] = useState<number>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [copied, setCopied] = useState<'install' | 'sign-in'>();
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const setupAvailable = provider.id !== 'mock' && (!provider.ok || Boolean(provider.authAlert));

  useEffect(() => {
    setOpen(false); setInstalling(false); setError(undefined); setLogTail(undefined); setNotice(undefined); setRechecking(false); setCopied(undefined);
  }, [provider.id]);
  useEffect(() => {
    if (setupAvailable || notice) return;
    setOpen(false); setInstalling(false); setError(undefined); setLogTail(undefined); setCopied(undefined);
  }, [notice, setupAvailable]);
  useEffect(() => {
    if (!installing || installStartedAt === undefined) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - installStartedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [installStartedAt, installing]);
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

  const install = async () => {
    setInstalling(true); setInstallStartedAt(Date.now()); setElapsedSeconds(0); setError(undefined); setLogTail(undefined); setNotice(undefined);
    try {
      const result = await api.installProvider(provider.id);
      if (result.provider) setProviders(matStore.getState().providers.map((candidate) => candidate.id === provider.id ? result.provider! : candidate));
      let detected = result.ok || result.provider?.ok === true;
      try {
        const nextProviders = await api.refreshProviders();
        setProviders(nextProviders);
        detected = detected || nextProviders.find((candidate) => candidate.id === provider.id)?.ok === true;
      } catch {
        // The install response already contains the server's post-install probe.
        // Preserve that successful outcome even if the extra UI refresh failed.
      }
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
    finally { setInstalling(false); setInstallStartedAt(undefined); }
  };
  const recheck = async () => {
    setRechecking(true); setError(undefined); setNotice(undefined);
    try {
      const nextProviders = await api.refreshProviders();
      setProviders(nextProviders);
      const detected = nextProviders.find((candidate) => candidate.id === provider.id);
      setNotice(detected?.ok
        ? { tone: 'success', text: t('provider.detectedReady', { provider: provider.id }) }
        : { tone: 'warning', text: t('provider.stillUnavailable', { provider: provider.id }) });
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('provider.detectionFailed')); }
    finally { setRechecking(false); }
  };
  const copy = async (value: string, kind: 'install' | 'sign-in') => {
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
      <p className="mt-2 text-xs text-muted">{provider.version ?? provider.detail ?? t('provider.notDetected')}</p>
      {provider.authAlert && <p className="mt-2 whitespace-pre-line break-words text-xs text-amber-200">{provider.authAlert.message}</p>}
      {provider.signInCommand && <div className="mt-3"><strong className="text-[11px] text-muted">{t('provider.signIn')}</strong><code className="mt-1 block select-all break-words rounded bg-canvas p-2 text-[11px] text-ink">{provider.signInCommand}</code><button type="button" aria-label={t('provider.copySignIn', { provider: provider.id })} onClick={() => void copy(provider.signInCommand!, 'sign-in')} className="mt-2 rounded border border-border px-2 py-1 text-xs">{copied === 'sign-in' ? t('provider.copied') : t('provider.copy')}</button></div>}
      {!provider.ok && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" aria-label={t('provider.recheckNamed', { provider: provider.id })} disabled={installing || rechecking} onClick={() => void recheck()} className="rounded border border-accent px-2 py-1.5 text-xs text-accentForeground disabled:opacity-50">{rechecking ? t('provider.rechecking') : t('provider.retryDetection')}</button>
        {provider.installable && <button type="button" aria-label={t('provider.installNamed', { provider: provider.id })} disabled={installing || rechecking} onClick={() => void install()} className="rounded bg-accent px-2 py-1.5 text-xs font-medium text-onAccent disabled:opacity-50">{installing ? t('provider.installing', { elapsed: formatElapsed(elapsedSeconds) }) : t('provider.install')}</button>}
      </div>}
      {installing && <p role="status" aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-muted">{t('provider.installWait')}</p>}
      {!provider.ok && !provider.installable && provider.manualCommand && <div className="mt-3"><code className="block select-all break-all rounded bg-canvas p-2 text-[11px] text-ink">{provider.manualCommand}</code><button type="button" aria-label={t('provider.copyInstall', { provider: provider.id })} onClick={() => void copy(provider.manualCommand!, 'install')} className="mt-2 rounded border border-border px-2 py-1 text-xs">{copied === 'install' ? t('provider.copied') : t('provider.copy')}</button></div>}
      {notice && <p role="status" aria-live="polite" className={`mt-2 rounded border p-2 text-xs leading-relaxed ${notice.tone === 'success' ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-amber-800 bg-amber-950/30 text-amber-200'}`}>{notice.text}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      {logTail && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-[10px] text-red-200">{logTail}</pre>}
    </div>}
  </span>;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
