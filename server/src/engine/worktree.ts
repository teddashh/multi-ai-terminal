import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { execFile } from '../execFile.js';
import { getDataDir } from '../store/dataDir.js';
import type { RunSnapshot } from '@mat/shared';
import { getRun } from '../store/runs.js';
import { getWorkspace } from '../store/workspaces.js';

export interface WorktreeResult { cwd: string; baseCommit: string; branch: string }

export const engineDataDir = (): string => getDataDir();
export const runDirectory = (runId: string): string => join(engineDataDir(), 'runs', runId);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

async function bestEffortGit(cwd: string, args: string[]): Promise<void> {
  try { await git(cwd, args); } catch { /* Absence is the desired state for retry cleanup. */ }
}

export async function isGitRepository(workspacePath: string): Promise<boolean> {
  try { return (await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])) === 'true'; } catch { return false; }
}

export async function isWorkspaceDirty(workspacePath: string): Promise<boolean> {
  try { return (await git(workspacePath, ['status', '--porcelain'])).length > 0; } catch { return false; }
}

export async function createWorktree(workspacePath: string, runId: string, nodeRunId: string, attempt: number): Promise<WorktreeResult> {
  const cwd = join(runDirectory(runId), 'wt', `${nodeRunId}.a${attempt}`);
  const branch = `mat/${runId}/${nodeRunId}-a${attempt}`;
  await mkdir(join(runDirectory(runId), 'wt'), { recursive: true });
  await bestEffortGit(workspacePath, ['worktree', 'remove', '--force', cwd]);
  await rm(cwd, { recursive: true, force: true });
  await bestEffortGit(workspacePath, ['branch', '-D', branch]);
  await git(workspacePath, ['worktree', 'add', cwd, '-b', branch, 'HEAD']);
  const baseCommit = await git(cwd, ['rev-parse', 'HEAD']);
  return { cwd, baseCommit, branch };
}

export async function collectPatch(cwd: string, baseCommit: string, patchPath: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  const patch = await gitRaw(cwd, ['diff', '--cached', '--binary', baseCommit]);
  await mkdir(dirname(patchPath), { recursive: true });
  const temporary = join(dirname(patchPath), `.${process.pid}.${nanoid()}.patch.tmp`);
  await writeFile(temporary, patch, 'utf8');
  await rename(temporary, patchPath);
}

export async function pruneRunWorktrees(workspacePath: string, runId: string): Promise<void> {
  const root = join(runDirectory(runId), 'wt');
  let names: string[] = [];
  try { names = await readdir(root); } catch { /* No worktrees were made. */ }
  for (const name of names) {
    const cwd = join(root, name);
    await bestEffortGit(workspacePath, ['worktree', 'remove', '--force', cwd]);
    const match = /^(.*)\.a(\d+)$/.exec(name);
    if (match) await bestEffortGit(workspacePath, ['branch', '-D', `mat/${runId}/${match[1]}-a${match[2]}`]);
    await rm(cwd, { recursive: true, force: true });
  }
  await bestEffortGit(workspacePath, ['worktree', 'prune']);
  try {
    const branches = (await git(workspacePath, ['branch', '--list', `mat/${runId}/*`, '--format=%(refname:short)']))
      .split('\n').map((branch) => branch.trim()).filter(Boolean);
    for (const branch of branches) await bestEffortGit(workspacePath, ['branch', '-D', branch]);
  } catch { /* A damaged/non-git workspace must not block run cleanup. */ }
  await rm(root, { recursive: true, force: true });
}

export async function pruneWorktrees(runId: string, snapshot?: RunSnapshot): Promise<void> {
  const run = snapshot ?? await getRun(runId);
  const workspace = await getWorkspace(run.workspaceId);
  await pruneRunWorktrees(workspace.path, runId);
}

export async function readPatch(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
