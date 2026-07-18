import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';
import { ReconnectingWsClient } from '../api/ws.js';
import { RunPanel } from '../panels/run/RunPanel.js';
import { StreamPanel } from '../panels/stream/StreamPanel.js';
import { WorkflowPanel } from '../panels/workflow/WorkflowPanel.js';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel.js';
import { matStore, useMatStore } from './store.js';

export function App() {
  const [widths, setWidths] = useState([210, 320, 390, 1]);
  const activeRunId = useMatStore((state) => state.activeRunId);
  const ws = useRef<ReconnectingWsClient>();
  useEffect(() => {
    void Promise.all([apiClient.getWorkspaces(), apiClient.getWorkflows(), apiClient.getProviders()]).then(([workspaces, workflows, providers]) => {
      matStore.getState().setWorkspaces(workspaces); matStore.getState().setWorkflows(workflows); matStore.getState().setProviders(providers);
    }).catch(() => undefined);
    ws.current = new ReconnectingWsClient({ onMessage: (message) => matStore.getState().applyWsMsg(message) }); ws.current.connect();
    return () => ws.current?.close();
  }, []);
  useEffect(() => { if (!activeRunId) return; ws.current?.subscribe(activeRunId); return () => ws.current?.unsubscribe(activeRunId); }, [activeRunId]);

  const resize = (divider: number, start: React.PointerEvent<HTMLDivElement>) => {
    start.currentTarget.setPointerCapture(start.pointerId); const origin = start.clientX; const initial = [...widths];
    const move = (event: PointerEvent) => setWidths(() => { const next = [...initial]; const delta = event.clientX - origin; next[divider] = Math.max(150, initial[divider]! + delta); if (divider < 2) next[divider + 1] = Math.max(200, initial[divider + 1]! - delta); return next; });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const columns = `${widths[0]}px 5px ${widths[1]}px 5px ${widths[2]}px 5px minmax(320px, 1fr)`;
  return <main className="grid h-screen min-w-[1000px] overflow-hidden bg-zinc-950 text-ink" style={{ gridTemplateColumns: columns }}>
    <div className="min-w-0 border-r border-border bg-panel"><WorkspacePanel /></div><Divider onPointerDown={(event) => resize(0, event)} />
    <div className="min-w-0 border-r border-border bg-panel"><WorkflowPanel /></div><Divider onPointerDown={(event) => resize(1, event)} />
    <div className="min-w-0 border-r border-border bg-panel"><RunPanel /></div><Divider onPointerDown={(event) => resize(2, event)} />
    <div className="min-w-0 bg-panel"><StreamPanel /></div>
  </main>;
}

function Divider({ onPointerDown }: { onPointerDown(event: React.PointerEvent<HTMLDivElement>): void }) { return <div role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} className="cursor-col-resize bg-zinc-950 transition-colors hover:bg-accent" />; }
