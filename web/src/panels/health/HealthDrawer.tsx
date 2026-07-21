import type { ProviderInfo } from '@mat/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, type ApiClient } from '../../api/client.js';
import { matStore, useMatStore } from '../../app/store.js';
import { ProviderSetupButton, SideDrawer } from '../../components/index.js';
import { findingsByScope, healthFindings, healthIssueCount, type HealthFinding, type HealthInput, type HealthScope, type ServerHealthState } from './healthLogic.js';

export interface HealthDrawerProps {
  open: boolean;
  onClose(): void;
  onInspectNode?(nodeRunId: string): void;
  api?: ApiClient;
}

interface AsyncText {
  loading: boolean;
  content?: string;
  error?: string;
}

const SECTION_LABELS: Readonly<Record<HealthScope, string>> = {
  system: 'System', workspace: 'Workspace', provider: 'Providers', run: 'Viewed run',
};

export function HealthDrawer({ open, onClose, onInspectNode, api = apiClient }: HealthDrawerProps) {
  const providers = useMatStore((state) => state.providers);
  const workspaces = useMatStore((state) => state.workspaces);
  const selectedWorkspaceId = useMatStore((state) => state.selectedWorkspaceId);
  const viewedRunId = useMatStore((state) => state.viewedRunId);
  const run = useMatStore((state) => viewedRunId ? state.runs[viewedRunId] : undefined);
  const wsConnection = useMatStore((state) => state.wsConnection);
  const integrity = useMatStore((state) => viewedRunId ? state.evidenceIntegrity[viewedRunId] : undefined);
  const setProviders = useMatStore((state) => state.setProviders);
  const focusNode = useMatStore((state) => state.focusNode);
  const setNodeFilter = useMatStore((state) => state.setNodeFilter);
  const workspace = useMemo(() => workspaces.find((candidate) => candidate.id === selectedWorkspaceId), [selectedWorkspaceId, workspaces]);
  const [server, setServer] = useState<ServerHealthState>({ status: 'checking' });
  const [providerRefreshError, setProviderRefreshError] = useState<string>();
  const [serverLog, setServerLog] = useState<AsyncText>();
  const [debugging, setDebugging] = useState(false);
  const [debugError, setDebugError] = useState<string>();
  const serverLogGeneration = useRef(0);

  useEffect(() => {
    serverLogGeneration.current += 1;
    if (!open) return;
    let live = true;
    setServer({ status: 'checking' });
    setProviderRefreshError(undefined);
    setServerLog(undefined);
    setDebugError(undefined);
    void api.health().then((result) => {
      if (!live) return;
      setServer(result.ok
        ? { status: 'ok', version: result.version }
        : { status: 'error', message: 'The local server returned an unhealthy response.' });
    }).catch((error: unknown) => {
      if (live) setServer({ status: 'error', message: errorMessage(error) });
    });
    void api.getProviders().then((nextProviders) => {
      if (live) setProviders(nextProviders);
    }).catch((error: unknown) => {
      if (live) setProviderRefreshError(errorMessage(error));
    });
    return () => { live = false; serverLogGeneration.current += 1; };
  }, [api, open, setProviders]);

  useEffect(() => {
    setDebugging(false);
    setDebugError(undefined);
  }, [viewedRunId]);

  const input = useMemo<HealthInput>(() => ({
    server, wsConnection, providers,
    ...(workspace ? { workspace } : {}),
    ...(run ? { run } : {}),
    ...(integrity ? { evidenceIntegrity: integrity } : {}),
    ...(providerRefreshError ? { providerRefreshError } : {}),
  }), [integrity, providerRefreshError, providers, run, server, workspace, wsConnection]);
  const findings = useMemo(() => healthFindings(input), [input]);
  const issueCount = useMemo(() => healthIssueCount(input), [input]);
  const providersById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const closeDrawer = () => {
    serverLogGeneration.current += 1;
    onClose();
  };
  const inspectNode = (nodeRunId: string) => {
    setNodeFilter([nodeRunId]);
    focusNode(nodeRunId);
    onInspectNode?.(nodeRunId);
    closeDrawer();
  };
  const loadServerLog = async () => {
    const generation = ++serverLogGeneration.current;
    setServerLog({ loading: true });
    try {
      const content = await api.getServerLog();
      if (serverLogGeneration.current === generation) setServerLog({ loading: false, content });
    } catch (error) {
      if (serverLogGeneration.current === generation) setServerLog({ loading: false, error: errorMessage(error) });
    }
  };
  const downloadDebugBundle = async () => {
    if (!run) return;
    const runId = run.runId;
    setDebugging(true); setDebugError(undefined);
    try {
      const blob = await api.getDebugBundle(runId);
      if (matStore.getState().viewedRunId !== runId) return;
      downloadBlob(blob, `mat-debug-${runId}.zip`);
    } catch (error) {
      if (matStore.getState().viewedRunId === runId) setDebugError(errorMessage(error));
    } finally {
      if (matStore.getState().viewedRunId === runId) setDebugging(false);
    }
  };

  return <SideDrawer open={open} title="Health & diagnostics" onClose={closeDrawer} widthClassName="max-w-2xl">
    <div className={`mb-4 rounded border p-3 ${issueCount > 0 ? 'border-amber-800 bg-amber-950/20' : 'border-emerald-800 bg-emerald-950/20'}`} role="status">
      <p className={`text-sm font-medium ${issueCount > 0 ? 'text-amber-200' : 'text-emerald-200'}`}>{issueCount > 0 ? `${String(issueCount)} item${issueCount === 1 ? '' : 's'} need attention` : 'No known health issues'}</p>
      <p className="mt-1 text-xs text-muted">Checks are observational. Provider version checks may be cached for up to 10 minutes and do not verify login state.</p>
    </div>

    {(['system', 'workspace', 'provider', 'run'] as const).map((scope) => <HealthSection
      key={scope}
      title={SECTION_LABELS[scope]}
      findings={findingsByScope(findings, scope)}
      providersById={providersById}
      api={api}
      onInspectNode={inspectNode}
    />)}

    <section className="mt-5 border-t border-border pt-4" aria-labelledby="health-diagnostics-heading">
      <h3 id="health-diagnostics-heading" className="text-xs font-semibold uppercase tracking-wider text-muted">Safe diagnostics</h3>
      <p className="mt-1 text-xs text-zinc-400">These actions only inspect or export redacted evidence. They do not retry, kill, apply, or otherwise change a run.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!run || debugging} onClick={() => void downloadDebugBundle()} className="rounded border border-violet-800 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-950/40 disabled:cursor-not-allowed disabled:opacity-40">
          {debugging ? 'Preparing debug bundle…' : 'Download debug bundle'}
        </button>
        <button type="button" disabled={serverLog?.loading} onClick={() => void loadServerLog()} className="rounded border border-border px-3 py-1.5 text-xs text-zinc-200 hover:border-sky-700 disabled:opacity-40">
          {serverLog?.loading ? 'Loading server log…' : serverLog?.content !== undefined ? 'Reload server log' : 'Load server log'}
        </button>
      </div>
      {debugError && <p role="alert" className="mt-2 text-xs text-red-300">{debugError}</p>}
      {serverLog?.error && <p role="alert" className="mt-2 text-xs text-red-300">{serverLog.error}</p>}
      {serverLog?.content !== undefined && <div className="mt-3">
        <p className="mb-1 text-[11px] text-muted">Server diagnostic tail · environment-derived values are redacted at the server boundary</p>
        <pre data-testid="server-log" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-zinc-950 p-3 text-[10px] text-zinc-300">{serverLog.content || '(Server diagnostic log is empty.)'}</pre>
      </div>}
    </section>
  </SideDrawer>;
}

function HealthSection({ title, findings, providersById, api, onInspectNode }: {
  title: string;
  findings: readonly HealthFinding[];
  providersById: ReadonlyMap<ProviderInfo['id'], ProviderInfo>;
  api: ApiClient;
  onInspectNode(nodeRunId: string): void;
}) {
  return <section className="mb-5" aria-label={`${title} health`}>
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
    <div className="space-y-2">{findings.map((finding) => {
      const provider = finding.providerId ? providersById.get(finding.providerId) : undefined;
      return <article key={finding.id} className="flex items-start gap-2 rounded border border-border bg-zinc-950/45 p-2.5">
        <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[finding.severity]}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-xs font-medium ${SEVERITY_TEXT[finding.severity]}`}>{finding.title}</p>
          <p className="mt-0.5 whitespace-pre-line break-words text-[11px] leading-relaxed text-zinc-400">{finding.detail}</p>
        </div>
        {provider && provider.id !== 'mock' && <ProviderSetupButton provider={provider} api={api} />}
        {finding.nodeRunId && <button type="button" onClick={() => onInspectNode(finding.nodeRunId!)} aria-label={`Inspect ${finding.title}`} className="shrink-0 rounded border border-sky-800 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-950/40">Inspect</button>}
      </article>;
    })}</div>
  </section>;
}

const SEVERITY_DOT: Readonly<Record<HealthFinding['severity'], string>> = {
  ok: 'bg-emerald-400', info: 'bg-zinc-500', working: 'animate-pulse bg-sky-400', warning: 'bg-amber-400', error: 'bg-red-400',
};
const SEVERITY_TEXT: Readonly<Record<HealthFinding['severity'], string>> = {
  ok: 'text-emerald-200', info: 'text-zinc-200', working: 'text-sky-200', warning: 'text-amber-200', error: 'text-red-200',
};

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The read-only diagnostic request failed.';
}
