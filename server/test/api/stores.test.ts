import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureWorkspaceStore,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from '../../src/store/workspaces.js';
import {
  configureWorkflowStore,
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  listWorkflows,
  updateWorkflow,
} from '../../src/store/workflows.js';
import {
  configureRunStore,
  deleteRun,
  getRun,
  listRuns,
  saveRun,
} from '../../src/store/runs.js';
import { runSnapshot, workflow } from './helpers.js';

const dirs: string[] = [];
const temporaryDir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.sequential('workspace store', () => {
  it('validates paths, persists atomically, and refreshes git state on read', async () => {
    const dataDir = temporaryDir('mat-workspaces-');
    const workspaceDir = temporaryDir('mat-repo-');
    configureWorkspaceStore(dataDir);

    await expect(createWorkspace({ name: 'bad', path: 'relative' })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    const created = await createWorkspace({ name: 'Repo', path: workspaceDir });
    expect(created.isGit).toBe(false);
    expect(readFileSync(join(dataDir, 'workspaces.json'), 'utf8')).toContain(created.id);

    await mkdir(join(workspaceDir, '.git'));
    expect((await getWorkspace(created.id)).isGit).toBe(true);
    expect((await updateWorkspace(created.id, { name: 'Renamed' })).name).toBe('Renamed');
    await deleteWorkspace(created.id);
    expect(await listWorkspaces()).toEqual([]);
  });
});

describe.sequential('workflow store', () => {
  it('loads immutable builtins and supports validated custom CRUD plus duplicate', async () => {
    const dataDir = temporaryDir('mat-workflows-');
    configureWorkflowStore(dataDir);
    const builtins = await listWorkflows();
    expect(builtins.filter((item) => item.builtin)).toHaveLength(3);
    await expect(updateWorkflow('planning', { name: 'Nope' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(deleteWorkflow('planning')).rejects.toMatchObject({ code: 'CONFLICT' });

    const created = await createWorkflow(workflow());
    expect(created.builtin).toBeUndefined();
    expect((await updateWorkflow(created.id, { description: 'Changed' })).description).toBe('Changed');
    const duplicate = await duplicateWorkflow('planning');
    expect(duplicate).toMatchObject({ id: 'planning-copy', name: 'Planning Mode Copy' });
    expect(duplicate.builtin).toBeUndefined();
    await deleteWorkflow(created.id);
    expect((await listWorkflows()).some((item) => item.id === created.id)).toBe(false);
  });

  it('zod-validates custom workflow files on every read', async () => {
    const dataDir = temporaryDir('mat-workflows-invalid-');
    configureWorkflowStore(dataDir);
    await writeFile(join(dataDir, 'workflows', 'bad.json'), '{"id":"bad"}', { encoding: 'utf8', flag: 'w' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dataDir, 'workflows'), { recursive: true });
      await writeFile(join(dataDir, 'workflows', 'bad.json'), '{"id":"bad"}', 'utf8');
    });
    await expect(listWorkflows()).rejects.toMatchObject({ code: 'INVALID_DATA' });
  });
});

describe.sequential('run store', () => {
  it('atomically persists snapshots and lists newest-first with a createdAt cursor', async () => {
    const dataDir = temporaryDir('mat-runs-');
    configureWorkspaceStore(dataDir);
    configureRunStore(dataDir);
    await saveRun(runSnapshot({ runId: 'old', createdAt: 10, endedAt: 11 }));
    await saveRun(runSnapshot({ runId: 'new', createdAt: 20, endedAt: 21 }));
    expect((await getRun('new')).runId).toBe('new');
    expect((await listRuns('workspace-1')).map((run) => run.runId)).toEqual(['new', 'old']);
    expect((await listRuns('workspace-1', 50, 20)).map((run) => run.runId)).toEqual(['old']);
    expect(readFileSync(join(dataDir, 'runs', 'new', 'run.json'), 'utf8')).toContain('"runId": "new"');
  });

  it('rejects deleting non-terminal runs and removes terminal run directories', async () => {
    const dataDir = temporaryDir('mat-run-delete-');
    configureWorkspaceStore(dataDir);
    configureRunStore(dataDir);
    await saveRun(runSnapshot({ runId: 'active', status: 'running', endedAt: undefined } as Partial<ReturnType<typeof runSnapshot>>));
    await expect(deleteRun('active')).rejects.toMatchObject({ code: 'CONFLICT' });
    await saveRun(runSnapshot({ runId: 'finished' }));
    await deleteRun('finished');
    await expect(getRun('finished')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('retains only the newest 100 runs per workspace and invokes cleanup', async () => {
    const dataDir = temporaryDir('mat-run-retention-');
    const cleaned: string[] = [];
    configureWorkspaceStore(dataDir);
    configureRunStore(dataDir, { cleanupRun: async (runId) => { cleaned.push(runId); } });
    for (let index = 0; index < 101; index += 1) {
      await saveRun(runSnapshot({ runId: `run-${String(index).padStart(3, '0')}`, createdAt: index, endedAt: index + 1 }));
    }
    expect(await listRuns('workspace-1', 200)).toHaveLength(100);
    expect(cleaned).toEqual(['run-000']);
    await expect(getRun('run-000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
