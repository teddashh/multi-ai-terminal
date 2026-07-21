import type { RunSnapshot } from '@mat/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import { displayNodeLabel } from '../components/nodeLabel.js';
import { NarrativePanel } from '../panels/narrative/NarrativePanel.js';
import { loadReplayPages, StreamPanel } from '../panels/stream/StreamPanel.js';
import { useUiPreferences } from '../i18n/UiPreferences.js';
import { ACTIVE_RUN_STATUSES, matStore, useMatStore } from './store.js';

type EvidenceView = 'conversation' | 'timeline';

/** Owns run selection and replay loading so every evidence view observes the same run. */
export function RunWorkspace() {
  const { locale, t } = useUiPreferences();
  const selectedWorkspaceId = useMatStore((state) => state.selectedWorkspaceId);
  const activeRunId = useMatStore((state) => state.activeRunId);
  const viewedRunId = useMatStore((state) => state.viewedRunId);
  const runsLoading = useMatStore((state) => state.runsLoading);
  const runs = useMatStore((state) => state.runs);
  const nodeFilter = useMatStore((state) => state.filters.nodeRunIds);
  const setViewedRunId = useMatStore((state) => state.setViewedRunId);
  const setNodeFilter = useMatStore((state) => state.setNodeFilter);
  const setFollow = useMatStore((state) => state.setFollow);
  const focusNode = useMatStore((state) => state.focusNode);
  const upsertRun = useMatStore((state) => state.upsertRun);
  const setEvents = useMatStore((state) => state.setEvents);
  const loadOlderEvents = useMatStore((state) => state.loadOlderEvents);
  const [view, setView] = useState<EvidenceView>('conversation');
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const replayGeneration = useRef(0);
  const historyGeneration = useRef(0);

  const selectedRun = viewedRunId ? runs[viewedRunId] : undefined;
  const liveSessionRunId = useRef<string>();
  if (viewedRunId && viewedRunId === activeRunId) liveSessionRunId.current = viewedRunId;
  else if (liveSessionRunId.current !== viewedRunId) liveSessionRunId.current = undefined;
  const viewingLiveSession = viewedRunId !== undefined && (viewedRunId === activeRunId || liveSessionRunId.current === viewedRunId);
  const availableRuns = useMemo(() => Object.values(runs)
    .filter((run) => run.workspaceId === selectedWorkspaceId)
    .sort((left, right) => right.createdAt - left.createdAt), [runs, selectedWorkspaceId]);

  useEffect(() => {
    setReplayError(undefined);
    setHistoryError(undefined);
    setView('conversation');
    historyGeneration.current += 1;
    setHistoryHasMore(false);
    setHistoryLoading(false);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const generation = replayGeneration.current + 1;
    replayGeneration.current = generation;
    if (!viewedRunId || viewingLiveSession) {
      setReplayLoading(false);
      setReplayError(undefined);
      return;
    }
    setReplayLoading(true);
    setReplayError(undefined);
    setFollow(false);
    void (async () => {
      try {
        if (!matStore.getState().runs[viewedRunId]) {
          const run = await apiClient.getRun(viewedRunId);
          if (replayGeneration.current !== generation) return;
          upsertRun(run);
        }
        await loadReplayPages(viewedRunId, loadOlderEvents, setEvents, {
          isCurrent: () => replayGeneration.current === generation,
        });
      } catch (error) {
        if (replayGeneration.current === generation) setReplayError(errorMessage(error));
      } finally {
        if (replayGeneration.current === generation) setReplayLoading(false);
      }
    })();
    return () => {
      if (replayGeneration.current === generation) replayGeneration.current += 1;
    };
  }, [loadOlderEvents, setEvents, setFollow, upsertRun, viewedRunId, viewingLiveSession]);

  const selectRun = (runId: string) => {
    setViewedRunId(runId || undefined);
    setNodeFilter([]);
    focusNode(undefined);
    setFollow(runId === activeRunId);
    setReplayError(undefined);
  };

  const loadMoreRuns = async () => {
    if (!selectedWorkspaceId || historyLoading) return;
    const generation = historyGeneration.current + 1;
    historyGeneration.current = generation;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const before = availableRuns.at(-1)?.createdAt;
      const page = await apiClient.getRuns({ workspaceId: selectedWorkspaceId, limit: 50, ...(before !== undefined ? { before } : {}) });
      if (historyGeneration.current !== generation) return;
      for (const run of page) upsertRun(run);
      setHistoryHasMore(page.length === 50);
    } catch (error) {
      if (historyGeneration.current === generation) setHistoryError(errorMessage(error));
    } finally {
      if (historyGeneration.current === generation) setHistoryLoading(false);
    }
  };

  const runningNodes = selectedRun?.nodes.filter((node) => node.status === 'running' || node.status === 'stalled') ?? [];
  const attentionNodes = selectedRun?.nodes.filter(nodeNeedsAttention) ?? [];
  const applyNodePreset = (preset: 'all' | 'running' | 'attention') => {
    const ids = preset === 'all' ? [] : (preset === 'running' ? runningNodes : attentionNodes).map((node) => node.nodeRunId);
    setNodeFilter(ids);
    focusNode(undefined);
  };

  return <section aria-label={t('runWorkspace.label')} className="flex h-full min-h-0 min-w-0 flex-col bg-canvas/30" data-testid="run-workspace">
    <header className="shrink-0 border-b border-border bg-panel px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor="run-workspace-run-selector" className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted">{t('runWorkspace.run')}</label>
        <select id="run-workspace-run-selector" value={viewedRunId ?? ''} onChange={(event) => selectRun(event.target.value)} className="min-w-0 max-w-md flex-1 rounded border border-border bg-canvas px-2 py-1.5 text-xs text-ink">
          {!viewedRunId && <option value="">{t('runWorkspace.noRuns')}</option>}
          {availableRuns.map((run) => <option key={run.runId} value={run.runId}>{formatRunOption(run, run.runId === activeRunId ? t('runWorkspace.live') : '', locale)}</option>)}
        </select>
        {selectedRun && <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] ${viewingLiveSession ? 'border-sky-700 bg-sky-950/30 text-sky-200' : 'border-border text-muted'}`}>{selectedRun.runId === activeRunId ? t('runWorkspace.live') : viewingLiveSession ? t('runWorkspace.completed') : t('runWorkspace.replay')} · {selectedRun.status}</span>}
        <button type="button" disabled={!selectedWorkspaceId || historyLoading} onClick={() => void loadMoreRuns()} className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-muted hover:text-ink disabled:opacity-40">{historyLoading ? t('runWorkspace.loading') : historyHasMore ? t('runWorkspace.moreRuns') : t('runWorkspace.olderRuns')}</button>
      </div>
      {selectedRun && <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5" aria-label={t('runWorkspace.nodeFocus')}>
        <NodePreset label={t('runWorkspace.all')} active={nodeFilter.length === 0} count={selectedRun.nodes.length} onClick={() => applyNodePreset('all')} />
        <NodePreset label={t('runWorkspace.running')} active={sameMembers(nodeFilter, runningNodes.map((node) => node.nodeRunId))} count={runningNodes.length} disabled={runningNodes.length === 0} onClick={() => applyNodePreset('running')} />
        <NodePreset label={t('runWorkspace.attention')} active={sameMembers(nodeFilter, attentionNodes.map((node) => node.nodeRunId))} count={attentionNodes.length} disabled={attentionNodes.length === 0} onClick={() => applyNodePreset('attention')} tone="attention" />
        <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
        {selectedRun.nodes.map((node) => {
          const label = displayNodeLabel(node, selectedRun.nodes);
          return <button type="button" key={node.nodeRunId} aria-pressed={nodeFilter.includes(node.nodeRunId)} onClick={() => { setNodeFilter([node.nodeRunId]); focusNode(node.nodeRunId); }} className={`max-w-40 shrink-0 truncate rounded-full border px-2 py-1 text-[10px] ${nodeFilter.includes(node.nodeRunId) ? 'border-accentBorder bg-accentSoft/70 text-accentForeground' : nodeNeedsAttention(node) ? 'border-red-900 text-red-300' : 'border-border text-muted hover:text-ink'}`} title={`${label} · ${node.status}`}>{label} · {node.status}</button>;
        })}
      </div>}
      {replayLoading && <p role="status" className="mt-2 text-[11px] text-sky-300">{t('runWorkspace.loadingReplay')}</p>}
      {replayError && <p role="alert" className="mt-2 text-[11px] text-red-300">{t('runWorkspace.replayFailed', { error: replayError })}</p>}
      {historyError && <p role="alert" className="mt-2 text-[11px] text-red-300">{t('runWorkspace.historyFailed', { error: historyError })}</p>}
      <div className="mt-2 flex items-center gap-1" role="tablist" aria-label={t('runWorkspace.evidenceView')} onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = view === 'conversation' ? 'timeline' : 'conversation';
        setView(next);
        requestAnimationFrame(() => document.getElementById(`${next}-tab`)?.focus());
      }}>
        <ViewTab id="conversation-tab" controls="conversation-panel" selected={view === 'conversation'} onClick={() => setView('conversation')}>{t('runWorkspace.conversation')}</ViewTab>
        <ViewTab id="timeline-tab" controls="timeline-panel" selected={view === 'timeline'} onClick={() => setView('timeline')}>{t('runWorkspace.timeline')}</ViewTab>
        <span className="ml-auto text-[10px] text-muted">{selectedRun ? t('runWorkspace.agentCount', { count: selectedRun.nodes.length, workflow: selectedRun.workflow.name }) : runsLoading ? t('runWorkspace.loadingRuns') : t('runWorkspace.ready')}</span>
      </div>
    </header>
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <div id="conversation-panel" role="tabpanel" aria-labelledby="conversation-tab" hidden={view !== 'conversation'} className="h-full min-h-0"><NarrativePanel loading={replayLoading} visible={view === 'conversation'} /></div>
      <div id="timeline-panel" role="tabpanel" aria-labelledby="timeline-tab" hidden={view !== 'timeline'} className="h-full min-h-0"><StreamPanel embedded hydrating={replayLoading} visible={view === 'timeline'} /></div>
    </div>
  </section>;
}

function ViewTab({ id, controls, selected, onClick, children }: { id: string; controls: string; selected: boolean; onClick(): void; children: string }) {
  return <button id={id} type="button" role="tab" aria-controls={controls} aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={onClick} className={`rounded px-2.5 py-1 text-xs ${selected ? 'bg-accentSoft/70 text-accentForeground' : 'text-muted hover:bg-surface hover:text-ink'}`}>{children}</button>;
}

function NodePreset({ label, active, count, disabled, tone = 'default', onClick }: { label: string; active: boolean; count: number; disabled?: boolean; tone?: 'default' | 'attention'; onClick(): void }) {
  const activeClass = tone === 'attention' ? 'border-amber-600 bg-amber-950/30 text-amber-100' : 'border-sky-600 bg-sky-950/30 text-sky-100';
  return <button type="button" disabled={disabled} aria-pressed={active} onClick={onClick} className={`shrink-0 rounded-full border px-2 py-1 text-[10px] disabled:opacity-35 ${active ? activeClass : 'border-border text-muted hover:text-ink'}`}>{label} <span aria-hidden="true">{count}</span></button>;
}

function nodeNeedsAttention(node: RunSnapshot['nodes'][number]): boolean {
  return node.status === 'failed' || node.status === 'stalled' || node.verification?.status === 'failed' || node.verification?.status === 'error';
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return right.length > 0 && left.length === right.length && right.every((value) => left.includes(value));
}

function formatRunOption(run: RunSnapshot, liveLabel: string, locale: string): string {
  return `${liveLabel ? `${liveLabel} · ` : ''}${run.workflow.name} · ${run.status} · ${new Date(run.createdAt).toLocaleString(locale)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
