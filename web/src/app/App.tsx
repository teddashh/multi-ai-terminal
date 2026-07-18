import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { apiClient } from '../api/client.js';
import { ReconnectingWsClient } from '../api/ws.js';
import { RunPanel } from '../panels/run/RunPanel.js';
import { StreamPanel } from '../panels/stream/StreamPanel.js';
import { WorkflowPanel } from '../panels/workflow/WorkflowPanel.js';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel.js';
import { matStore, useMatStore } from './store.js';

const WIDTHS_KEY = 'mat-panel-widths-v1';
const DEFAULT_WIDTHS = [210, 320, 390] as const;
const MIN_WIDTHS = [160, 240, 260] as const;
const ACTIVE_STATUSES = new Set(['created', 'running', 'gating']);

function loadWidths(): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as unknown;
    if (Array.isArray(value) && value.length === 3 && value.every((width) => typeof width === 'number' && Number.isFinite(width))) {
      return value.map((width, index) => Math.max(MIN_WIDTHS[index]!, width));
    }
  } catch { /* Use defaults when local storage is unavailable or malformed. */ }
  return [...DEFAULT_WIDTHS];
}

export function App() {
  const [widths, setWidths] = useState(loadWidths);
  const [bootError, setBootError] = useState<string>();
  const [aborting, setAborting] = useState(false);
  const activeRunId = useMatStore((state) => state.activeRunId);
  const activeRun = useMatStore((state) => state.activeRunId ? state.runs[state.activeRunId] : undefined);
  const selectedWorkspace = useMatStore((state) => state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId));
  const ws = useRef<ReconnectingWsClient>();

  useEffect(() => {
    let live = true;
    void Promise.all([apiClient.getWorkspaces(), apiClient.getWorkflows(), apiClient.getProviders()]).then(([workspaces, workflows, providers]) => {
      if (!live) return;
      const state = matStore.getState();
      state.setWorkspaces(workspaces); state.setWorkflows(workflows); state.setProviders(providers);
      if (!state.selectedWorkspaceId && workspaces[0]) state.setSelectedWorkspaceId(workspaces[0].id);
    }).catch((error: unknown) => { if (live) setBootError(error instanceof Error ? error.message : 'Could not load application data.'); });
    ws.current = new ReconnectingWsClient({ onMessage: (message) => matStore.getState().applyWsMsg(message) });
    ws.current.connect();
    return () => { live = false; ws.current?.close(); };
  }, []);

  useEffect(() => {
    if (!activeRunId) return;
    ws.current?.subscribe(activeRunId);
    return () => ws.current?.unsubscribe(activeRunId);
  }, [activeRunId]);

  useEffect(() => {
    try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths)); } catch { /* Resizing still works without persistence. */ }
  }, [widths]);

  const resize = (divider: number, start: ReactPointerEvent<HTMLDivElement>) => {
    start.preventDefault(); start.currentTarget.setPointerCapture(start.pointerId);
    const origin = start.clientX; const initial = [...widths];
    const move = (event: PointerEvent) => setWidths(() => resizeWidths(initial, divider, event.clientX - origin));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const resizeWithKeyboard = (divider: number, delta: number) => setWidths((current) => resizeWidths(current, divider, delta));

  const abort = async () => {
    if (!activeRun || !ACTIVE_STATUSES.has(activeRun.status)) return;
    setAborting(true); setBootError(undefined);
    try { matStore.getState().upsertRun(await apiClient.abortRun(activeRun.runId)); }
    catch (error) { setBootError(error instanceof Error ? error.message : 'Could not abort the run.'); }
    finally { setAborting(false); }
  };

  const columns = `${widths[0]}px 5px ${widths[1]}px 5px ${widths[2]}px 5px minmax(320px, 1fr)`;
  return <main className="grid h-screen min-w-[1000px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-zinc-950 text-ink">
    <header className="flex min-w-0 items-center gap-3 border-b border-border bg-zinc-950 px-4 py-2">
      <h1 className="shrink-0 text-sm font-semibold tracking-wide">Multi-AI Terminal</h1>
      <span className="truncate text-xs text-muted">{selectedWorkspace?.name ?? 'No workspace selected'}</span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {activeRun && <span className={`rounded-full border px-2 py-1 text-[11px] ${ACTIVE_STATUSES.has(activeRun.status) ? 'border-sky-800 bg-sky-950/40 text-sky-300' : 'border-border text-muted'}`}><span className={ACTIVE_STATUSES.has(activeRun.status) ? 'mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400' : ''} />{activeRun.status}</span>}
        {activeRun && ACTIVE_STATUSES.has(activeRun.status) && <button type="button" disabled={aborting} onClick={() => void abort()} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50">{aborting ? 'Aborting…' : 'Abort'}</button>}
      </div>
    </header>
    {bootError && <div role="alert" className="fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">{bootError}</div>}
    <div className="grid min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateColumns: columns }}>
      <div className="min-w-0 border-r border-border bg-panel"><WorkspacePanel /></div><Divider value={widths[0]!} onPointerDown={(event) => resize(0, event)} onDelta={(delta) => resizeWithKeyboard(0, delta)} />
      <div className="min-w-0 border-r border-border bg-panel"><WorkflowPanel /></div><Divider value={widths[1]!} onPointerDown={(event) => resize(1, event)} onDelta={(delta) => resizeWithKeyboard(1, delta)} />
      <div className="min-w-0 border-r border-border bg-panel"><RunPanel /></div><Divider value={widths[2]!} onPointerDown={(event) => resize(2, event)} onDelta={(delta) => resizeWithKeyboard(2, delta)} />
      <div className="min-w-0 bg-panel"><StreamPanel /></div>
    </div>
  </main>;
}

function resizeWidths(current: readonly number[], divider: number, delta: number): number[] {
  const next = [...current];
  if (divider < 2) {
    const left = Math.max(MIN_WIDTHS[divider]!, current[divider]! + delta);
    const actualDelta = left - current[divider]!;
    const right = Math.max(MIN_WIDTHS[divider + 1]!, current[divider + 1]! - actualDelta);
    const constrainedDelta = current[divider + 1]! - right;
    next[divider] = current[divider]! + constrainedDelta;
    next[divider + 1] = right;
  } else next[divider] = Math.max(MIN_WIDTHS[divider]!, current[divider]! + delta);
  return next;
}

function Divider({ value, onPointerDown, onDelta }: { value: number; onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void; onDelta(delta: number): void }) {
  return <div role="separator" tabIndex={0} aria-orientation="vertical" aria-valuenow={Math.round(value)} onPointerDown={onPointerDown} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); onDelta(-10); } else if (event.key === 'ArrowRight') { event.preventDefault(); onDelta(10); } }} className="cursor-col-resize bg-zinc-950 outline-none transition-colors hover:bg-accent focus:bg-accent" />;
}
