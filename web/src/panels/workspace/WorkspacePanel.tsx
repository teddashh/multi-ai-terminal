import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiClient, type ApiClient } from '../../api/client.js';
import { useMatStore } from '../../app/store.js';
import { ModalDialog } from '../../components/ModalDialog.js';
import { isAbsolutePath, lastRunBadge, shortPath } from './logic.js';

const ACTIVE_STATUSES = new Set(['created', 'running', 'gating']);

export interface WorkspacePanelProps { api?: ApiClient }

export function WorkspacePanel({ api = apiClient }: WorkspacePanelProps) {
  const workspaces = useMatStore((state) => state.workspaces);
  const selected = useMatStore((state) => state.selectedWorkspaceId);
  const runs = useMatStore((state) => state.runs);
  const select = useMatStore((state) => state.setSelectedWorkspaceId);
  const setWorkspaces = useMatStore((state) => state.setWorkspaces);
  const [now, setNow] = useState(Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const liveWorkspaceIds = useMemo(() => new Set(Object.values(runs)
    .filter((run) => ACTIVE_STATUSES.has(run.status))
    .map((run) => run.workspaceId)), [runs]);

  const closeAdd = () => {
    if (saving) return;
    setAddOpen(false); setFormError(undefined);
  };

  const submitWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim(); const cleanPath = path.trim();
    if (!cleanName) { setFormError('Name is required.'); return; }
    if (!isAbsolutePath(cleanPath)) { setFormError('Path must be absolute.'); return; }
    setSaving(true); setFormError(undefined);
    try {
      const workspace = await api.createWorkspace({ name: cleanName, path: cleanPath });
      setWorkspaces([...workspaces, workspace]);
      select(workspace.id);
      setName(''); setPath(''); setAddOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not add workspace.');
    } finally { setSaving(false); }
  };

  const deleteWorkspace = async (id: string) => {
    setDeleteError(undefined);
    try {
      await api.deleteWorkspace(id);
      const remaining = workspaces.filter((workspace) => workspace.id !== id);
      setWorkspaces(remaining);
      if (selected === id) select(remaining[0]?.id);
      setConfirmDelete(undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete workspace.');
    }
  };

  return <section aria-labelledby="workspace-heading" className="flex h-full min-h-0 flex-col">
    <header className="flex items-center justify-between border-b border-border px-3 py-3">
      <h2 id="workspace-heading" className="text-xs font-semibold uppercase tracking-wider text-muted">Workspaces</h2>
      <button type="button" onClick={() => setAddOpen(true)} className="rounded border border-border px-2 py-1 text-xs text-ink hover:border-accent" aria-label="Add workspace">+ Add</button>
    </header>
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {workspaces.map((workspace) => {
        const isSelected = selected === workspace.id;
        const isLive = liveWorkspaceIds.has(workspace.id) || workspace.lastRun?.status === 'created' || workspace.lastRun?.status === 'running' || workspace.lastRun?.status === 'gating';
        return <article key={workspace.id} className={`rounded border ${isSelected ? 'border-accent bg-violet-950/20' : 'border-border bg-zinc-900/40'}`}>
          <button type="button" onClick={() => select(workspace.id)} className="w-full p-2 text-left" aria-pressed={isSelected}>
            <span className="flex items-center gap-2">
              {isLive && <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" aria-label="Run in progress" />}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span>
              <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${workspace.isGit ? 'border-emerald-800 text-emerald-300' : 'border-zinc-700 text-muted'}`}>{workspace.isGit ? 'git' : 'folder'}</span>
            </span>
            <span className="mt-1 block truncate text-xs text-muted" title={workspace.path}>{shortPath(workspace.path)}</span>
            {workspace.lastRun && <span className="mt-1 block truncate text-[11px] text-muted">{lastRunBadge(workspace.lastRun, now)}</span>}
          </button>
          <div className="border-t border-border/70 px-2 py-1.5 text-right">
            {confirmDelete === workspace.id
              ? <span className="inline-flex items-center gap-2 text-[11px]"><span className="text-muted">Delete?</span><button type="button" className="text-red-300 hover:text-red-200" onClick={() => void deleteWorkspace(workspace.id)}>Yes</button><button type="button" className="text-muted hover:text-ink" onClick={() => setConfirmDelete(undefined)}>No</button></span>
              : <button type="button" className="text-[11px] text-muted hover:text-red-300" onClick={() => { setConfirmDelete(workspace.id); setDeleteError(undefined); }}>Delete</button>}
          </div>
        </article>;
      })}
      {workspaces.length === 0 && <p className="text-xs text-muted">No workspaces yet. Add a repository or folder to begin.</p>}
      {deleteError && <p role="alert" className="text-xs text-red-300">{deleteError}</p>}
    </div>

    <ModalDialog open={addOpen} title="Add workspace" onClose={closeAdd} footer={<div className="flex justify-end gap-2"><button type="button" onClick={closeAdd} className="rounded px-3 py-1.5 text-sm text-muted hover:bg-zinc-800">Cancel</button><button type="submit" form="add-workspace-form" disabled={saving} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-zinc-950 disabled:opacity-50">{saving ? 'Adding…' : 'Add workspace'}</button></div>}>
      <form id="add-workspace-form" aria-label="Add workspace" onSubmit={(event) => void submitWorkspace(event)} className="space-y-4">
        <label className="block text-sm"><span className="mb-1 block text-muted">Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded border border-border bg-zinc-950 px-3 py-2 text-ink outline-none focus:border-accent" /></label>
        <label className="block text-sm"><span className="mb-1 block text-muted">Absolute path</span><input required value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/ted/projects/example" className="w-full rounded border border-border bg-zinc-950 px-3 py-2 text-ink outline-none focus:border-accent" /></label>
        {formError && <p role="alert" className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{formError}</p>}
      </form>
    </ModalDialog>
  </section>;
}
