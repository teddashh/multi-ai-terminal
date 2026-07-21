import type { ProviderInfo } from '@mat/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { apiClient, type ApiClient } from '../api/client.js';
import { useMatStore } from '../app/store.js';

export function ProviderSetupButton({ provider, api = apiClient }: { provider: ProviderInfo; api?: ApiClient }) {
  const setProviders = useMatStore((state) => state.setProviders);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const [logTail, setLogTail] = useState<string>();
  const [copied, setCopied] = useState<'install' | 'sign-in'>();
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const setupAvailable = provider.id !== 'mock' && (!provider.ok || Boolean(provider.authAlert));

  useEffect(() => {
    setOpen(false); setInstalling(false); setError(undefined); setLogTail(undefined); setCopied(undefined);
  }, [provider.id]);
  useEffect(() => {
    if (setupAvailable) return;
    setOpen(false); setInstalling(false); setError(undefined); setLogTail(undefined); setCopied(undefined);
  }, [setupAvailable]);
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
    setInstalling(true); setError(undefined); setLogTail(undefined);
    try {
      const result = await api.installProvider(provider.id);
      if (!result.ok && result.logTail) setLogTail(result.logTail);
      setProviders(await api.getProviders());
      if (result.ok) setOpen(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Provider setup failed.'); }
    finally { setInstalling(false); }
  };
  const copy = async (value: string, kind: 'install' | 'sign-in') => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); setError(undefined); }
    catch { setError('Could not copy the command.'); }
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
    <button ref={triggerRef} type="button" onClick={() => setOpen((value) => !value)} onKeyDown={closeOnEscape} aria-label={`Setup ${provider.id}`} aria-haspopup="dialog" aria-controls={dialogId} aria-expanded={open} className="rounded border border-border px-2 py-1 text-[10px] text-violet-200 hover:border-accent">Setup</button>
    {open && <div id={dialogId} role="dialog" aria-label={`Setup ${provider.id}`} onKeyDown={closeOnEscape} className="absolute right-0 top-full z-40 mt-2 w-72 rounded border border-accent bg-panel p-3 text-left shadow-2xl">
      <div className="flex items-center justify-between"><strong className="text-xs">Setup {provider.id}</strong><button ref={closeRef} type="button" onClick={close} aria-label={`Close ${provider.id} setup`} className="text-muted">×</button></div>
      <p className="mt-2 text-xs text-muted">{provider.version ?? provider.detail ?? 'Provider not detected.'}</p>
      {provider.authAlert && <p className="mt-2 whitespace-pre-line break-words text-xs text-amber-200">{provider.authAlert.message}</p>}
      {provider.signInCommand && <div className="mt-3"><strong className="text-[11px] text-muted">Sign in</strong><code className="mt-1 block select-all break-words rounded bg-zinc-950 p-2 text-[11px] text-ink">{provider.signInCommand}</code><button type="button" aria-label={`Copy ${provider.id} sign-in command`} onClick={() => void copy(provider.signInCommand!, 'sign-in')} className="mt-2 rounded border border-border px-2 py-1 text-xs">{copied === 'sign-in' ? 'Copied' : 'Copy'}</button></div>}
      {!provider.ok && provider.installable && <button type="button" aria-label={`Install ${provider.id}`} disabled={installing} onClick={() => void install()} className="mt-3 rounded bg-accent px-2 py-1.5 text-xs font-medium text-zinc-950 disabled:opacity-50">{installing ? 'Installing…' : 'Install'}</button>}
      {!provider.ok && !provider.installable && provider.manualCommand && <div className="mt-3"><code className="block select-all break-all rounded bg-zinc-950 p-2 text-[11px] text-ink">{provider.manualCommand}</code><button type="button" aria-label={`Copy ${provider.id} install command`} onClick={() => void copy(provider.manualCommand!, 'install')} className="mt-2 rounded border border-border px-2 py-1 text-xs">{copied === 'install' ? 'Copied' : 'Copy'}</button></div>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      {logTail && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[10px] text-red-200">{logTail}</pre>}
    </div>}
  </span>;
}
