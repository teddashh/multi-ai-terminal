import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import { ReconnectingWsClient } from '../api/ws.js';
import { HealthDrawer, healthIssueCount } from '../panels/health/index.js';
import { InterfacePreferences, useUiPreferences } from '../i18n/UiPreferences.js';
import { AppShell } from './AppShell.js';
import { ACTIVE_RUN_STATUSES, matStore, useMatStore } from './store.js';

export function App() {
  const { t } = useUiPreferences();
  const [bootError, setBootError] = useState<string>();
  const [pendingAbortRunId, setPendingAbortRunId] = useState<string>();
  const [healthOpen, setHealthOpen] = useState(false);
  const activeRunId = useMatStore((state) => state.activeRunId);
  const selectedWorkspaceId = useMatStore((state) => state.selectedWorkspaceId);
  const activeRun = useMatStore((state) => state.activeRunId ? state.runs[state.activeRunId] : undefined);
  const selectedWorkspace = useMatStore((state) => state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId));
  const wsConnection = useMatStore((state) => state.wsConnection);
  const providers = useMatStore((state) => state.providers);
  const viewedRun = useMatStore((state) => state.viewedRunId ? state.runs[state.viewedRunId] : undefined);
  const viewedIntegrity = useMatStore((state) => state.viewedRunId ? state.evidenceIntegrity[state.viewedRunId] : undefined);
  const ws = useRef<ReconnectingWsClient>();

  useEffect(() => {
    let live = true;
    void Promise.all([apiClient.getWorkspaces(), apiClient.getWorkflows(), apiClient.getProviders()]).then(([workspaces, workflows, providers]) => {
      if (!live) return;
      const state = matStore.getState();
      state.setWorkspaces(workspaces); state.setWorkflows(workflows); state.setProviders(providers);
      if (!state.selectedWorkspaceId && workspaces[0]) state.setSelectedWorkspaceId(workspaces[0].id);
    }).catch((error: unknown) => { if (live) setBootError(error instanceof Error ? error.message : 'Could not load application data.'); });
    ws.current = new ReconnectingWsClient({
      onMessage: (message) => matStore.getState().applyWsMsg(message),
      onStateChange: (state) => matStore.getState().setWsConnection(state),
      onCatchUpState: (update) => matStore.getState().setEvidenceCatchUpState(
        update.runId,
        update.status,
        update.status === 'started' ? update.afterSeq : undefined,
      ),
    });
    ws.current.connect();
    return () => { live = false; ws.current?.close(); };
  }, []);

  useEffect(() => {
    let live = true;
    const state = matStore.getState();
    if (!selectedWorkspaceId) {
      setBootError(undefined);
      state.setActiveRunId(undefined);
      state.setViewedRunId(undefined);
      state.setRunsLoading(false);
      return () => { live = false; };
    }
    setBootError(undefined);
    state.setRunsLoading(true);
    state.setActiveRunId(undefined);
    apiClient.getRuns({ workspaceId: selectedWorkspaceId, limit: 100 }).then((runs) => {
      if (!live) return;
      const current = matStore.getState();
      for (const run of runs) current.upsertRun(run);
      const active = runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
      const viewed = active ?? runs[0];
      current.setActiveRunId(active?.runId);
      current.setViewedRunId(viewed?.runId);
      current.setRunsLoading(false);
      setBootError(undefined);
    }).catch((error: unknown) => {
      if (!live) return;
      matStore.getState().setActiveRunId(undefined);
      matStore.getState().setViewedRunId(undefined);
      matStore.getState().setRunsLoading(false);
      setBootError(error instanceof Error ? error.message : 'Could not load workspace runs.');
    });
    return () => { live = false; };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!activeRunId) return;
    ws.current?.subscribe(activeRunId);
    return () => ws.current?.unsubscribe(activeRunId);
  }, [activeRunId]);

  const abort = async () => {
    if (!activeRun || !ACTIVE_RUN_STATUSES.has(activeRun.status)) return;
    const runId = activeRun.runId;
    setPendingAbortRunId(runId); setBootError(undefined);
    try { matStore.getState().upsertRun(await apiClient.abortRun(runId)); }
    catch (error) {
      if (matStore.getState().activeRunId === runId) setBootError(error instanceof Error ? error.message : t('app.abortFailed'));
    } finally { setPendingAbortRunId((current) => current === runId ? undefined : current); }
  };

  const healthIssues = healthIssueCount({
    server: { status: 'checking' }, wsConnection, providers,
    ...(selectedWorkspace ? { workspace: selectedWorkspace } : {}),
    ...(viewedRun ? { run: viewedRun } : {}),
    ...(viewedIntegrity ? { evidenceIntegrity: viewedIntegrity } : {}),
  });

  return <main className="flex h-screen min-w-[954px] flex-col overflow-hidden bg-canvas text-ink">
    <header className="flex min-w-0 items-center gap-3 border-b border-border bg-canvas px-4 py-2">
      <h1 className="shrink-0 text-sm font-semibold tracking-wide">Multi-AI Terminal</h1>
      <span className="truncate text-xs text-muted">{selectedWorkspace?.name ?? t('app.noWorkspace')}</span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] ${wsConnection === 'open' ? 'border-emerald-900 text-emerald-300' : wsConnection === 'connecting' ? 'border-amber-900 text-amber-300' : 'border-border text-muted'}`}><span className={`h-1.5 w-1.5 rounded-full ${wsConnection === 'open' ? 'bg-emerald-400' : wsConnection === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-muted'}`} />{wsConnection === 'open' ? t('app.connected') : wsConnection === 'connecting' ? t('app.connecting') : t('app.offline')}</span>
        {activeRun && <span className={`rounded-full border px-2 py-1 text-[11px] ${ACTIVE_RUN_STATUSES.has(activeRun.status) ? 'border-sky-800 bg-sky-950/40 text-sky-300' : 'border-border text-muted'}`}><span className={ACTIVE_RUN_STATUSES.has(activeRun.status) ? 'mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400' : ''} />{activeRun.status}</span>}
        {activeRun && ACTIVE_RUN_STATUSES.has(activeRun.status) && <button type="button" disabled={pendingAbortRunId === activeRun.runId} onClick={() => void abort()} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50">{pendingAbortRunId === activeRun.runId ? t('app.aborting') : t('app.abort')}</button>}
        <InterfacePreferences />
        <button type="button" aria-label={t('app.health')} onClick={() => setHealthOpen(true)} className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${healthIssues > 0 ? 'border-amber-800 bg-amber-950/20 text-amber-200' : 'border-border text-muted hover:text-ink'}`}>{t('app.health')}{healthIssues > 0 && <span title={t('app.healthIssues', { count: healthIssues })} className="grid min-w-4 place-items-center rounded-full bg-amber-700/70 px-1 text-[9px] text-white">{healthIssues}</span>}</button>
      </div>
    </header>
    {bootError && <div role="alert" className="fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">{bootError}</div>}
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden"><AppShell /></div>
    <HealthDrawer open={healthOpen} onClose={() => setHealthOpen(false)} />
  </main>;
}
