import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerApiRoutes } from '../../src/api/routes.js';
import { diag } from '../../src/diag.js';
import { configureDataDir } from '../../src/store/dataDir.js';
import { fakeApiDependencies, runSnapshot } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('debug API', () => {
  it('exports bundle format v1 with run, event, diagnostics, report, raw, and artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-debug-bundle-'));
    dirs.push(root);
    configureDataDir(root);
    const dependencies = fakeApiDependencies(runSnapshot({
      nodes: runSnapshot().nodes.map((node) => ({ ...node, patchFile: join(root, 'runs', 'run-1', 'artifacts', `${node.nodeRunId}.a1.patch`), verification: { status: 'passed', command: 'npm test', exitCode: 0, durationMs: 10 } })),
      providerVersions: { mock: 'mock/0' },
    }));
    const app = fastify();
    await registerApiRoutes(app, dependencies);
    await app.ready();
    try {
      await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Debug repo', path: tmpdir(), verifyCommand: 'npm test' } });
      const runRoot = join(root, 'runs', 'run-1');
      mkdirSync(join(runRoot, 'raw'), { recursive: true });
      mkdirSync(join(runRoot, 'artifacts'), { recursive: true });
      writeFileSync(join(runRoot, 'raw', 'stage-1.slot-1.0.a1.jsonl'), '{"raw":true}\n');
      writeFileSync(join(runRoot, 'artifacts', 'stage-1.slot-1.0.a1.patch'), 'diff --git a/a b/a\n');
      writeFileSync(join(runRoot, 'artifacts', 'stage-1.slot-1.0.a1.verify.log'), 'ok\n');
      diag('run-1', 'stage', { stageId: 'stage-1', phase: 'end' });
      diag(null, 'probe', { command: 'mock', ok: true, version: 'mock/0' });

      const response = await app.inject({ method: 'GET', url: '/api/runs/run-1/debug-bundle' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('application/zip');
      const zip = new AdmZip(response.rawPayload);
      const names = zip.getEntries().map((entry) => entry.entryName);
      expect(names).toEqual(expect.arrayContaining([
        'manifest.json', 'run.json', 'events.jsonl', 'diag.jsonl', 'report.md', 'server-diag.jsonl',
        'raw/stage-1.slot-1.0.a1.jsonl', 'artifacts/stage-1.slot-1.0.a1.patch', 'artifacts/stage-1.slot-1.0.a1.verify.log',
      ]));
      const manifest = JSON.parse(zip.readAsText('manifest.json'));
      expect(manifest).toMatchObject({ bundleVersion: 1, appVersion: '0.1.7', runId: 'run-1', workspace: { name: 'Debug repo', verifyCommand: 'npm test' }, providerVersions: { mock: 'mock/0' }, missing: [] });
      expect(Object.keys(manifest).some((key) => key.toLowerCase().includes('env'))).toBe(false);
    } finally { await app.close(); }
  });

  it('accepts at most 200 client log entries per route registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-client-log-'));
    dirs.push(root);
    configureDataDir(root);
    const app = fastify();
    await registerApiRoutes(app, fakeApiDependencies());
    await app.ready();
    try {
      for (let index = 0; index < 205; index += 1) {
        const response = await app.inject({ method: 'POST', url: '/api/client-log', payload: { level: 'error', message: `client ${index}` } });
        expect(response.statusCode).toBe(204);
      }
      const lines = readFileSync(join(root, 'logs', 'server-diag.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.cat === 'client')).toHaveLength(200);
    } finally { await app.close(); }
  });
});
