import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { apiClient, type ApiClient } from '../../api/client.js';
import { ACTIVE_RUN_STATUSES, useMatStore } from '../../app/store.js';
import { ModalDialog } from '../../components/ModalDialog.js';
import { useUiPreferences } from '../../i18n/UiPreferences.js';
import { isAbsolutePath, lastRunBadge, shortPath } from './logic.js';

export interface WorkspacePanelProps { api?: ApiClient }

function dialogErrorDetail(error: unknown): string | undefined {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : undefined;
  const clean = detail?.trim();
  return clean ? clean.slice(0, 500) : undefined;
}

export function WorkspacePanel({ api = apiClient }: WorkspacePanelProps) {
  const { locale, t } = useUiPreferences();
  const workspaces = useMatStore((state) => state.workspaces);
  const selected = useMatStore((state) => state.selectedWorkspaceId);
  const runs = useMatStore((state) => state.runs);
  const select = useMatStore((state) => state.setSelectedWorkspaceId);
  const setWorkspaces = useMatStore((state) => state.setWorkspaces);
  const [now, setNow] = useState(Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [verifyCommand, setVerifyCommand] = useState('');
  const [verifyTimeout, setVerifyTimeout] = useState('');
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const tauri = '__TAURI_INTERNALS__' in window;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const liveWorkspaceIds = useMemo(() => new Set(Object.values(runs)
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
    .map((run) => run.workspaceId)), [runs]);

  const closeDialog = () => {
    if (saving) return;
    setAddOpen(false); setEditingId(undefined); setFormError(undefined);
  };

  const openAdd = () => {
    setName(''); setPath(''); setVerifyCommand(''); setVerifyTimeout(''); setEditingId(undefined); setAddOpen(true); setFormError(undefined);
  };

  const openEdit = (id: string) => {
    const workspace = workspaces.find((candidate) => candidate.id === id);
    if (!workspace) return;
    setName(workspace.name); setPath(workspace.path); setVerifyCommand(workspace.verifyCommand ?? '');
    setVerifyTimeout(workspace.verifyTimeoutSec === undefined ? '' : String(workspace.verifyTimeoutSec));
    setEditingId(id); setAddOpen(false); setFormError(undefined);
  };

  const submitWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim(); const cleanPath = path.trim();
    if (!cleanName) { setFormError(t('workspace.nameRequired')); return; }
    if (!isAbsolutePath(cleanPath)) { setFormError(t('workspace.pathAbsolute')); return; }
    const timeout = verifyTimeout.trim() === '' ? undefined : Number(verifyTimeout);
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) { setFormError(t('workspace.timeoutPositive')); return; }
    setSaving(true); setFormError(undefined);
    try {
      if (editingId) {
        const workspace = await api.updateWorkspace(editingId, {
          name: cleanName,
          verifyCommand: verifyCommand.trim() || null,
          verifyTimeoutSec: timeout ?? null,
        });
        setWorkspaces(workspaces.map((candidate) => candidate.id === editingId ? workspace : candidate));
      } else {
        const workspace = await api.createWorkspace({
          name: cleanName, path: cleanPath,
          ...(verifyCommand.trim() ? { verifyCommand: verifyCommand.trim() } : {}),
          ...(timeout === undefined ? {} : { verifyTimeoutSec: timeout }),
        });
        setWorkspaces([...workspaces, workspace]);
        select(workspace.id);
      }
      setName(''); setPath(''); setVerifyCommand(''); setVerifyTimeout(''); setAddOpen(false); setEditingId(undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('workspace.addFailed'));
    } finally { setSaving(false); }
  };

  const browse = async () => {
    setFormError(undefined);
    try {
      const directory = await openDialog({ directory: true, multiple: false });
      if (typeof directory === 'string') setPath(directory);
    } catch (error) {
      const detail = dialogErrorDetail(error);
      const summary = t('workspace.browseFailed');
      setFormError(detail && detail !== summary ? `${summary} ${detail}` : summary);
    }
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
      setDeleteError(error instanceof Error ? error.message : t('workspace.deleteFailed'));
    }
  };

  return <section aria-labelledby="workspace-heading" className="flex h-full min-h-0 flex-col">
    <header className="flex items-center justify-between border-b border-border px-3 py-3">
      <h2 id="workspace-heading" className="text-xs font-semibold uppercase tracking-wider text-muted">{t('workspace.title')}</h2>
      <button type="button" onClick={openAdd} className="rounded border border-border px-2 py-1 text-xs text-ink hover:border-accent" aria-label={t('workspace.addLabel')}>{t('workspace.add')}</button>
    </header>
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {workspaces.map((workspace) => {
        const isSelected = selected === workspace.id;
        const isLive = liveWorkspaceIds.has(workspace.id) || workspace.lastRun?.status === 'created' || workspace.lastRun?.status === 'running' || workspace.lastRun?.status === 'gating';
        return <article key={workspace.id} className={`rounded border ${isSelected ? 'border-accent bg-accentSoft/50' : 'border-border bg-surface/60'}`}>
          <button type="button" onClick={() => select(workspace.id)} className="w-full p-2 text-left" aria-pressed={isSelected}>
            <span className="flex items-center gap-2">
              {isLive && <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" aria-label={t('workspace.runProgress')} />}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span>
              <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${workspace.isGit ? 'border-emerald-800 text-emerald-300' : 'border-border text-muted'}`}>{workspace.isGit ? 'git' : t('workspace.folder')}</span>
            </span>
            <span className="mt-1 block truncate text-xs text-muted" title={workspace.path}>{shortPath(workspace.path)}</span>
            {workspace.lastRun && <span className="mt-1 block truncate text-[11px] text-muted">{lastRunBadge(workspace.lastRun, now, locale)}</span>}
          </button>
          <div className="flex items-center justify-end gap-3 border-t border-border/70 px-2 py-1.5 text-right">
            <button type="button" className="text-[11px] text-muted hover:text-ink" onClick={() => openEdit(workspace.id)}>{t('workspace.edit')}</button>
            {confirmDelete === workspace.id
              ? <span className="inline-flex items-center gap-2 text-[11px]"><span className="text-muted">{t('workspace.deleteQuestion')}</span><button type="button" className="text-red-300 hover:text-red-200" onClick={() => void deleteWorkspace(workspace.id)}>{t('workspace.yes')}</button><button type="button" className="text-muted hover:text-ink" onClick={() => setConfirmDelete(undefined)}>{t('workspace.no')}</button></span>
              : <button type="button" className="text-[11px] text-muted hover:text-red-300" onClick={() => { setConfirmDelete(workspace.id); setDeleteError(undefined); }}>{t('workspace.delete')}</button>}
          </div>
        </article>;
      })}
      {workspaces.length === 0 && <p className="text-xs text-muted">{t('workspace.empty')}</p>}
      {deleteError && <p role="alert" className="text-xs text-red-300">{deleteError}</p>}
    </div>

    <ModalDialog open={addOpen || editingId !== undefined} title={editingId ? t('workspace.editTitle') : t('workspace.addTitle')} onClose={closeDialog} footer={<div className="flex justify-end gap-2"><button type="button" onClick={closeDialog} className="rounded px-3 py-1.5 text-sm text-muted hover:bg-raised">{t('workspace.cancel')}</button><button type="submit" form="workspace-form" disabled={saving} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-onAccent disabled:opacity-50">{saving ? t('workspace.saving') : editingId ? t('workspace.save') : t('workspace.addLabel')}</button></div>}>
      <form id="workspace-form" aria-label={editingId ? t('workspace.editTitle') : t('workspace.addTitle')} onSubmit={(event) => void submitWorkspace(event)} className="space-y-4">
        <label className="block text-sm"><span className="mb-1 block text-muted">{t('workspace.name')}</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded border border-border bg-canvas px-3 py-2 text-ink outline-none focus:border-accent" /></label>
        <label className="block text-sm"><span className="mb-1 block text-muted">{t('workspace.absolutePath')}</span><span className="flex gap-2"><input required disabled={editingId !== undefined} value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/ted/projects/example" className="min-w-0 flex-1 rounded border border-border bg-canvas px-3 py-2 text-ink outline-none focus:border-accent disabled:opacity-60" />{tauri && editingId === undefined && <button type="button" onClick={() => void browse()} className="rounded border border-border px-3 py-2 text-xs text-ink hover:border-accent">{t('workspace.browse')}</button>}</span></label>
        <label className="block text-sm"><span className="mb-1 block text-muted">{t('workspace.verifyCommand')}</span><input value={verifyCommand} onChange={(event) => setVerifyCommand(event.target.value)} placeholder="npm test" className="w-full rounded border border-border bg-canvas px-3 py-2 font-mono text-ink outline-none focus:border-accent" /></label>
        <label className="block text-sm"><span className="mb-1 block text-muted">{t('workspace.verifyTimeout')}</span><input type="number" min={1} step={1} value={verifyTimeout} onChange={(event) => setVerifyTimeout(event.target.value)} placeholder="600" className="w-full rounded border border-border bg-canvas px-3 py-2 text-ink outline-none focus:border-accent" /></label>
        {formError && <p role="alert" className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{formError}</p>}
      </form>
    </ModalDialog>
  </section>;
}
