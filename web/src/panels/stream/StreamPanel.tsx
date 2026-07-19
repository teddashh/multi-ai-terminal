import type { AgentEvent, EventRole, RunSnapshot } from '@mat/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../../api/client.js';
import { matStore, useMatStore } from '../../app/store.js';
import { EventRow } from '../../components/EventRow.js';
import { filterStreamEvents, groupToolEvents, isScrolledToBottom, reduceFollowState, type FeedItem } from './streamLogic.js';

const ROLE_LABELS: Record<EventRole, string> = { user: 'your', agent: 'agent', tool: 'tool', thinking: 'thinking', system: 'status', decision: 'decision' };
const ROLE_STYLE: Record<EventRole, string> = {
  user: 'border-sky-700 text-sky-200', agent: 'border-zinc-600 text-zinc-200', tool: 'border-amber-700 text-amber-200',
  thinking: 'border-violet-700 text-violet-200', system: 'border-zinc-700 text-zinc-400', decision: 'border-emerald-700 text-emerald-200',
};

// Referentially stable fallback — a fresh `[]` per selector call re-renders forever (React #185).
const EMPTY_EVENTS: readonly AgentEvent[] = [];

export function StreamPanel() {
  const activeRunId = useMatStore((state) => state.activeRunId);
  const selectedWorkspaceId = useMatStore((state) => state.selectedWorkspaceId);
  const runs = useMatStore((state) => state.runs);
  const filters = useMatStore((state) => state.filters);
  const focusedNodeRunId = useMatStore((state) => state.ui.focusedNodeRunId);
  const setNodeFilter = useMatStore((state) => state.setNodeFilter);
  const setFollow = useMatStore((state) => state.setFollow);
  const toggleRole = useMatStore((state) => state.toggleRole);
  const focusNode = useMatStore((state) => state.focusNode);
  const upsertRun = useMatStore((state) => state.upsertRun);
  const setEvents = useMatStore((state) => state.setEvents);
  const loadOlderEvents = useMatStore((state) => state.loadOlderEvents);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const effectiveRunId = selectedRunId ?? activeRunId;
  const selectedRun = effectiveRunId ? runs[effectiveRunId] : undefined;
  const events = useMatStore((state) => (effectiveRunId ? state.events[effectiveRunId] : undefined) ?? EMPTY_EVENTS);
  const [history, setHistory] = useState<RunSnapshot[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshHistory = async (append = false) => {
    if (historyLoading) return;
    setHistoryLoading(true); setError(undefined);
    try {
      const current = append ? history : [];
      const before = append ? current.at(-1)?.createdAt : undefined;
      const page = await apiClient.getRuns({ ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}), limit: 50, ...(before !== undefined ? { before } : {}) });
      setHistory(uniqueRuns([...current, ...page]));
      setHistoryHasMore(page.length === 50);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setHistoryLoading(false); }
  };

  useEffect(() => { void refreshHistory(false); }, [selectedWorkspaceId]);

  const selectRun = async (runId: string) => {
    setSelectedRunId(runId); setError(undefined); focusNode(undefined); setNodeFilter([]);
    if (runId === activeRunId) { setFollow(true); return; }
    setFollow(false); setReplayLoading(true);
    try {
      let run = matStore.getState().runs[runId];
      if (!run) { run = await apiClient.getRun(runId); upsertRun(run); }
      await loadReplayPages(runId, loadOlderEvents, setEvents);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setReplayLoading(false); }
  };

  const filteredEvents = useMemo(() => filterStreamEvents(events, {
    nodeRunIds: filters.nodeRunIds,
    roles: filters.roles,
    focusedNodeRunId,
    search,
  }), [events, filters.nodeRunIds, filters.roles, focusedNodeRunId, search]);
  const items = useMemo(() => groupToolEvents(filteredEvents), [filteredEvents]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 78,
    overscan: 8,
    getItemKey: (index) => items[index]?.key ?? index,
    initialRect: { width: 420, height: 600 },
  });

  useLayoutEffect(() => {
    if (!filters.follow || items.length === 0) return;
    virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  }, [filters.follow, items.length, effectiveRunId, virtualizer]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element || effectiveRunId !== activeRunId) return;
    const next = reduceFollowState({ following: filters.follow }, { type: 'scroll', atBottom: isScrolledToBottom(element.scrollTop, element.clientHeight, element.scrollHeight) });
    if (next.following !== filters.follow) setFollow(next.following);
  };
  const jumpToLive = () => {
    setFollow(reduceFollowState({ following: filters.follow }, { type: 'jump-to-live' }).following);
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  };

  const availableRuns = uniqueRuns([...(activeRunId && runs[activeRunId] ? [runs[activeRunId]!] : []), ...history]);
  const toggleNode = (nodeRunId: string) => {
    const selected = filters.nodeRunIds;
    setNodeFilter(selected.includes(nodeRunId) ? selected.filter((id) => id !== nodeRunId) : [...selected, nodeRunId]);
  };

  return <section className="flex h-full min-h-0 flex-col" aria-label="Stream panel">
    <header className="shrink-0 border-b border-border bg-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="mr-auto text-xs font-semibold uppercase tracking-wider text-muted">Event Stream · {filteredEvents.length}</h2>
        <label className="sr-only" htmlFor="stream-run-selector">Select run</label>
        <select id="stream-run-selector" value={effectiveRunId ?? ''} onChange={(event) => { if (event.target.value) void selectRun(event.target.value); }} className="max-w-48 rounded border border-border bg-zinc-950 px-2 py-1 text-xs text-ink">
          {!effectiveRunId && <option value="">No runs</option>}
          {availableRuns.map((run) => <option key={run.runId} value={run.runId}>{run.runId === activeRunId ? 'Live · ' : ''}{run.workflow.name} · {run.status} · {formatRunDate(run.createdAt)}</option>)}
        </select>
        {historyHasMore && <button type="button" disabled={historyLoading} onClick={() => void refreshHistory(true)} className="rounded border border-border px-2 py-1 text-[10px] text-muted disabled:opacity-50">{historyLoading ? 'Loading…' : 'More runs'}</button>}
      </div>
      {selectedRun && <div className="mb-2 flex gap-1 overflow-x-auto pb-1" aria-label="Node filters">
        <button type="button" aria-pressed={filters.nodeRunIds.length === 0} onClick={() => setNodeFilter([])} className={`shrink-0 rounded-full border px-2 py-1 text-[10px] ${filters.nodeRunIds.length === 0 ? 'border-sky-600 text-sky-200' : 'border-border text-muted'}`}>All nodes</button>
        {selectedRun.nodes.map((node) => <button type="button" key={node.nodeRunId} aria-pressed={filters.nodeRunIds.includes(node.nodeRunId)} onClick={() => toggleNode(node.nodeRunId)} className={`max-w-32 shrink-0 truncate rounded-full border px-2 py-1 text-[10px] ${filters.nodeRunIds.includes(node.nodeRunId) ? 'border-sky-600 bg-sky-950/30 text-sky-200' : 'border-border text-muted'}`}>{node.label}</button>)}
      </div>}
      <div className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(ROLE_LABELS) as EventRole[]).map((role) => <button type="button" key={role} aria-pressed={filters.roles.includes(role)} onClick={() => toggleRole(role)} className={`rounded border px-2 py-1 text-[10px] ${filters.roles.includes(role) ? ROLE_STYLE[role] : 'border-border text-zinc-600'}`}>{ROLE_LABELS[role]}</button>)}
        <label className="ml-auto min-w-28 flex-1 sm:max-w-52"><span className="sr-only">Search events</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search events" className="w-full rounded border border-border bg-zinc-950 px-2 py-1 text-xs text-ink outline-none focus:border-violet-500" /></label>
      </div>
      {focusedNodeRunId && <div className="mt-2 flex items-center gap-2 rounded bg-sky-950/30 px-2 py-1 text-[11px] text-sky-200"><span className="truncate">Focused: {selectedRun?.nodes.find((node) => node.nodeRunId === focusedNodeRunId)?.label ?? focusedNodeRunId}</span><button type="button" onClick={() => focusNode(undefined)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-sky-900">Clear</button></div>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </header>
    {!effectiveRunId ? <div className="p-4 text-xs text-muted">No run yet. Use the run box to start a workflow.</div>
      : replayLoading ? <div className="animate-pulse p-4 text-xs text-muted">Loading replay…</div>
      : events.length === 0 ? <div className="flex items-center gap-2 p-4 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />Waiting for events…</div>
      : <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto" data-testid="stream-scroll-region">
        {(events[0]?.seq ?? 1) > 1 && <div role="status" className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">Older events trimmed from memory — showing from seq {events[0]!.seq}</div>}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index];
            if (!item) return null;
            return <div key={item.key} ref={virtualizer.measureElement} data-index={virtualItem.index} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${virtualItem.start}px)` }}><FeedItemRow item={item} /></div>;
          })}
        </div>
        {items.length === 0 && <p className="absolute inset-x-0 top-0 p-4 text-xs text-muted">No events match these filters.</p>}
        {effectiveRunId === activeRunId && !filters.follow && <button type="button" onClick={jumpToLive} className="sticky bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-sky-600 bg-sky-950 px-3 py-1.5 text-xs text-sky-100 shadow-xl">Jump to live</button>}
      </div>}
  </section>;
}

function FeedItemRow({ item }: { item: FeedItem }) {
  if (item.events.length === 1) return <EventRow event={item.events[0]!} />;
  return <div className="my-1 overflow-hidden rounded border border-amber-700/60 bg-amber-950/10" data-tool-call-id={item.toolCallId} aria-label={`Tool call ${item.toolCallId ?? ''}`}>
    {item.events.map((event) => <EventRow key={event.id} event={event} />)}
  </div>;
}

async function loadReplayPages(runId: string, loadOlderEvents: (runId: string) => Promise<void>, setEvents: (runId: string, events: AgentEvent[]) => void): Promise<void> {
  let accumulated = matStore.getState().events[runId] ?? [];
  let priorOldest: number | undefined;
  while (accumulated.length === 0 || (accumulated[0]?.seq ?? 1) > 1) {
    priorOldest = accumulated[0]?.seq;
    await loadOlderEvents(runId);
    accumulated = matStore.getState().events[runId] ?? [];
    if (accumulated.length === 0 || accumulated[0]?.seq === priorOldest) break;
  }
  let afterSeq = accumulated.at(-1)?.seq ?? 0;
  while (accumulated.length > 0) {
    const page = await apiClient.getEvents(runId, afterSeq, 1000);
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

function formatRunDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
