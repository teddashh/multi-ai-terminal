import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, parseArgs, readyLine, shutdownServer } from '../../src/index.js';
import { fakeApiDependencies } from './helpers.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mat-index-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function server(token?: string, webDist?: string): Promise<FastifyInstance> {
  const app = await buildServer(
    { port: 7788, host: '127.0.0.1', dataDir: tempDir(), token },
    {
      sweepOnBoot: async () => undefined,
      abortRun: async () => undefined,
      cleanupRun: async () => undefined,
      api: fakeApiDependencies(),
      ...(webDist === undefined ? {} : { webDist }),
    },
  );
  apps.push(app);
  await app.ready();
  return app;
}

describe('server options and trust boundary', () => {
  it('parses CLI values over environment fallbacks', () => {
    const envDataDir = join(tmpdir(), 'from-env');
    const cliDataDir = join(tmpdir(), 'cli');
    expect(parseArgs([], {
      MAT_PORT: '9000', MAT_HOST: '100.64.0.1', MAT_DATA_DIR: envDataDir, MAT_TOKEN: 'env-token',
    })).toEqual({ port: 9000, host: '100.64.0.1', dataDir: envDataDir, token: 'env-token' });
    expect(parseArgs(['--port', '7789', '--host', '0.0.0.0', '--data-dir', cliDataDir, '--token', 'cli'], {
      MAT_PORT: '9000', MAT_HOST: '127.0.0.1',
    })).toEqual({ port: 7789, host: '0.0.0.0', dataDir: cliDataDir, token: 'cli' });
    expect(() => parseArgs(['--port', '70000'])).toThrow('Invalid port');
    expect(() => parseArgs(['--port', '-1'])).toThrow('Invalid port');
    expect(parseArgs(['--port', '0']).port).toBe(0);
  });

  it('announces readiness with the bound URL and never the token', () => {
    expect(readyLine('127.0.0.1', 7788)).toBe('[MAT_AGENT] READY url=http://127.0.0.1:7788/');
    expect(readyLine('0.0.0.0', 43063)).toBe('[MAT_AGENT] READY url=http://127.0.0.1:43063/');
    expect(readyLine('::', 8080)).toBe('[MAT_AGENT] READY url=http://127.0.0.1:8080/');
  });

  it('allows REST without auth when no token is configured', async () => {
    const app = await server();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: expect.any(String) });
  });

  it('requires an exact bearer token on every REST endpoint when configured', async () => {
    const app = await server('secret');
    for (const authorization of [undefined, 'Bearer wrong', 'secret']) {
      const response = await app.inject({ method: 'GET', url: '/api/health', headers: authorization ? { authorization } : {} });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: 'Bearer secret' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/not-api' })).statusCode).not.toBe(401);
  });

  it('releases provider runtimes and closes the listener after engine and account-sync failures', async () => {
    const calls: string[] = [];
    const engineFailure = new Error('run listing failed');

    await expect(shutdownServer(
      { close: async () => { calls.push('close'); } },
      {
        stopEngine: async () => { calls.push('stop'); throw engineFailure; },
        syncActiveAccount: () => { calls.push('sync'); throw new Error('account sync failed'); },
        disposeProviderRuntimes: async () => { calls.push('dispose'); },
      },
    )).rejects.toBe(engineFailure);

    expect(calls).toEqual(['stop', 'sync', 'dispose', 'close']);
  });

  it('still closes the listener when provider disposal fails', async () => {
    const calls: string[] = [];
    const disposeFailure = new Error('provider disposal failed');

    await expect(shutdownServer(
      { close: async () => { calls.push('close'); } },
      {
        stopEngine: async () => { calls.push('stop'); },
        syncActiveAccount: () => { calls.push('sync'); },
        disposeProviderRuntimes: async () => { calls.push('dispose'); throw disposeFailure; },
      },
    )).rejects.toBe(disposeFailure);

    expect(calls).toEqual(['stop', 'sync', 'dispose', 'close']);
  });
});

describe('static server', () => {
  it('serves static files and falls back to index.html for SPA routes', async () => {
    const webDist = tempDir();
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>MAT shell</title>', 'utf8');
    await writeFile(join(webDist, 'asset.txt'), 'asset', 'utf8');
    const app = await server(undefined, webDist);
    expect((await app.inject({ method: 'GET', url: '/asset.txt' })).body).toBe('asset');
    const spa = await app.inject({ method: 'GET', url: '/workspaces/example' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('MAT shell');
    const api404 = await app.inject({ method: 'GET', url: '/api/missing' });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  it('does not let an encoded separator bypass a protected route into static files', async () => {
    const webDist = tempDir();
    await mkdir(join(webDist, 'api'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>MAT shell</title>', 'utf8');
    await writeFile(join(webDist, 'api', 'secret.txt'), 'route-boundary-secret', 'utf8');
    const app = await server('secret', webDist);

    const direct = await app.inject({ method: 'GET', url: '/api/secret.txt' });
    expect(direct.statusCode).toBe(401);
    const encodedWithoutToken = await app.inject({ method: 'GET', url: '/api%2Fsecret.txt' });
    expect(encodedWithoutToken.statusCode).toBe(401);
    const encoded = await app.inject({ method: 'GET', url: '/api%2Fsecret.txt', headers: { authorization: 'Bearer secret' } });
    expect(encoded.statusCode).toBe(404);
    expect(encoded.body).not.toContain('route-boundary-secret');
  });
});
