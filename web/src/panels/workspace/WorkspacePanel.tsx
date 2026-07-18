import { useMatStore } from '../../app/store.js';

export function WorkspacePanel() {
  const workspaces = useMatStore((state) => state.workspaces); const selected = useMatStore((state) => state.selectedWorkspaceId); const select = useMatStore((state) => state.setSelectedWorkspaceId);
  return <section className="h-full overflow-auto p-3"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Workspaces</h2><div className="space-y-2">{workspaces.map((workspace) => <button key={workspace.id} onClick={() => select(workspace.id)} className={`w-full rounded border p-2 text-left ${selected === workspace.id ? 'border-accent bg-violet-950/20' : 'border-border bg-zinc-900/40'}`}><span className="block text-sm font-medium">{workspace.name}</span><span className="block truncate text-xs text-muted">{workspace.path}</span>{workspace.lastRun && <span className="mt-1 block text-[11px] text-muted">{workspace.lastRun.workflowName} · {workspace.lastRun.status}</span>}</button>)}</div>{workspaces.length === 0 && <p className="text-xs text-muted">No workspaces loaded.</p>}</section>;
}
