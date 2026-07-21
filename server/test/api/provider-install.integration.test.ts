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

const unavailable = (overrides: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'grok', tier: 'rich', ok: false, detail: 'not installed', installable: true,
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
  dataDir = mkdtempSync(join(tmpdir(), 'mat-provider-install-'));
  configureDataDir(dataDir);
  dependencies = fakeApiDependencies();
});
afterEach(async () => {
  if (app) await app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('provider refresh endpoint', () => {
  it('clears PATH and all version probes before returning fresh detection', async () => {
    const installed = unavailable({ ok: true, version: 'grok 1.0.0' });
    delete installed.detail;
    dependencies.providers = vi.fn(async () => [installed]);
    dependencies.providerInstall.clearVersionCache = vi.fn();
    dependencies.providerInstall.clearPathCache = vi.fn();
    await ready();

    const response = await app.inject({ method: 'POST', url: '/api/providers/refresh' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([installed]);
    expect(dependencies.providerInstall.clearPathCache).toHaveBeenCalledOnce();
    expect(dependencies.providerInstall.clearVersionCache).toHaveBeenCalledWith();
  });
});

describe('provider install endpoint', () => {
  it('runs an injected recipe, clears the probe cache, and returns the refreshed provider', async () => {
    const installed = unavailable({ ok: true, version: 'grok 1.0.0' });
    delete installed.detail;
    let calls = 0;
    dependencies.providers = async () => (++calls === 1 ? [unavailable()] : [installed]);
    dependencies.providerInstall.plan = () => ({ recipe: { command: process.execPath, args: ['-e', "console.log('installed')"] } });
    dependencies.providerInstall.clearVersionCache = vi.fn();
    dependencies.providerInstall.clearPathCache = vi.fn();
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/grok/install' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, exitCode: 0, logTail: expect.stringContaining('installed'), provider: { id: 'grok', ok: true, version: 'grok 1.0.0' } });
    expect(dependencies.providerInstall.clearPathCache).toHaveBeenCalledOnce();
    expect(dependencies.providerInstall.clearVersionCache).toHaveBeenCalledWith('grok');
  }, 30_000);

  it('caps combined output and returns the last 8KB on failure', async () => {
    dependencies.providers = async () => [unavailable()];
    dependencies.providerInstall.plan = () => ({ recipe: { command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(70000)); process.stderr.write('TAIL-MARKER'); process.exit(7)"] } });
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/grok/install' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, exitCode: 7, provider: { id: 'grok', ok: false } });
    expect(Buffer.byteLength(response.json().logTail as string)).toBeLessThanOrEqual(8 * 1024);
    expect(response.json().logTail).toContain('TAIL-MARKER');
  }, 30_000);

  it('rejects a second install while the first is running', async () => {
    dependencies.providers = async () => [unavailable()];
    dependencies.providerInstall.plan = () => ({ recipe: { command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 200)'] } });
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
    dependencies.providerInstall.spawn = (options) => { const managed = spawnManaged(options); markSpawned?.(); return managed; };
    await ready();
    const first = app.inject({ method: 'POST', url: '/api/providers/grok/install' });
    await spawned;
    const conflict = await app.inject({ method: 'POST', url: '/api/providers/grok/install' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('already running') } });
    await first;
  }, 30_000);

  it('rejects providers that are already available', async () => {
    const installed = unavailable({ ok: true });
    delete installed.detail;
    dependencies.providers = async () => [installed];
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/grok/install' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('already installed') } });
  });

  it('returns a manual-only command without spawning', async () => {
    const manual = unavailable({ id: 'agy', tier: 'plain', installable: false, manualCommand: 'install agy', models: ['agy'], defaultModel: 'agy' });
    dependencies.providers = async () => [manual];
    dependencies.providerInstall.plan = () => ({ manualCommand: 'install agy' });
    dependencies.providerInstall.spawn = vi.fn(dependencies.providerInstall.spawn);
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/agy/install' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, manualCommand: 'install agy' });
    expect(dependencies.providerInstall.spawn).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown provider id', async () => {
    dependencies.providers = async () => [unavailable()];
    await ready();
    const response = await app.inject({ method: 'POST', url: '/api/providers/unknown/install' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
