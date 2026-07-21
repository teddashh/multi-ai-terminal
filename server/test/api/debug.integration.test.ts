import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import fastify from 'fastify';
import { RunSnapshotSchema } from '@mat/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { registerApiRoutes } from '../../src/api/routes.js';
import { diag } from '../../src/diag.js';
import { configureDataDir } from '../../src/store/dataDir.js';
import { VERSION } from '../../src/version.js';
import { fakeApiDependencies, runSnapshot } from './helpers.js';
import { createRedactedFileStream } from '../../src/engine/debugBundle.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))));

describe('debug API', () => {
  it('forwards lazy artifact open failures through the redaction stream', async () => {
    const stream = createRedactedFileStream(join(tmpdir(), `mat-missing-artifact-${Date.now()}`));
    const [error] = await once(stream, 'error');
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

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
      expect(manifest).toMatchObject({ bundleVersion: 1, appVersion: VERSION, runId: 'run-1', workspace: { name: 'Debug repo', verifyCommand: 'npm test' }, providerVersions: { mock: 'mock/0' }, missing: [] });
      expect(() => RunSnapshotSchema.parse(JSON.parse(zip.readAsText('run.json')))).not.toThrow();
      expect(Object.keys(manifest).some((key) => key.toLowerCase().includes('env'))).toBe(false);
    } finally { await app.close(); }
  });

  it('removes an environment sentinel from every debug-bundle entry and the report route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-debug-redaction-'));
    dirs.push(root);
    configureDataDir(root);
    const sentinel = 'bundle-env-sentinel-d27f0c';
    const previous = process.env.MAT_TEST_BUNDLE_SECRET;
    const previousProtocol = process.env.MAT_TEST_PROTOCOL_SECRET;
    process.env.MAT_TEST_BUNDLE_SECRET = sentinel;
    process.env.MAT_TEST_PROTOCOL_SECRET = VERSION;
    const base = runSnapshot();
    const dependencies = fakeApiDependencies(runSnapshot({
      task: `task ${sentinel}`,
      workflow: { ...base.workflow, name: `Workflow ${sentinel}` },
      workspaceSnapshot: { name: `Workspace ${sentinel}`, path: tmpdir(), isGit: false, verifyCommand: `echo ${sentinel}` },
      nodes: base.nodes.map((node) => ({ ...node, resultText: `result ${sentinel}`, error: `error ${sentinel}` })),
    }));
    dependencies.report = (run) => `# ${run.workflow.name}\n${run.task}\n`;
    dependencies.runs.patch = async () => `diff --git a/${sentinel} b/${sentinel}\n`;
    dependencies.runs.applyPatch = async () => ({ ok: false, message: `conflict ${sentinel}`, conflicts: [`file-${sentinel}`] });
    const app = fastify();
    await registerApiRoutes(app, dependencies);
    await app.ready();
    try {
      const runRoot = join(root, 'runs', 'run-1');
      mkdirSync(join(runRoot, 'raw'), { recursive: true });
      mkdirSync(join(runRoot, 'artifacts'), { recursive: true });
      mkdirSync(join(root, 'logs'), { recursive: true });
      writeFileSync(join(runRoot, 'raw', 'legacy.jsonl'), `{"raw":"${sentinel}"}\n`);
      // Place the value across createReadStream's default 64 KiB boundary to
      // guard the streaming redactor's carry logic.
      writeFileSync(join(runRoot, 'artifacts', 'legacy.patch'), `${'a'.repeat(65_530)}${sentinel}\n`);
      writeFileSync(join(runRoot, 'artifacts', 'legacy.verify.log'), `${sentinel}\n`);
      writeFileSync(join(runRoot, 'diag.jsonl'), `{"message":"${sentinel}"}\n`);
      writeFileSync(join(root, 'logs', 'server-diag.jsonl'), `{"message":"${sentinel}"}\n`);

      const bundle = await app.inject({ method: 'GET', url: '/api/runs/run-1/debug-bundle' });
      expect(bundle.statusCode, bundle.body).toBe(200);
      const zip = new AdmZip(bundle.rawPayload);
      for (const entry of zip.getEntries().filter((candidate) => !candidate.isDirectory)) {
        expect(entry.getData().toString('utf8'), entry.entryName).not.toContain(sentinel);
      }
      expect(JSON.parse(zip.readAsText('manifest.json'))).toMatchObject({ appVersion: VERSION, bundleVersion: 1 });
      const report = await app.inject({ method: 'GET', url: '/api/runs/run-1/report' });
      expect(report.statusCode).toBe(200);
      expect(report.body).not.toContain(sentinel);
      expect(report.body).toContain('[REDACTED_ENV]');
      const patch = await app.inject({ method: 'GET', url: '/api/runs/run-1/patches/stage-1.slot-1.0' });
      expect(patch.body).not.toContain(sentinel);
      const applied = await app.inject({ method: 'POST', url: '/api/runs/run-1/nodes/stage-1.slot-1.0/apply-patch' });
      expect(applied.body).not.toContain(sentinel);
      const serverLog = await app.inject({ method: 'GET', url: '/api/debug/server-log' });
      expect(serverLog.body).not.toContain(sentinel);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.MAT_TEST_BUNDLE_SECRET;
      else process.env.MAT_TEST_BUNDLE_SECRET = previous;
      if (previousProtocol === undefined) delete process.env.MAT_TEST_PROTOCOL_SECRET;
      else process.env.MAT_TEST_PROTOCOL_SECRET = previousProtocol;
    }
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
