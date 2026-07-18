import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/index.js';
import { saveRun } from '../../src/store/runs.js';
import { runSnapshot, workflow } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

// INTEGRATION: enable when engine lands
describe.skip('API lifecycle with the real run manager', () => {
  it('auto-starts a mock-provider run, persists workflowOverride, and replays its events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-engine-api-'));
    dirs.push(dataDir);
    const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    await app.ready();
    try {
      const workspaceResponse = await app.inject({
        method: 'POST', url: '/api/workspaces', payload: { name: 'Temp', path: tmpdir() },
      });
      const workspaceId = workspaceResponse.json().id as string;
      const override = workflow({ id: 'ephemeral', name: 'Ephemeral Mock' });
      const createdResponse = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { workspaceId, workflowId: 'planning', task: 'MOCK_REPLY: finished', workflowOverride: override },
      });
      expect(createdResponse.statusCode).toBe(201);
      const runId = createdResponse.json().runId as string;

      let persisted = createdResponse.json();
      for (let attempt = 0; attempt < 100 && !['done', 'failed', 'aborted'].includes(persisted.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        persisted = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
      }
      expect(persisted.status).toBe('done');
      expect(persisted.workflow).toEqual(override);
      const events = (await app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterSeq=0&limit=1000` })).json();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', kind: 'message' }),
        expect.objectContaining({ role: 'agent', kind: 'message' }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('reports a three-way patch conflict without partially modifying the workspace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-apply-api-'));
    const workspaceDir = mkdtempSync(join(tmpdir(), 'mat-apply-repo-'));
    dirs.push(dataDir, workspaceDir);
    execFileSync('git', ['init', '-q', workspaceDir]);
    execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'mat@example.test']);
    execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'MAT Test']);
    await writeFile(join(workspaceDir, 'file.txt'), 'base\n', 'utf8');
    execFileSync('git', ['-C', workspaceDir, 'add', 'file.txt']);
    execFileSync('git', ['-C', workspaceDir, 'commit', '-qm', 'base']);

    const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    await app.ready();
    try {
      const workspace = (await app.inject({
        method: 'POST', url: '/api/workspaces', payload: { name: 'Repo', path: workspaceDir },
      })).json();
      const run = runSnapshot({ workspaceId: workspace.id });
      await mkdir(join(dataDir, 'runs', run.runId, 'artifacts'), { recursive: true });
      await writeFile(join(dataDir, 'runs', run.runId, 'artifacts', 'stage-1.slot-1.0.a1.patch'), [
        'diff --git a/file.txt b/file.txt',
        'index df967b9..f2ad6c7 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1 +1 @@',
        '-base',
        '+candidate',
        '',
      ].join('\n'), 'utf8');
      await saveRun(run);
      await writeFile(join(workspaceDir, 'file.txt'), 'local change\n', 'utf8');

      const response = await app.inject({
        method: 'POST', url: `/api/runs/${run.runId}/nodes/stage-1.slot-1.0/apply-patch`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: false, conflicts: expect.any(Array) });
      expect(readFileSync(join(workspaceDir, 'file.txt'), 'utf8')).toBe('local change\n');
    } finally {
      await app.close();
    }
  });
});
