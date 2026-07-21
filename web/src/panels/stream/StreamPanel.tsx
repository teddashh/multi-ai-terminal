import type { AgentEvent, EventRole, RunSnapshot } from '@mat/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../../api/client.js';
import { ACTIVE_RUN_STATUSES, matStore, useMatStore } from '../../app/store.js';
import { EventRow } from '../../components/EventRow.js';
import { displayNodeLabel } from '../../components/nodeLabel.js';
import { filterStreamEvents, groupToolEvents, reduceFollowState, type FeedItem } from './streamLogic.js';

const ROLE_LABELS: Record<EventRole, string> = { user: 'your', agent: 'agent', tool: 'tool', thinking: 'thinking', system: 'status', decision: 'decision' };
const ROLE_STYLE: Record<EventRole, string> = {
  user: 'border-sky-700 text-sky-200', agent: 'border-zinc-600 text-zinc-200', tool: 'border-amber-700 text-amber-200',
  thinking: 'border-violet-700 text-violet-200', system: 'border-zinc-700 text-zinc-400', decision: 'border-emerald-700 text-emerald-200',
};

// Referentially stable fallback — a fresh `[]` per selector call re-renders forever (React #185).
const EMPTY_EVENTS: readonly AgentEvent[] = [];

export interface StreamPanelProps {
  /** The parent owns run selection and replay hydration inside the unified run workspace. */
  embedded?: boolean;
  /** Parent replay hydration remains authoritative when embedded. */
  hydrating?: boolean;
  /** Hidden evidence tabs defer scroll positioning until they are visible. */
  visible?: boolean;
}

export function StreamPanel({ embedded = false, hydrating = false, visible = true }: StreamPanelProps = {}) {
  const activeRunId = useMatStore((state) => state.activeRunId);
  const viewedRunId = useMatStore((state) => state.viewedRunId);
  const selectedWorkspaceId = useMatStore((state) => state.selectedWorkspaceId);
  const runs = useMatStore((state) => state.runs);
  const filters = useMatStore((state) => state.filters);
  const focusedNodeRunId = useMatStore((state) => state.ui.focusedNodeRunId);
  const setNodeFilter = useMatStore((state) => state.setNodeFilter);
  const setFollow = useMatStore((state) => state.setFollow);
  const setViewedRunId = useMatStore((state) => state.setViewedRunId);
  const toggleRole = useMatStore((state) => state.toggleRole);
  const focusNode = useMatStore((state) => state.focusNode);
  const upsertRun = useMatStore((state) => state.upsertRun);
  const setEvents = useMatStore((state) => state.setEvents);
  const loadOlderEvents = useMatStore((state) => state.loadOlderEvents);
  const effectiveRunId = viewedRunId;
  const selectedRun = effectiveRunId ? runs[effectiveRunId] : undefined;
  const events = useMatStore((state) => (effectiveRunId ? state.events[effectiveRunId] : undefined) ?? EMPTY_EVENTS);
  const [history, setHistory] = useState<RunSnapshot[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(filters.follow);
  const lastScrollTopRef = useRef(0);
  const intentUntilRef = useRef(0);
  const pendingReplayScrollRef = useRef<string>();
  const pendingPinsRef = useRef<{ frames: number[]; timers: number[] }>({ frames: [], timers: [] });
  const historyGenerationRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const replayGenerationRef = useRef(0);
  // Keep manual-reading controls alive when the run finishes while it is open.
  // A terminal replay selected after reload must not be mistaken for a live session.
  const liveSessionRunIdRef = useRef<string>();
  if (effectiveRunId && effectiveRunId === activeRunId) liveSessionRunIdRef.current = effectiveRunId;
  else if (liveSessionRunIdRef.current !== effectiveRunId) liveSessionRunIdRef.current = undefined;
  const followableRun = effectiveRunId !== undefined && (effectiveRunId === activeRunId || liveSessionRunIdRef.current === effectiveRunId);

  const clearPendingPins = useCallback(() => {
    for (const frame of pendingPinsRef.current.frames) cancelAnimationFrame(frame);
    for (const timer of pendingPinsRef.current.timers) window.clearTimeout(timer);
    pendingPinsRef.current = { frames: [], timers: [] };
  }, []);
  const scrollToBottomNow = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
  }, []);
  const forceScrollToBottom = useCallback(() => {
    clearPendingPins();
    scrollToBottomNow();
    const frames: number[] = [];
    frames.push(requestAnimationFrame(scrollToBottomNow));
    frames.push(requestAnimationFrame(() => { frames.push(requestAnimationFrame(scrollToBottomNow)); }));
    pendingPinsRef.current = {
      frames,
      timers: [window.setTimeout(scrollToBottomNow, 50), window.setTimeout(scrollToBottomNow, 150)],
    };
  }, [clearPendingPins, scrollToBottomNow]);
  const updateFollow = useCallback((following: boolean) => {
    if (followRef.current === following) return;
    followRef.current = following;
    setFollow(following);
  }, [setFollow]);

  useEffect(() => { followRef.current = filters.follow; }, [filters.follow]);
  useEffect(() => clearPendingPins, [clearPendingPins]);

  useEffect(() => {
    const generation = historyGenerationRef.current + 1;
    historyGenerationRef.current = generation;
    replayGenerationRef.current += 1;
    clearPendingPins();
    pendingReplayScrollRef.current = undefined;
    setHistory([]);
    setHistoryHasMore(false);
    setHistoryLoading(true);
    setReplayLoading(false);
    setError(undefined);
    setSearch('');
    updateFollow(true);
    if (embedded) {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      return;
    }
    historyLoadingRef.current = true;
    void apiClient.getRuns({ ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}), limit: 50 })
      .then((page) => {
        if (historyGenerationRef.current !== generation) return;
        setHistory(uniqueRuns(page));
        setHistoryHasMore(page.length === 50);
      })
      .catch((caught) => { if (historyGenerationRef.current === generation) setError(errorMessage(caught)); })
      .finally(() => {
        if (historyGenerationRef.current !== generation) return;
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      });
    return () => {
      if (historyGenerationRef.current === generation) historyGenerationRef.current += 1;
    };
  }, [clearPendingPins, embedded, selectedWorkspaceId, updateFollow]);

  const loadMoreHistory = async () => {
    if (historyLoadingRef.current) return;
    const generation = historyGenerationRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true); setError(undefined);
    try {
      const before = history.at(-1)?.createdAt;
      const page = await apiClient.getRuns({ ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}), limit: 50, ...(before !== undefined ? { before } : {}) });
      if (historyGenerationRef.current !== generation) return;
      setHistory(uniqueRuns([...history, ...page]));
      setHistoryHasMore(page.length === 50);
    } catch (caught) {
      if (historyGenerationRef.current === generation) setError(errorMessage(caught));
    } finally {
      if (historyGenerationRef.current === generation) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  };

  const selectRun = (runId: string) => {
    setViewedRunId(runId); setError(undefined); focusNode(undefined); setNodeFilter([]);
    if (runId === activeRunId) { updateFollow(true); return; }
    clearPendingPins(); updateFollow(false);
  };

  const viewingLive = effectiveRunId !== undefined && effectiveRunId === activeRunId;
  useEffect(() => {
    const generation = replayGenerationRef.current + 1;
    replayGenerationRef.current = generation;
    if (embedded) {
      pendingReplayScrollRef.current = effectiveRunId && !viewingLive ? effectiveRunId : undefined;
      setReplayLoading(false);
      if (effectiveRunId && !followableRun) updateFollow(false);
      return;
    }
    if (!effectiveRunId || viewingLive) {
      pendingReplayScrollRef.current = undefined;
      setReplayLoading(false);
      return;
    }
    clearPendingPins();
    updateFollow(false);
    pendingReplayScrollRef.current = effectiveRunId;
    setReplayLoading(true);
    setError(undefined);
    void (async () => {
      try {
        let run = matStore.getState().runs[effectiveRunId];
        if (!run) {
          run = await apiClient.getRun(effectiveRunId);
          if (replayGenerationRef.current !== generation) return;
          upsertRun(run);
        }
        await loadReplayPages(effectiveRunId, loadOlderEvents, setEvents, {
          isCurrent: () => replayGenerationRef.current === generation,
        });
      } catch (caught) {
        if (replayGenerationRef.current === generation) setError(errorMessage(caught));
      } finally {
        if (replayGenerationRef.current === generation) setReplayLoading(false);
      }
    })();
    return () => {
      if (replayGenerationRef.current === generation) replayGenerationRef.current += 1;
    };
  }, [clearPendingPins, effectiveRunId, embedded, followableRun, loadOlderEvents, setEvents, updateFollow, upsertRun, viewingLive]);

  const filteredEvents = useMemo(() => filterStreamEvents(events, {
    nodeRunIds: filters.nodeRunIds,
    roles: filters.roles,
    focusedNodeRunId,
    search,
  }), [events, filters.nodeRunIds, filters.roles, focusedNodeRunId, search]);
  const items = useMemo(() => groupToolEvents(filteredEvents), [filteredEvents]);
  const evidenceGaps = useMemo(() => findEventGaps(events), [events]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index = 0) => 56 + Math.min(600, Math.floor((items[index]?.events.reduce((length, event) => length + event.text.length, 0) ?? 0) / 6)),
    overscan: 8,
    getItemKey: (index) => items[index]?.key ?? index,
    initialRect: { width: 420, height: 600 },
  });
  const totalSize = virtualizer.getTotalSize();
  const previousGrowthRef = useRef({ runId: effectiveRunId, itemCount: 0, totalSize: 0 });

  useLayoutEffect(() => {
    const previous = previousGrowthRef.current;
    const switched = previous.runId !== effectiveRunId;
    const grew = !switched && (items.length > previous.itemCount || totalSize > previous.totalSize);
    previousGrowthRef.current = { runId: effectiveRunId, itemCount: items.length, totalSize };
    if (effectiveRunId !== activeRunId || items.length === 0) return;
    if (switched) { updateFollow(true); forceScrollToBottom(); }
    else if (grew && followRef.current) forceScrollToBottom();
  }, [activeRunId, effectiveRunId, forceScrollToBottom, items.length, totalSize, updateFollow]);

  useLayoutEffect(() => {
    if (replayLoading || hydrating || !visible || effectiveRunId === activeRunId || pendingReplayScrollRef.current !== effectiveRunId || items.length === 0) return;
    pendingReplayScrollRef.current = undefined;
    forceScrollToBottom();
  }, [activeRunId, effectiveRunId, forceScrollToBottom, hydrating, items.length, replayLoading, visible]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const deltaY = element.scrollTop - lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    if (!followableRun) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    const next = reduceFollowState({ following: followRef.current }, { type: 'scroll', gap, deltaY, intentActive: performance.now() < intentUntilRef.current });
    if (next.following !== followRef.current) {
      if (!next.following) clearPendingPins();
      updateFollow(next.following);
    }
  };
  const markUserScrollIntent = () => { intentUntilRef.current = performance.now() + 1500; };
  const jumpToLive = () => {
    updateFollow(reduceFollowState({ following: followRef.current }, { type: 'jump-to-live' }).following);
    forceScrollToBottom();
  };

  const availableRuns = uniqueRuns([
    ...Object.values(runs).filter((run) => run.workspaceId === selectedWorkspaceId).sort((a, b) => b.createdAt - a.createdAt),
    ...history,
  ]);
  const toggleNode = (nodeRunId: string) => {
    const selected = filters.nodeRunIds;
    setNodeFilter(selected.includes(nodeRunId) ? selected.filter((id) => id !== nodeRunId) : [...selected, nodeRunId]);
  };

  return <section className="flex h-full min-h-0 flex-col" aria-label="Stream panel">
    <header className="shrink-0 border-b border-border bg-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="mr-auto text-xs font-semibold uppercase tracking-wider text-muted">Event Stream · {filteredEvents.length}</h2>
        {!embedded && <>
          <label className="sr-only" htmlFor="stream-run-selector">Select run</label>
          <select id="stream-run-selector" value={effectiveRunId ?? ''} onChange={(event) => { if (event.target.value) void selectRun(event.target.value); }} className="max-w-48 rounded border border-border bg-zinc-950 px-2 py-1 text-xs text-ink">
            {!effectiveRunId && <option value="">No runs</option>}
            {availableRuns.map((run) => <option key={run.runId} value={run.runId}>{ACTIVE_RUN_STATUSES.has(run.status) ? 'Live · ' : ''}{run.workflow.name} · {run.status} · {formatRunDate(run.createdAt)}</option>)}
          </select>
          {historyHasMore && <button type="button" disabled={historyLoading} onClick={() => void loadMoreHistory()} className="rounded border border-border px-2 py-1 text-[10px] text-muted disabled:opacity-50">{historyLoading ? 'Loading…' : 'More runs'}</button>}
        </>}
      </div>
      {selectedRun && <div className="mb-2 flex gap-1 overflow-x-auto pb-1" aria-label="Node filters">
        <button type="button" aria-pressed={filters.nodeRunIds.length === 0} onClick={() => setNodeFilter([])} className={`shrink-0 rounded-full border px-2 py-1 text-[10px] ${filters.nodeRunIds.length === 0 ? 'border-sky-600 text-sky-200' : 'border-border text-muted'}`}>All nodes</button>
        {selectedRun.nodes.map((node) => <button type="button" key={node.nodeRunId} aria-pressed={filters.nodeRunIds.includes(node.nodeRunId)} onClick={() => toggleNode(node.nodeRunId)} className={`max-w-32 shrink-0 truncate rounded-full border px-2 py-1 text-[10px] ${filters.nodeRunIds.includes(node.nodeRunId) ? 'border-sky-600 bg-sky-950/30 text-sky-200' : 'border-border text-muted'}`}>{displayNodeLabel(node, selectedRun.nodes)}</button>)}
      </div>}
      <div className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(ROLE_LABELS) as EventRole[]).map((role) => <button type="button" key={role} aria-pressed={filters.roles.includes(role)} onClick={() => toggleRole(role)} className={`rounded border px-2 py-1 text-[10px] ${filters.roles.includes(role) ? ROLE_STYLE[role] : 'border-border text-zinc-600'}`}>{ROLE_LABELS[role]}</button>)}
        <label className="ml-auto min-w-28 flex-1 sm:max-w-52"><span className="sr-only">Search events</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search events" className="w-full rounded border border-border bg-zinc-950 px-2 py-1 text-xs text-ink outline-none focus:border-violet-500" /></label>
      </div>
      {focusedNodeRunId && <div className="mt-2 flex items-center gap-2 rounded bg-sky-950/30 px-2 py-1 text-[11px] text-sky-200"><span className="truncate">Focused: {focusedNodeLabel(selectedRun, focusedNodeRunId)}</span><button type="button" onClick={() => focusNode(undefined)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-sky-900">Clear</button></div>}
      {hydrating && <p role="status" className="mt-2 text-xs text-sky-300">Loading complete replay evidence…</p>}
      {evidenceGaps.length > 0 && <div role="alert" className="mt-2 rounded border border-red-900 bg-red-950/30 px-2 py-1.5 text-xs text-red-200">Evidence gap{evidenceGaps.length === 1 ? '' : 's'}: {evidenceGaps.slice(0, 3).map((gap) => `#${gap.fromSeq}–${gap.toSeq}`).join(', ')}{evidenceGaps.length > 3 ? ` +${evidenceGaps.length - 3} more` : ''}</div>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </header>
    {!effectiveRunId ? <div className="p-4 text-xs text-muted">No run yet. Use the run box to start a workflow.</div>
      : (replayLoading || hydrating) && events.length === 0 ? <div className="animate-pulse p-4 text-xs text-muted">Loading replay…</div>
      : events.length === 0 ? <div className="flex items-center gap-2 p-4 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />Waiting for events…</div>
      : <div ref={scrollRef} onScroll={onScroll} onWheel={markUserScrollIntent} onPointerDown={markUserScrollIntent} className="relative min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="stream-scroll-region">
        {(events[0]?.seq ?? 1) > 1 && <div role="status" className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">Older events trimmed from memory — showing from seq {events[0]!.seq}</div>}
        <div className="relative w-full" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index];
            if (!item) return null;
            return <div key={item.key} ref={virtualizer.measureElement} data-index={virtualItem.index} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${virtualItem.start}px)` }}><FeedItemRow item={item} /></div>;
          })}
        </div>
        {items.length === 0 && <p className="absolute inset-x-0 top-0 p-4 text-xs text-muted">No events match these filters.</p>}
        {followableRun && !filters.follow && <button type="button" onClick={jumpToLive} className="sticky bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-sky-600 bg-sky-950 px-3 py-1.5 text-xs text-sky-100 shadow-xl">Jump to live</button>}
      </div>}
  </section>;
}

export function findEventGaps(events: readonly AgentEvent[]): Array<{ fromSeq: number; toSeq: number }> {
  const gaps: Array<{ fromSeq: number; toSeq: number }> = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const current = events[index]!;
    if (current.seq > previous.seq + 1) gaps.push({ fromSeq: previous.seq + 1, toSeq: current.seq - 1 });
  }
  return gaps;
}

function FeedItemRow({ item }: { item: FeedItem }) {
  if (item.events.length === 1) return <EventRow event={item.events[0]!} {...(item.duplicateCount ? { duplicateCount: item.duplicateCount } : {})} />;
  return <div className="my-1 overflow-hidden rounded border border-amber-700/60 bg-amber-950/10" data-tool-call-id={item.toolCallId} aria-label={`Tool call ${item.toolCallId ?? ''}`}>
    {item.events.map((event) => <EventRow key={event.id} event={event} />)}
  </div>;
}

export async function loadReplayPages(
  runId: string,
  loadOlderEvents: (runId: string) => Promise<void>,
  setEvents: (runId: string, events: AgentEvent[]) => void,
  options: {
    isCurrent?: () => boolean;
    getEvents?: (runId: string, afterSeq: number, limit: number) => Promise<AgentEvent[]>;
  } = {},
): Promise<void> {
  const isCurrent = options.isCurrent ?? (() => true);
  const getEvents = options.getEvents ?? ((id: string, afterSeq: number, limit: number) => apiClient.getEvents(id, afterSeq, limit));
  let accumulated = matStore.getState().events[runId] ?? [];
  let priorOldest: number | undefined;
  while (isCurrent() && (accumulated.length === 0 || (accumulated[0]?.seq ?? 1) > 1)) {
    priorOldest = accumulated[0]?.seq;
    await loadOlderEvents(runId);
    if (!isCurrent()) return;
    accumulated = matStore.getState().events[runId] ?? [];
    if (accumulated.length === 0 || accumulated[0]?.seq === priorOldest) break;
  }
  let afterSeq = accumulated.at(-1)?.seq ?? 0;
  while (isCurrent() && accumulated.length > 0) {
    const page = await getEvents(runId, afterSeq, 1000);
    if (!isCurrent()) return;
    const newEvents = page.filter((event) => event.seq > afterSeq);
    if (newEvents.length === 0) break;
    setEvents(runId, [...(matStore.getState().events[runId] ?? []), ...newEvents]);
    accumulated = matStore.getState().events[runId] ?? [];
    afterSeq = newEvents.at(-1)!.seq;
    if (page.length < 1000) break;
  }
}

function uniqueRuns(runs: RunSnapshot[]): RunSnapshot[] {
  const seen = new Set<string>();
  return runs.filter((run) => !seen.has(run.runId) && Boolean(seen.add(run.runId)));
}

function focusedNodeLabel(run: RunSnapshot | undefined, nodeRunId: string): string {
  const node = run?.nodes.find((candidate) => candidate.nodeRunId === nodeRunId);
  return node && run ? displayNodeLabel(node, run.nodes) : nodeRunId;
}

function formatRunDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
