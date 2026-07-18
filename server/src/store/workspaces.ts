import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceSchema, type Workspace } from '@mat/shared';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { resolveDataDir } from './dataDir.js';

const execFileAsync = promisify(execFile);
const WorkspaceListSchema = z.array(WorkspaceSchema);
export type WorkspaceSubscriber = () => void;

export class WorkspaceStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_PATH' | 'CONFLICT' | 'INVALID_DATA', message: string) {
    super(message);
    this.name = 'WorkspaceStoreError';
  }
}

let dataDir: string | undefined;
let mutationQueue: Promise<void> = Promise.resolve();
const subscribers = new Set<WorkspaceSubscriber>();

export function configureWorkspaceStore(nextDataDir: string): void {
  dataDir = nextDataDir;
}

export function subscribeWorkspaceChanges(subscriber: WorkspaceSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return enqueue(async () => {
    const workspaces = await readAll();
    const refreshed = await Promise.all(workspaces.map(refreshGitState));
    if (refreshed.some((workspace, index) => workspace.isGit !== workspaces[index]?.isGit)) {
      await writeAll(refreshed);
      notifySubscribers();
    }
    return refreshed;
  });
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const workspace = (await listWorkspaces()).find((candidate) => candidate.id === id);
  if (!workspace) throw new WorkspaceStoreError('NOT_FOUND', `Workspace not found: ${id}`);
  return workspace;
}

export async function createWorkspace(value: Omit<Workspace, 'id' | 'isGit'>): Promise<Workspace> {
  const normalizedPath = await validateWorkspacePath(value.path);
  const workspace = WorkspaceSchema.parse({ ...value, id: nanoid(), path: normalizedPath, isGit: await computeIsGit(normalizedPath) }) as Workspace;
  await mutate(async (workspaces) => [...workspaces, workspace]);
  return workspace;
}

export async function updateWorkspace(id: string, value: Partial<Pick<Workspace, 'name' | 'path' | 'defaultWorkflowId'>>): Promise<Workspace> {
  let updated: Workspace | undefined;
  await mutate(async (workspaces) => {
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceStoreError('NOT_FOUND', `Workspace not found: ${id}`);
    const current = workspaces[index]!;
    const nextPath = value.path === undefined ? current.path : await validateWorkspacePath(value.path);
    const candidate: Record<string, unknown> = {
      ...current,
      ...value,
      path: nextPath,
      isGit: await computeIsGit(nextPath),
    };
    if (value.defaultWorkflowId === undefined && Object.hasOwn(value, 'defaultWorkflowId')) delete candidate.defaultWorkflowId;
    updated = WorkspaceSchema.parse(candidate) as Workspace;
    const next = [...workspaces];
    next[index] = updated;
    return next;
  });
  return updated!;
}

export async function updateWorkspaceLastRun(id: string, lastRun: NonNullable<Workspace['lastRun']>): Promise<void> {
  await mutate(async (workspaces) => {
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) return workspaces;
    const current = workspaces[index]!;
    const next = [...workspaces];
    next[index] = WorkspaceSchema.parse({ ...current, lastRun }) as Workspace;
    return next;
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await mutate(async (workspaces) => {
    const next = workspaces.filter((workspace) => workspace.id !== id);
    if (next.length === workspaces.length) throw new WorkspaceStoreError('NOT_FOUND', `Workspace not found: ${id}`);
    return next;
  });
}

async function validateWorkspacePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new WorkspaceStoreError('INVALID_PATH', 'Workspace path must be absolute');
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new WorkspaceStoreError('INVALID_PATH', `Workspace path is not a directory: ${path}`);
  } catch (error) {
    if (error instanceof WorkspaceStoreError) throw error;
    throw new WorkspaceStoreError('INVALID_PATH', `Workspace path does not exist: ${path}`);
  }
  return path;
}

async function computeIsGit(path: string): Promise<boolean> {
  try {
    const marker = await stat(join(path, '.git'));
    if (marker.isDirectory() || marker.isFile()) return true;
  } catch { /* A nested worktree may still be inside a repository; ask git below. */ }
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function refreshGitState(workspace: Workspace): Promise<Workspace> {
  return { ...workspace, isGit: await computeIsGit(workspace.path) };
}

function storePath(): string {
  return join(dataDir ?? resolveDataDir(), 'workspaces.json');
}

async function readAll(): Promise<Workspace[]> {
  try {
    return WorkspaceListSchema.parse(JSON.parse(await readFile(storePath(), 'utf8'))) as Workspace[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new WorkspaceStoreError('INVALID_DATA', 'workspaces.json contains invalid data');
    }
    throw error;
  }
}

async function mutate(operation: (workspaces: Workspace[]) => Promise<Workspace[]>): Promise<void> {
  return enqueue(async () => {
    const current = await readAll();
    const candidate = await operation(current);
    if (candidate === current) return;
    const next = WorkspaceListSchema.parse(candidate) as Workspace[];
    await writeAll(next);
    notifySubscribers();
  });
}

async function writeAll(workspaces: Workspace[]): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${nanoid()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workspaces, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function notifySubscribers(): void {
  for (const subscriber of [...subscribers]) {
    try { subscriber(); } catch { /* Persistence must remain successful if an invalidation listener fails. */ }
  }
}

async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(operation);
  mutationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}
