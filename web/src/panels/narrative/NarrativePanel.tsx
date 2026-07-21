import type { AgentEvent } from '@mat/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMatStore } from '../../app/store.js';
import { Collapsible } from '../../components/Collapsible.js';
import { PROVIDER_COLORS } from '../../components/AgentChip.js';
import { useUiPreferences } from '../../i18n/UiPreferences.js';
import { buildNarrativeItems, filterNarrativeItems, type NarrativeItem } from './narrativeLogic.js';

const EMPTY_EVENTS: readonly AgentEvent[] = [];

export function NarrativePanel({ loading = false, loadError, visible = true }: { loading?: boolean; loadError?: string; visible?: boolean }) {
  const { t } = useUiPreferences();
  const activeRunId = useMatStore((state) => state.activeRunId);
  const viewedRunId = useMatStore((state) => state.viewedRunId);
  const run = useMatStore((state) => viewedRunId ? state.runs[viewedRunId] : undefined);
  const events = useMatStore((state) => (viewedRunId ? state.events[viewedRunId] : undefined) ?? EMPTY_EVENTS);
  const filters = useMatStore((state) => state.filters);
  const focusedNodeRunId = useMatStore((state) => state.ui.focusedNodeRunId);
  const integrity = useMatStore((state) => viewedRunId ? state.evidenceIntegrity[viewedRunId] : undefined);
  const setFollow = useMatStore((state) => state.setFollow);
  const focusNode = useMatStore((state) => state.focusNode);
  const retryRecovery = useMatStore((state) => state.retryEvidenceRecovery);
  const [search, setSearch] = useState('');
  const [showTechnical, setShowTechnical] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userIntentUntil = useRef(0);
  const liveSessionRunId = useRef<string>();
  if (viewedRunId && viewedRunId === activeRunId) liveSessionRunId.current = viewedRunId;
  else if (liveSessionRunId.current !== viewedRunId) liveSessionRunId.current = undefined;
  const followableRun = viewedRunId !== undefined && (viewedRunId === activeRunId || liveSessionRunId.current === viewedRunId);

  const projected = useMemo(() => run ? buildNarrativeItems(run, events) : [], [events, run]);
  const items = useMemo(() => filterNarrativeItems(projected, {
    nodeRunIds: filters.nodeRunIds,
    ...(focusedNodeRunId ? { focusedNodeRunId } : {}),
    search,
    showTechnical,
  }), [filters.nodeRunIds, focusedNodeRunId, projected, search, showTechnical]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index = 0) => 82 + Math.min(720, Math.floor((items[index]?.text?.length ?? 0) / 5)),
    overscan: 6,
    getItemKey: (index) => items[index]?.key ?? index,
    initialRect: { width: 640, height: 700 },
  });
  const totalSize = virtualizer.getTotalSize();
  const previousGrowth = useRef({ runId: viewedRunId, lastSeqEnd: 0, totalSize: 0 });
  const replayPinPending = useRef(false);

  const scrollToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  }, [items.length, virtualizer]);
  const jumpToLive = () => {
    setFollow(true);
    scrollToLatest();
  };

  useEffect(() => { setSearch(''); setShowTechnical(false); }, [viewedRunId]);

  useLayoutEffect(() => {
    const lastSeqEnd = items.at(-1)?.seqEnd ?? 0;
    const previous = previousGrowth.current;
    const switched = previous.runId !== viewedRunId;
    const grew = !switched && (lastSeqEnd > previous.lastSeqEnd || totalSize > previous.totalSize);
    previousGrowth.current = { runId: viewedRunId, lastSeqEnd, totalSize };
    if (!visible || (!switched && !grew) || !followableRun || !filters.follow || items.length === 0) return;
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [filters.follow, followableRun, items, scrollToLatest, totalSize, viewedRunId, visible]);

  useLayoutEffect(() => {
    if (loading) { replayPinPending.current = true; return; }
    if (!replayPinPending.current || !visible || items.length === 0) return;
    replayPinPending.current = false;
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [items.length, loading, scrollToLatest, visible]);

  const onScroll = () => {
    if (!followableRun) return;
    const element = scrollRef.current;
    if (!element) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (gap < 96) setFollow(true);
    else if (performance.now() < userIntentUntil.current) setFollow(false);
  };

  if (!run) return <section aria-label={t('narrative.panel')} className="grid h-full place-items-center p-6 text-sm text-muted"><div className="max-w-sm text-center"><p className="font-medium text-ink">{t('narrative.noneTitle')}</p><p className="mt-2 text-xs">{t('narrative.noneHelp')}</p></div></section>;

  return <section aria-label={t('narrative.panel')} className="flex h-full min-h-0 flex-col bg-canvas/30">
    <header className="shrink-0 border-b border-border bg-panel/95 px-4 py-3">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-widest text-accentForeground">{t('narrative.conversation')}</p><p className="mt-1 line-clamp-2 text-sm text-ink" title={run.task}>{run.task}</p></div><span className="shrink-0 rounded-full border border-border px-2 py-1 text-[10px] text-muted">{t('narrative.blocks', { count: items.length })}</span></div>
      <div className="mt-3 flex items-center gap-2">
        <label className="min-w-0 flex-1"><span className="sr-only">{t('narrative.search')}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('narrative.searchPlaceholder')} className="w-full rounded border border-border bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" /></label>
        <button type="button" aria-pressed={showTechnical} onClick={() => setShowTechnical((value) => !value)} className={`shrink-0 rounded border px-2 py-1.5 text-[10px] ${showTechnical ? 'border-accentBorder bg-accentSoft/60 text-accentForeground' : 'border-border text-muted'}`}>{t('narrative.technical')}</button>
      </div>
      {focusedNodeRunId && <div className="mt-2 flex items-center gap-2 rounded bg-sky-950/30 px-2 py-1 text-[11px] text-sky-200"><span className="truncate">{t('narrative.focused', { node: run.nodes.find((node) => node.nodeRunId === focusedNodeRunId)?.label ?? focusedNodeRunId })}</span><button type="button" onClick={() => focusNode(undefined)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-sky-900">{t('narrative.showAll')}</button></div>}
      {integrity?.status === 'recovering' && <div role="status" className="mt-2 rounded border border-amber-800 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-200">{t('narrative.recovering', { from: integrity.expectedSeq ? t('narrative.fromEvent', { seq: integrity.expectedSeq }) : '' })}</div>}
      {integrity?.status === 'incomplete' && <div role="alert" className="mt-2 flex items-center gap-2 rounded border border-red-800 bg-red-950/30 px-2 py-1.5 text-xs text-red-200"><span className="min-w-0 flex-1">{t('narrative.incomplete', { message: integrity.message ?? '' })}</span>{viewedRunId && <button type="button" onClick={() => retryRecovery(viewedRunId)} className="shrink-0 rounded border border-red-700 px-2 py-1">{t('narrative.retry')}</button>}</div>}
      {loadError && <p role="alert" className="mt-2 text-xs text-red-300">{loadError}</p>}
    </header>
    {loading && events.length === 0 ? <div className="animate-pulse p-4 text-xs text-muted">{t('narrative.loading')}</div>
      : events.length === 0 ? <div className="flex items-center gap-2 p-4 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />{t('narrative.waiting')}</div>
      : <div ref={scrollRef} onScroll={onScroll} onWheel={() => { userIntentUntil.current = performance.now() + 1500; }} onPointerDown={() => { userIntentUntil.current = performance.now() + 1500; }} className="relative min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="narrative-scroll-region">
        {(events[0]?.seq ?? 1) > 1 && <div role="status" className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">{t('narrative.trimmed', { seq: events[0]!.seq })}</div>}
        <div className="relative mx-auto w-full max-w-5xl" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index];
            if (!item) return null;
            return <div key={item.key} ref={virtualizer.measureElement} data-index={virtualItem.index} className="absolute left-0 top-0 w-full px-4 py-1.5" style={{ transform: `translateY(${virtualItem.start}px)` }}><NarrativeRow item={item} /></div>;
          })}
        </div>
        {items.length === 0 && <p className="absolute inset-x-0 top-0 p-6 text-center text-xs text-muted">{t('narrative.noMatch')}</p>}
        {followableRun && !filters.follow && <button type="button" onClick={jumpToLive} className="sticky bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-sky-600 bg-sky-950 px-3 py-1.5 text-xs text-sky-100 shadow-xl">{t('narrative.jumpLive')}</button>}
      </div>}
  </section>;
}

export function NarrativeRow({ item }: { item: NarrativeItem }) {
  const { locale, t } = useUiPreferences();
  if (item.kind === 'gap') return <article role="alert" className="rounded border border-red-800/70 bg-red-950/25 px-3 py-2 text-xs text-red-200">{t('narrative.gap', { from: item.gap?.fromSeq ?? '?', to: item.gap?.toSeq ?? '?' })}</article>;
  const actor = item.actors[0];
  const providerColor = actor?.provider ? PROVIDER_COLORS[actor.provider] : '#71717a';
  const tone = {
    message: 'border-border bg-surface/75', decision: 'border-emerald-700 bg-emerald-950/25', verification: 'border-sky-800 bg-sky-950/20',
    error: 'border-red-800 bg-red-950/30', tool: 'border-amber-800 bg-amber-950/20', thinking: 'border-violet-800 bg-violet-950/20',
    prompt: 'border-sky-800 bg-sky-950/15', lifecycle: 'border-border bg-canvas/50', gap: 'border-red-800 bg-red-950/30',
  }[item.kind];
  const content = item.kind === 'tool' ? <Collapsible summary={<span>{item.tool?.name ?? t('narrative.tool')} · {item.tool?.phase}</span>}><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-amber-100">{[item.tool?.input, item.tool?.output, item.text].filter(Boolean).join('\n\n')}</pre></Collapsible>
    : item.kind === 'thinking' ? <Collapsible summary={<p className="line-clamp-2 whitespace-pre-wrap text-violet-200">{item.text}</p>}><p className="mt-2 whitespace-pre-wrap break-words text-xs text-violet-100">{item.text}</p></Collapsible>
    : <p className={`whitespace-pre-wrap break-words ${item.kind === 'error' ? 'text-red-100' : item.kind === 'decision' ? 'text-emerald-100' : 'text-ink'}`}>{item.text}</p>;
  return <article data-narrative-key={item.key} data-node-run-id={actor?.nodeRunId ?? undefined} className={`rounded-lg border border-l-[3px] p-3 shadow-sm ${tone}`} style={{ borderLeftColor: providerColor }}>
    <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 pb-2 text-[10px] text-muted"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: providerColor }} aria-hidden="true" /><strong className="text-sm text-ink">{actor?.label ?? t('narrative.run')}</strong>{actor?.provider && <span className="rounded-full border border-border bg-canvas/60 px-1.5 py-0.5 font-medium text-ink">{actor.provider}{actor.model ? ` · ${actor.model}` : ''}</span>}{actor?.stageName && <span className="rounded bg-raised px-1.5 py-0.5">{actor.stageName}</span>}<span>{t('narrative.attempt', { count: item.attempt })}</span><span>#{item.seqStart}{item.seqEnd !== item.seqStart ? `–${item.seqEnd}` : ''}</span><time className="ml-auto" dateTime={new Date(item.tsStart).toISOString()}>{new Date(item.tsStart).toLocaleTimeString(locale, { hour12: false })}</time></header>
    {content}
  </article>;
}
