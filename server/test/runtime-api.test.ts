import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { defaultApiRouteDependencies } from '../src/api/routes.js';

const root = mkdtempSync(join(tmpdir(), 'mat-runtime-api-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('runtime API', () => {
  it('returns status and validates unknown and unsupported families', async () => {
    const status = vi.fn(async () => [{ family: 'codex' as const, state: 'missing' as const, managedVersion: '1', canInstallManaged: false }, { family: 'claude' as const, state: 'external' as const, managedVersion: '2', resolvedPath: 'claude', canInstallManaged: true }]);
    const app = await buildServer({ port: 0, host: '127.0.0.1', dataDir: join(root, 'validation'), token: undefined }, { api: { ...defaultApiRouteDependencies, runtimes: { status, install: vi.fn() as never, clear: vi.fn(async () => undefined) as never, active: () => undefined } } });
    expect((await app.inject({ method: 'GET', url: '/api/runtimes' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/runtimes/nope/install' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/runtimes/codex/install' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/runtimes/codex/clear' })).statusCode).toBe(202);
    await app.close();
  }, 30_000);

  it('accepts background mutation with 202 and reports the lock owner with 409', async () => {
    const statuses = async () => [{ family: 'codex' as const, state: 'missing' as const, managedVersion: '1', canInstallManaged: true }, { family: 'claude' as const, state: 'missing' as const, managedVersion: '2', canInstallManaged: true }];
    const install = vi.fn(async () => '/fixture/codex');
    let held: 'codex' | undefined;
    const app = await buildServer({ port: 0, host: '127.0.0.1', dataDir: join(root, 'mutation'), token: undefined }, { api: { ...defaultApiRouteDependencies, runtimes: { status: statuses, install: install as never, clear: vi.fn() as never, active: () => held } } });
    expect((await app.inject({ method: 'POST', url: '/api/runtimes/codex/install' })).statusCode).toBe(202);
    expect(install).toHaveBeenCalledOnce();
    held = 'codex';
    const conflict = await app.inject({ method: 'POST', url: '/api/runtimes/claude/clear' });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.message).toContain('codex');
    await app.close();
  }, 30_000);
});
