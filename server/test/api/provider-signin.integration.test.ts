import type { ProviderInfo } from '@mat/shared';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApiRoutes, type ApiRouteDependencies } from '../../src/api/routes.js';
import { spawnManaged } from '../../src/spawn.js';
import { configureDataDir } from '../../src/store/dataDir.js';
import { fakeApiDependencies } from './helpers.js';

const installed = (overrides: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'grok', tier: 'rich', ok: true, version: 'grok 1.0.0', installable: true,
  models: ['grok-4.5'], defaultModel: 'grok-4.5', ...overrides,
});

let app: FastifyInstance;
let dependencies: ApiRouteDependencies;
let dataDir: string;

async function ready(): Promise<void> {
  app = fastify();
  await registerApiRoutes(app, dependencies);
  await app.ready();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mat-provider-signin-'));
  configureDataDir(dataDir);
  dependencies = fakeApiDependencies();
});
afterEach(async () => {
  if (app) await app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('provider update endpoint', () => {
  it('runs the injected update recipe and returns the refreshed provider', async () => {
    const updated = installed({ version: 'grok 2.0.0' });
    let calls = 0;
    dependencies.providers = async () => (++calls === 1 ? [installed()] : [updated]);
    dependencies.providerInstall.updatePlan = () => ({ recipe: { command: process.execPath, args: ['-e', "console.log('updated to latest')"] } });
    dependencies.providerInstall.clearVersionCache = vi.fn();
    dependencies.providerInstall.clearPathCache = vi.fn();
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/grok/update' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, exitCode: 0, logTail: expect.stringContaining('updated to latest'), provider: { id: 'grok', ok: true, version: 'grok 2.0.0' } });
    expect(dependencies.providerInstall.clearVersionCache).toHaveBeenCalledWith('grok');
    expect(dependencies.providerInstall.clearPathCache).toHaveBeenCalledOnce();
  }, 30_000);

  it('rejects mock, not-installed providers, and unknown ids', async () => {
    dependencies.providers = async () => [
      installed({ id: 'mock', tier: 'plain', models: ['ok'], defaultModel: 'ok' }),
      installed({ id: 'codex', ok: false, models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' }),
    ];
    await ready();

    const mock = await app.inject({ method: 'POST', url: '/api/providers/mock/update' });
    expect(mock.statusCode).toBe(409);
    expect(mock.json()).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('no CLI to update') } });

    const notInstalled = await app.inject({ method: 'POST', url: '/api/providers/codex/update' });
    expect(notInstalled.statusCode).toBe(409);
    expect(notInstalled.json()).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('use install instead') } });

    const unknown = await app.inject({ method: 'POST', url: '/api/providers/unknown/update' });
    expect(unknown.statusCode).toBe(404);
  });

  it('shares the busy guard with install so the two cannot overlap', async () => {
    dependencies.providers = async () => [installed()];
    dependencies.providerInstall.updatePlan = () => ({ recipe: { command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 300)'] } });
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
    dependencies.providerInstall.spawn = (options) => { const managed = spawnManaged(options); markSpawned?.(); return managed; };
    await ready();
    const first = app.inject({ method: 'POST', url: '/api/providers/grok/update' });
    await spawned;
    const conflict = await app.inject({ method: 'POST', url: '/api/providers/grok/update' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('already running') } });
    await first;
  }, 30_000);
});

describe('provider sign-in endpoints', () => {
  it('starts a sign-in for a known provider and passes the id through', async () => {
    dependencies.providers = async () => [installed()];
    dependencies.providerSignIn.start = vi.fn(async () => ({ ok: true, loginId: 'L1', mode: 'device' as const, url: 'https://login.grok.com/activate', userCode: 'WXYZ-1234' }));
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/grok/signin/start' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, loginId: 'L1', mode: 'device', url: 'https://login.grok.com/activate', userCode: 'WXYZ-1234' });
    expect(dependencies.providerSignIn.start).toHaveBeenCalledWith('grok');
  });

  it('returns 404 for sign-in on an unknown provider', async () => {
    dependencies.providers = async () => [installed()];
    dependencies.providerSignIn.start = vi.fn();
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/unknown/signin/start' });
    expect(response.statusCode).toBe(404);
    expect(dependencies.providerSignIn.start).not.toHaveBeenCalled();
  });

  it('reports status by loginId and validates the query', async () => {
    dependencies.providers = async () => [installed()];
    dependencies.providerSignIn.status = vi.fn(() => ({ phase: 'pending' as const, url: 'https://login.grok.com/activate' }));
    await ready();
    const response = await app.inject({ method: 'GET', url: '/api/providers/grok/signin/status?loginId=L1' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ phase: 'pending', url: 'https://login.grok.com/activate' });
    expect(dependencies.providerSignIn.status).toHaveBeenCalledWith('L1');

    const missing = await app.inject({ method: 'GET', url: '/api/providers/grok/signin/status' });
    expect(missing.statusCode).toBe(400);
  });

  it('submits pasted codes and validates the body strictly', async () => {
    dependencies.providers = async () => [installed()];
    dependencies.providerSignIn.submitCode = vi.fn(async () => ({ ok: true, statusDetail: 'Signed in.' }));
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/claude/signin/code', payload: { loginId: 'L1', code: 'AUTH-1234' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, statusDetail: 'Signed in.' });
    expect(dependencies.providerSignIn.submitCode).toHaveBeenCalledWith('L1', 'AUTH-1234');

    const missingCode = await app.inject({ method: 'POST', url: '/api/providers/claude/signin/code', payload: { loginId: 'L1' } });
    expect(missingCode.statusCode).toBe(400);
    const extraField = await app.inject({ method: 'POST', url: '/api/providers/claude/signin/code', payload: { loginId: 'L1', code: 'X-1', shell: 'rm -rf' } });
    expect(extraField.statusCode).toBe(400);
  });

  it('cancels a sign-in by loginId', async () => {
    dependencies.providers = async () => [installed()];
    dependencies.providerSignIn.cancel = vi.fn(() => ({ ok: true }));
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/grok/signin/cancel', payload: { loginId: 'L1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(dependencies.providerSignIn.cancel).toHaveBeenCalledWith('L1');
  });
});
