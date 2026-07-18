import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, parseArgs } from '../../src/index.js';
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
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});
