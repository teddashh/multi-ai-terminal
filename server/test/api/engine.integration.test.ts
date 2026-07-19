import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunSnapshot, WorkflowDef } from '@mat/shared';
import { createWorktree, pruneWorktrees } from '../../src/engine/worktree.js';
import { buildServer } from '../../src/index.js';
import { configureDataDir } from '../../src/store/dataDir.js';
import { configureRunStore, listRuns, saveRun } from '../../src/store/runs.js';
import { configureWorkspaceStore, createWorkspace } from '../../src/store/workspaces.js';
import { runSnapshot, workflow } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const terminal = (run: RunSnapshot): boolean => ['done', 'failed', 'aborted'].includes(run.status);

async function waitForRun(app: Awaited<ReturnType<typeof buildServer>>, runId: string, predicate: (run: RunSnapshot) => boolean): Promise<RunSnapshot> {
  let run: RunSnapshot | undefined;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as RunSnapshot;
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for run ${runId}; last status was ${run?.status ?? 'unknown'}`);
}

function planningMockWorkflow(model = 'slow:5'): WorkflowDef {
  const binding = { provider: 'mock' as const, model, permission: 'safe' as const };
  return {
    schemaVersion: 1,
    id: 'planning-mock',
    name: 'Planning Mock',
    description: 'Planning-preset-shaped integration workflow',
    orchestrator: { enabled: true, agent: binding, gateTimeoutSec: 5 },
    stages: [
      {
        id: 'round-table', name: 'Round Table', isolation: 'none', join: 'all', timeoutSec: 5, stallSec: 2, gate: true, requireVerified: false,
        slots: [{ id: 'r', label: 'Round', agent: binding, count: 2, promptTemplate: 'Plan {{task}} as {{slot_label}} #{{instance_index}}. {{retry_addendum}}' }],
      },
      {
        id: 'final-review', name: 'Final Review', isolation: 'none', join: 'all', timeoutSec: 5, stallSec: 2, gate: true, requireVerified: false,
        slots: [{ id: 'final', label: 'Final', agent: binding, count: 1, promptTemplate: 'Synthesize {{task}}\n{{prior_stage_digest}}\n{{orchestrator_context}}' }],
      },
    ],
    maxParallel: 2,
    maxRetriesPerStage: 1,
  };
}

function initRepo(path: string): void {
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'mat@example.test']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'MAT Test']);
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-qm', 'base']);
}

describe('API lifecycle with the real run manager', () => {
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
      expect(createdResponse.statusCode, createdResponse.body).toBe(201);
      const runId = createdResponse.json().runId as string;

      let persisted = createdResponse.json();
      for (let attempt = 0; attempt < 100 && !['done', 'failed', 'aborted'].includes(persisted.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        persisted = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
      }
      expect(persisted.status).toBe('done');
      expect(persisted.providerVersions).toEqual({ mock: 'mock/0' });
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

  it('runs a planning-shaped mock workflow through durable events, snapshot WS broadcasts, decisions, and paged replay', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-choreography-'));
    const wrongDataDir = mkdtempSync(join(tmpdir(), 'mat-wrong-data-'));
    dirs.push(dataDir, wrongDataDir);
    const priorEnv = process.env.MAT_DATA_DIR;
    process.env.MAT_DATA_DIR = wrongDataDir;
    let app: Awaited<ReturnType<typeof buildServer>>;
    try {
      app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    } finally {
      if (priorEnv === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = priorEnv;
    }
    await app.ready();
    const socket = await app.injectWS('/ws');
    const wsMessages: Array<{ type: string; run?: RunSnapshot; event?: { runId: string } }> = [];
    socket.on('message', (raw) => wsMessages.push(JSON.parse(String(raw))));
    try {
      const workspace = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Temp', path: tmpdir() } })).json();
      const override = planningMockWorkflow();
      const task = [
        'Plan the integration.',
        'MOCK_REPLY: scripted gate reasoning',
        '```json',
        '{"action":"advance","contextForNext":"carry mock context","rationale":"mock gate approved"}',
        '```',
      ].join('\n');
      const created = (await app.inject({
        method: 'POST', url: '/api/runs', payload: { workspaceId: workspace.id, workflowId: 'planning', task, workflowOverride: override },
      })).json() as RunSnapshot;
      socket.send(JSON.stringify({ type: 'sub', runId: created.runId }));
      const finished = await waitForRun(app, created.runId, terminal);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(finished.status).toBe('done');
      expect(finished.workflow).toEqual(override);
      expect(finished.gateDecisions).toHaveLength(2);
      expect(finished.gateDecisions.every((decision) => decision.action === 'advance' && decision.rationale === 'mock gate approved')).toBe(true);
      expect(wsMessages.some((message) => message.type === 'event' && message.event?.runId === created.runId)).toBe(true);
      const wsRuns = wsMessages.filter((message) => message.type === 'run').map((message) => message.run!);
      expect(wsRuns.length).toBeGreaterThan(3);
      expect(wsRuns.some((run) => run.status === 'gating')).toBe(true);
      expect(wsRuns.at(-1)?.status).toBe('done');

      const complete = (await app.inject({ method: 'GET', url: `/api/runs/${created.runId}/events?afterSeq=0&limit=10000` })).json();
      const paged: typeof complete = [];
      let afterSeq = 0;
      for (;;) {
        const page = (await app.inject({ method: 'GET', url: `/api/runs/${created.runId}/events?afterSeq=${afterSeq}&limit=7` })).json();
        paged.push(...page);
        if (page.length < 7) break;
        afterSeq = page.at(-1).seq;
      }
      expect(paged).toEqual(complete);
      expect(paged.map((event: { seq: number }) => event.seq)).toEqual(paged.map((_: unknown, index: number) => index + 1));
      const roles = new Set(paged.map((event: { role: string }) => event.role));
      for (const role of ['user', 'agent', 'tool', 'thinking', 'decision', 'system']) expect(roles.has(role)).toBe(true);
      expect(paged.some((event: { kind: string }) => event.kind === 'decision')).toBe(true);
      expect(existsSync(join(dataDir, 'runs', created.runId, 'events.jsonl'))).toBe(true);
      expect(existsSync(join(dataDir, 'runs', created.runId, 'raw', 'round-table.r.0.a1.jsonl'))).toBe(true);
      expect(existsSync(join(wrongDataDir, 'runs', created.runId))).toBe(false);
    } finally {
      socket.close();
      await app.close();
    }
  });

  it('kills a node, retries its terminal stage, and aborts a separate active run through REST', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-controls-'));
    dirs.push(dataDir);
    const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    await app.ready();
    try {
      const workspace = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Temp', path: tmpdir() } })).json();
      const controlled = workflow({
        orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, gateTimeoutSec: 5 },
        stages: [{
          id: 'stage-1', name: 'Stage One', isolation: 'none', join: 'all', timeoutSec: 5, stallSec: 2, gate: false,
          slots: [{ id: 'slot-1', label: 'Candidate', agent: { provider: 'mock', model: 'slow:30', permission: 'safe' }, count: 1, promptTemplate: '{{task}} {{retry_addendum}}' }],
        }],
        maxRetriesPerStage: 1,
      });
      const firstResponse = await app.inject({ method: 'POST', url: '/api/runs', payload: {
        workspaceId: workspace.id, workflowId: controlled.id, task: 'control run', workflowOverride: controlled,
      } });
      expect(firstResponse.statusCode, firstResponse.body).toBe(201);
      const first = firstResponse.json() as RunSnapshot;
      await waitForRun(app, first.runId, (run) => run.nodes[0]?.status === 'running');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${first.runId}/nodes/stage-1.slot-1.0/kill` })).statusCode).toBe(200);
      const killed = await waitForRun(app, first.runId, terminal);
      expect(killed).toMatchObject({ status: 'done', nodes: [expect.objectContaining({ status: 'killed' })] });

      const retryResponse = await app.inject({ method: 'POST', url: `/api/runs/${first.runId}/stages/stage-1/retry`, payload: { promptAddendum: 'retry from REST' } });
      expect(retryResponse.statusCode).toBe(200);
      const retried = await waitForRun(app, first.runId, (run) => run.status === 'done' && run.nodes[0]?.attempt === 2);
      expect(retried.nodes[0]).toMatchObject({ attempt: 2, status: 'done' });

      const second = (await app.inject({ method: 'POST', url: '/api/runs', payload: {
        workspaceId: workspace.id, workflowId: controlled.id, task: 'abort run', workflowOverride: controlled,
      } }));
      expect(second.statusCode, second.body).toBe(201);
      const secondRun = second.json() as RunSnapshot;
      await waitForRun(app, secondRun.runId, (run) => run.nodes[0]?.status === 'running');
      const aborted = await app.inject({ method: 'POST', url: `/api/runs/${secondRun.runId}/abort` });
      expect(aborted.statusCode).toBe(200);
      expect(aborted.json()).toMatchObject({ status: 'aborted', nodes: [expect.objectContaining({ status: 'killed' })] });
    } finally {
      await app.close();
    }
  });

  it('serves isolation patches and prunes the real worktree and branch on run deletion', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-patch-api-'));
    const workspaceDir = mkdtempSync(join(tmpdir(), 'mat-patch-repo-'));
    dirs.push(dataDir, workspaceDir);
    initRepo(workspaceDir);
    const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    await app.ready();
    try {
      const workspace = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Repo', path: workspaceDir } })).json();
      const isolated = workflow({
        orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, gateTimeoutSec: 5 },
        stages: [{ ...workflow().stages[0]!, isolation: 'worktree', gate: false }],
      });
      const created = (await app.inject({ method: 'POST', url: '/api/runs', payload: {
        workspaceId: workspace.id, workflowId: isolated.id, task: 'isolate', workflowOverride: isolated,
      } })).json() as RunSnapshot;
      const finished = await waitForRun(app, created.runId, terminal);
      const node = finished.nodes[0]!;
      expect(node.patchFile?.startsWith(dataDir)).toBe(true);
      expect(existsSync(node.patchFile!)).toBe(true);
      expect(existsSync(node.cwd)).toBe(true);
      const patch = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}/patches/${node.nodeRunId}` });
      expect(patch.statusCode).toBe(200);
      expect(patch.headers['content-type']).toContain('text/plain');

      expect((await app.inject({ method: 'DELETE', url: `/api/runs/${created.runId}` })).statusCode).toBe(204);
      expect(existsSync(node.cwd)).toBe(false);
      expect(execFileSync('git', ['-C', workspaceDir, 'branch', '--list', `mat/${created.runId}/*`], { encoding: 'utf8' }).trim()).toBe('');
    } finally {
      await app.close();
    }
  });

  it('enforces requireVerified retries, degrades at budget exhaustion, and stays inert for skipped checks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-required-verify-'));
    const workspaceDir = mkdtempSync(join(tmpdir(), 'mat-required-repo-'));
    const skippedDir = mkdtempSync(join(tmpdir(), 'mat-skipped-repo-'));
    dirs.push(dataDir, workspaceDir, skippedDir);
    initRepo(workspaceDir); initRepo(skippedDir);
    const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    await app.ready();
    try {
      const failingWorkspace = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: {
        name: 'Failing', path: workspaceDir, verifyCommand: 'node -e "process.exit(1)"', verifyTimeoutSec: 10,
      } })).json();
      const skippedWorkspace = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Skipped', path: skippedDir } })).json();
      const required = workflow({
        id: 'required-verification', maxRetriesPerStage: 1,
        orchestrator: { enabled: true, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, gateTimeoutSec: 5 },
        stages: [{
          ...workflow().stages[0]!, isolation: 'worktree', gate: true, requireVerified: true,
          slots: [{ ...workflow().stages[0]!.slots[0]!, promptTemplate: '{{task}}' }],
        }],
      });
      const task = 'MOCK_WRITE:evidence.txt\nMOCK_REPLY: ```json\n{"action":"advance","rationale":"looks ready"}\n```';
      const failedCreated = (await app.inject({ method: 'POST', url: '/api/runs', payload: {
        workspaceId: failingWorkspace.id, workflowId: required.id, task, workflowOverride: required,
      } })).json() as RunSnapshot;
      const failed = await waitForRun(app, failedCreated.runId, terminal);
      expect(failed.nodes[0]).toMatchObject({ attempt: 2, verification: { status: 'failed', exitCode: 1 } });
      expect(failed.gateDecisions[0]).toMatchObject({ action: 'retry', retryNodeRunIds: ['stage-1.slot-1.0'] });
      expect(failed.gateDecisions[0]?.rationale).toContain('requireVerified');
      expect(failed.gateDecisions[1]).toMatchObject({ action: 'advance', degraded: true });
      const failedEvents = (await app.inject({ method: 'GET', url: `/api/runs/${failed.runId}/events?limit=1000` })).json();
      expect(failedEvents).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ detail: 'gate-degraded' }) })]));

      const skippedCreated = (await app.inject({ method: 'POST', url: '/api/runs', payload: {
        workspaceId: skippedWorkspace.id, workflowId: required.id, task, workflowOverride: required,
      } })).json() as RunSnapshot;
      const skipped = await waitForRun(app, skippedCreated.runId, terminal);
      expect(skipped.nodes[0]).toMatchObject({ attempt: 1, verification: { status: 'skipped', reason: 'no-verify-command' } });
      expect(skipped.gateDecisions).toHaveLength(1);
      expect(skipped.gateDecisions[0]).toMatchObject({ action: 'advance' });
      expect(skipped.gateDecisions[0]?.degraded).not.toBe(true);
    } finally {
      await app.close();
    }
  });

  it('prunes real worktree metadata and branches when retention removes the oldest run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-retention-data-'));
    const workspaceDir = mkdtempSync(join(tmpdir(), 'mat-retention-repo-'));
    dirs.push(dataDir, workspaceDir);
    initRepo(workspaceDir);
    configureDataDir(dataDir);
    configureWorkspaceStore(dataDir);
    configureRunStore(dataDir, { cleanupRun: pruneWorktrees });
    const workspace = await createWorkspace({ name: 'Repo', path: workspaceDir });
    const oldest = runSnapshot({ runId: 'retained-oldest', workspaceId: workspace.id, createdAt: 1, endedAt: 2 });
    await saveRun(oldest);
    const worktree = await createWorktree(workspaceDir, oldest.runId, oldest.nodes[0]!.nodeRunId, 1);
    for (let index = 0; index < 100; index += 1) {
      await saveRun(runSnapshot({
        runId: `retained-${String(index).padStart(3, '0')}`,
        workspaceId: workspace.id,
        createdAt: index + 10,
        endedAt: index + 11,
      }));
    }
    expect(await listRuns(workspace.id, 100)).toHaveLength(100);
    expect(existsSync(join(dataDir, 'runs', oldest.runId))).toBe(false);
    expect(existsSync(worktree.cwd)).toBe(false);
    expect(execFileSync('git', ['-C', workspaceDir, 'branch', '--list', worktree.branch], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('supports the web duplicate-then-update sequence for builtin edits', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mat-duplicate-api-'));
    dirs.push(dataDir);
    const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
    await app.ready();
    try {
      const duplicate = await app.inject({ method: 'POST', url: '/api/workflows/planning/duplicate' });
      expect(duplicate.statusCode).toBe(201);
      const copy = duplicate.json();
      expect(copy).toMatchObject({ id: 'planning-copy' });
      expect(copy.builtin).toBeUndefined();
      const updated = await app.inject({ method: 'PATCH', url: `/api/workflows/${copy.id}`, payload: { description: 'Edited in web shell' } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ id: copy.id, description: 'Edited in web shell' });
      expect(updated.json().builtin).toBeUndefined();
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
