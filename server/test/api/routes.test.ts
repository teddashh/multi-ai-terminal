import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApiRoutes, type ApiRouteDependencies } from '../../src/api/routes.js';
import { configureRunStore, getRun, saveRun } from '../../src/store/runs.js';
import { configureWorkspaceStore } from '../../src/store/workspaces.js';
import { fakeApiDependencies, runSnapshot, workflow } from './helpers.js';

let app: FastifyInstance;
let dependencies: ApiRouteDependencies;
const dirs: string[] = [];

beforeEach(async () => {
  dependencies = fakeApiDependencies();
  app = fastify();
  await registerApiRoutes(app, dependencies);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('health endpoint', () => {
  it('reports ok with the version kept in sync with server/package.json', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: manifest.version });
  });
});

describe('workspace and workflow routes', () => {
  it('performs workspace CRUD and returns validation errors in the API envelope', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '', path: tmpdir() } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const created = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Temp', path: tmpdir() } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${id}` })).json()).toMatchObject({ name: 'Temp' });
    expect((await app.inject({ method: 'PATCH', url: `/api/workspaces/${id}`, payload: { name: 'Changed' } })).json()).toMatchObject({ name: 'Changed' });
    expect((await app.inject({ method: 'DELETE', url: `/api/workspaces/${id}` })).statusCode).toBe(204);
  });

  it('sets and clears workspace verification settings with null', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Verified', path: tmpdir(), verifyCommand: 'npm test', verifyTimeoutSec: 30 } });
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({ verifyCommand: 'npm test', verifyTimeoutSec: 30 });
    const cleared = await app.inject({ method: 'PATCH', url: `/api/workspaces/${id}`, payload: { verifyCommand: null, verifyTimeoutSec: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().verifyCommand).toBeUndefined();
    expect(cleared.json().verifyTimeoutSec).toBeUndefined();
  });

  it('surfaces builtin mutation conflicts and duplicates workflows', async () => {
    dependencies.workflows.update = async () => { throw Object.assign(new Error('Builtin workflow is immutable: planning'), { code: 'CONFLICT' }); };
    const conflict = await app.inject({ method: 'PATCH', url: '/api/workflows/planning', payload: { name: 'Changed' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: 'CONFLICT', message: 'Builtin workflow is immutable: planning' } });

    const duplicate = await app.inject({ method: 'POST', url: '/api/workflows/custom/duplicate' });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({ id: 'custom-copy', name: 'Custom Copy' });
  });
});

describe('run routes', () => {
  it('zod-validates create requests and preserves a complete workflowOverride', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-route-create-'));
    dirs.push(dataDir);
    configureWorkspaceStore(dataDir);
    configureRunStore(dataDir);
    const create = vi.fn(async (request) => {
      const created = runSnapshot({
        workspaceId: request.workspaceId,
        task: request.task,
        workflow: request.workflowOverride ?? workflow({ id: request.workflowId }),
        status: 'created',
        endedAt: undefined,
      } as Partial<ReturnType<typeof runSnapshot>>);
      await saveRun(created);
      return created;
    });
    dependencies.runs.create = create;
    const invalid = await app.inject({ method: 'POST', url: '/api/runs', payload: { workspaceId: 'w', workflowId: 'custom', task: '' } });
    expect(invalid.statusCode).toBe(400);

    const override = workflow({ id: 'ephemeral', name: 'Ephemeral' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workspaceId: 'workspace-1', workflowId: 'planning', task: 'Build it', workflowOverride: override },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().workflow).toEqual(override);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'planning', workflowOverride: override }));
    expect((await getRun('run-1')).workflow).toEqual(override);

    for (const [label, mutate] of [
      ['workflow', (value: ReturnType<typeof workflow>) => { value.id = '../escape'; }],
      ['stage', (value: ReturnType<typeof workflow>) => { value.stages[0]!.id = '../../escape'; }],
      ['slot', (value: ReturnType<typeof workflow>) => { value.stages[0]!.slots[0]!.id = 'slot/escape'; }],
    ] as const) {
      const traversal = workflow({ id: 'safe' });
      mutate(traversal);
      const rejected = await app.inject({ method: 'POST', url: '/api/runs', payload: { workspaceId: 'workspace-1', workflowId: 'planning', task: 'Build it', workflowOverride: traversal } });
      expect(rejected.statusCode, `${label} traversal should fail validation`).toBe(400);
      expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('rejects a run when a bound provider is unavailable', async () => {
    dependencies.providers = async () => [{ id: 'grok', tier: 'rich', ok: false, detail: 'not installed', installable: true, models: ['grok'], defaultModel: 'grok' }];
    const override = workflow({
      stages: [{ ...workflow().stages[0]!, slots: [{ ...workflow().stages[0]!.slots[0]!, label: 'Reviewer', agent: { provider: 'grok', permission: 'safe' } }] }],
    });
    const response = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: { workspaceId: 'workspace-1', workflowId: 'custom', task: 'Build it', workflowOverride: override },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Reviewer · grok unavailable: not installed' } });
  });

  it('returns provider versions and snapshots bound versions at run creation', async () => {
    dependencies.providers = async () => [{ id: 'mock', tier: 'rich', ok: true, version: 'mock/0', installable: false, models: ['ok'], defaultModel: 'ok' }];
    const create = vi.fn(dependencies.runs.create);
    dependencies.runs.create = create;
    const providers = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(providers.json()).toEqual([expect.objectContaining({ id: 'mock', version: 'mock/0' })]);
    const override = workflow();
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { workspaceId: 'workspace-1', workflowId: 'custom', task: 'Build', workflowOverride: override } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ providerVersions: { mock: 'mock/0' } });
    expect(create).toHaveBeenCalledWith(expect.any(Object), { mock: 'mock/0' });
  });

  it('serves a Markdown run report', async () => {
    const workspace = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Report repo', path: tmpdir() } });
    dependencies.runs.get = async () => runSnapshot({ workspaceId: workspace.json().id });
    const response = await app.inject({ method: 'GET', url: '/api/runs/run-1/report' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.body).toContain('# Run report — Custom');
  });

  it('validates event cursors and forwards afterSeq paging', async () => {
    const events = vi.fn(dependencies.runs.events);
    dependencies.runs.events = events;
    const response = await app.inject({ method: 'GET', url: '/api/runs/run-1/events?afterSeq=7&limit=25' });
    expect(response.statusCode).toBe(200);
    expect(events).toHaveBeenCalledWith('run-1', 7, 25);
    expect((await app.inject({ method: 'GET', url: '/api/runs/run-1/events?afterSeq=-1' })).statusCode).toBe(400);
  });

  it('serves latest patch text and returns 404 when no patch exists', async () => {
    const found = await app.inject({ method: 'GET', url: '/api/runs/run-1/patches/stage-1.slot-1.0' });
    expect(found.statusCode).toBe(200);
    expect(found.headers['content-type']).toContain('text/plain');
    expect(found.body).toContain('diff --git');

    dependencies.runs.patch = async () => { throw Object.assign(new Error('Patch not found'), { code: 'NOT_FOUND' }); };
    const missing = await app.inject({ method: 'GET', url: '/api/runs/run-1/patches/stage-1.slot-1.0' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Patch not found' } });
  });

  it.each([
    ['created', 'stage-1'],
    ['running', 'stage-1'],
    ['gating', 'other-stage'],
  ] as const)('rejects retry while status=%s/currentStage=%s', async (status, currentStageId) => {
    dependencies.runs.get = async () => runSnapshot({ status, currentStageId });
    const response = await app.inject({ method: 'POST', url: '/api/runs/run-1/stages/stage-1/retry', payload: {} });
    expect(response.statusCode).toBe(409);
  });

  it.each(['done', 'failed', 'aborted'] as const)('allows retry of the last executed stage for terminal status %s', async (status) => {
    dependencies.runs.get = async () => runSnapshot({ status, currentStageId: 'stage-1' });
    const response = await app.inject({ method: 'POST', url: '/api/runs/run-1/stages/stage-1/retry', payload: { promptAddendum: 'Try again' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'running', currentStageId: 'stage-1' });
  });

  it('allows retry only at the current gating stage', async () => {
    dependencies.runs.get = async () => runSnapshot({ status: 'gating', currentStageId: 'stage-1' });
    expect((await app.inject({ method: 'POST', url: '/api/runs/run-1/stages/stage-1/retry', payload: {} })).statusCode).toBe(200);
  });

  it('rejects retry after the workflow retry budget is exhausted', async () => {
    dependencies.runs.get = async () => runSnapshot({
      status: 'gating',
      currentStageId: 'stage-1',
      nodes: runSnapshot().nodes.map((node) => ({ ...node, attempt: 3 })),
    });
    const response = await app.inject({ method: 'POST', url: '/api/runs/run-1/stages/stage-1/retry', payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('retry budget') } });
  });

  it('returns 409 when deleting a non-terminal run', async () => {
    dependencies.runs.delete = async () => { throw Object.assign(new Error('abort it before deleting'), { code: 'CONFLICT' }); };
    const response = await app.inject({ method: 'DELETE', url: '/api/runs/run-1' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('maps kill-on-finished-node engine conflicts to 409', async () => {
    dependencies.runs.killNode = async () => { throw Object.assign(new Error('Node has already finished'), { code: 'CONFLICT' }); };
    const response = await app.inject({ method: 'POST', url: '/api/runs/run-1/nodes/stage-1.slot-1.0/kill' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('maps a retry rejected in the gate decision window to 409', async () => {
    dependencies.runs.get = async () => runSnapshot({ status: 'gating', currentStageId: 'stage-1' });
    dependencies.runs.retryStage = async () => { throw Object.assign(new Error('Stage is no longer accepting a retry'), { code: 'CONFLICT' }); };
    const response = await app.inject({ method: 'POST', url: '/api/runs/run-1/stages/stage-1/retry', payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });
});
