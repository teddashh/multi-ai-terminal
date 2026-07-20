import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, RunSnapshot, WorkflowDef } from '@mat/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))));

function initRepo(path: string): void {
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'mat@example.test']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'MAT Test']);
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-qm', 'base']);
}

function steerWorkflow(twoStages = false): WorkflowDef {
  const agent = { provider: 'mock' as const, model: 'slow:30', permission: 'safe' as const };
  const stage = (id: string): WorkflowDef['stages'][number] => ({
    id, name: id, isolation: 'worktree', join: 'all', timeoutSec: 5, stallSec: 2, gate: false, requireVerified: false,
    slots: [{ id: 'agent', label: id, agent, count: 1, promptTemplate: '{{task}} {{retry_addendum}} {{orchestrator_context}}' }],
  });
  return {
    schemaVersion: 1, id: 'steer-test', name: 'Steer test', description: '',
    orchestrator: { enabled: false, agent, gateTimeoutSec: 5 }, stages: twoStages ? [stage('one'), stage('two')] : [stage('one')],
    maxParallel: 1, maxRetriesPerStage: 0,
  };
}

async function waitForRun(app: Awaited<ReturnType<typeof buildServer>>, runId: string, predicate: (run: RunSnapshot) => boolean): Promise<RunSnapshot> {
  // Eight boundary steer cycles each pay worktree + verify spawn costs; Windows
  // runners need tens of seconds, not the vitest default budget.
  const deadline = Date.now() + 25_000;
  let run: RunSnapshot | undefined;
  for (;;) {
    run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as RunSnapshot;
    if (predicate(run)) return run;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${runId}: ${run?.status ?? 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(twoStages = false, workflowOverride = steerWorkflow(twoStages)) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mat-steer-data-'));
  const workspace = mkdtempSync(join(tmpdir(), 'mat-steer-workspace-'));
  dirs.push(dataDir, workspace);
  initRepo(workspace);
  const app = await buildServer({ port: 7788, host: '127.0.0.1', dataDir, token: undefined });
  await app.ready();
  const createdWorkspace = (await app.inject({ method: 'POST', url: '/api/workspaces', payload: {
    name: 'Steer', path: workspace, verifyCommand: 'node -e "require(\'node:fs\').existsSync(\'evidence.txt\')||process.exit(1)"',
  } })).json();
  const created = (await app.inject({ method: 'POST', url: '/api/runs', payload: {
    workspaceId: createdWorkspace.id, workflowId: 'steer-test', task: 'MOCK_WRITE:evidence.txt', workflowOverride,
  } })).json() as RunSnapshot;
  return { app, dataDir, created };
}

describe('steering integration', () => {
  it('interrupts, preserves partial evidence, executes the steer, records review, and redoes the stage', async () => {
    const { app, dataDir, created } = await setup();
    try {
      await waitForRun(app, created.runId, (run) => run.nodes[0]?.status === 'running');
      const response = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'adjust the implementation' } });
      expect(response.statusCode, response.body).toBe(200);
      const finished = await waitForRun(app, created.runId, (run) => run.status === 'done');
      expect(finished.steers?.[0]).toMatchObject({ mode: 'interrupt', status: 'reviewed', interruptedStageId: 'one', steerStageId: 'steer-1' });
      expect(finished.nodes.find((node) => node.nodeRunId === 'one.agent.0')).toMatchObject({ status: 'done', attempt: 2 });
      expect(finished.nodes.find((node) => node.nodeRunId === 'steer-1.agent.0')?.verification?.status).toBe('passed');
      expect(finished.gateDecisions).toContainEqual(expect.objectContaining({ stageId: 'steer-1', action: 'retry' }));
      expect(existsSync(join(dataDir, 'runs', created.runId, 'artifacts', 'one.agent.0.a1.patch'))).toBe(true);
      const events = (await app.inject({ method: 'GET', url: `/api/runs/${created.runId}/events?limit=10000` })).json() as AgentEvent[];
      expect(events).toContainEqual(expect.objectContaining({ role: 'user', data: expect.objectContaining({ detail: 'steer' }) }));
      expect(events).toContainEqual(expect.objectContaining({ nodeRunId: 'one.agent.0', data: expect.objectContaining({ detail: 'steer' }) }));
      expect(events.find((event) => event.nodeRunId === 'one.agent.0' && event.attempt === 2 && event.role === 'user')?.text).toContain('adjust the implementation');
    } finally { await app.close(); }
  }, 30_000);

  it('queues without killing and carries deterministic review context to the next stage', async () => {
    const { app, created } = await setup(true);
    try {
      await waitForRun(app, created.runId, (run) => run.nodes[0]?.status === 'running');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'keep this queued', mode: 'queue' } })).statusCode).toBe(200);
      const finished = await waitForRun(app, created.runId, (run) => run.status === 'done');
      expect(finished.steers?.[0]).toMatchObject({ status: 'reviewed', interruptedStageId: null });
      expect(finished.nodes.find((node) => node.nodeRunId === 'one.agent.0')).toMatchObject({ status: 'done', attempt: 1 });
      const events = (await app.inject({ method: 'GET', url: `/api/runs/${created.runId}/events?limit=10000` })).json() as AgentEvent[];
      expect(events.some((event) => event.data?.detail === 'steer' && event.nodeRunId === 'one.agent.0')).toBe(false);
      expect(events.find((event) => event.nodeRunId === 'two.agent.0' && event.role === 'user')?.text).toContain('keep this queued');
    } finally { await app.close(); }
  }, 30_000);

  it('rejects terminal runs and the ninth steer', async () => {
    const { app, created } = await setup();
    try {
      await waitForRun(app, created.runId, (run) => run.nodes[0]?.status === 'running');
      for (let index = 0; index < 8; index += 1) {
        const response = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: `queued ${index}`, mode: 'queue' } });
        expect(response.statusCode, response.body).toBe(200);
      }
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'too many', mode: 'queue' } })).statusCode).toBe(409);
      await waitForRun(app, created.runId, (run) => run.status === 'done');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'late' } })).statusCode).toBe(409);
    } finally { await app.close(); }
  }, 30_000);

  it('supersedes an active steer with a newer interrupt and reviews the newer message', async () => {
    const { app, created } = await setup();
    try {
      await waitForRun(app, created.runId, (run) => run.nodes[0]?.status === 'running');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'first interrupt' } })).statusCode).toBe(200);
      await waitForRun(app, created.runId, (run) => run.nodes.find((node) => node.nodeRunId === 'steer-1.agent.0')?.status === 'running');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'second interrupt' } })).statusCode).toBe(200);
      const finished = await waitForRun(app, created.runId, (run) => run.status === 'done');
      expect(finished.steers).toEqual([
        expect.objectContaining({ status: 'superseded' }),
        expect.objectContaining({ status: 'reviewed', steerStageId: 'steer-2' }),
      ]);
      expect(finished.gateDecisions).toContainEqual(expect.objectContaining({ stageId: 'steer-2' }));
    } finally { await app.close(); }
  }, 30_000);

  it('fails open when an orchestrator returns invalid steer-review JSON', async () => {
    const workflow = steerWorkflow();
    workflow.orchestrator = { enabled: true, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, gateTimeoutSec: 5 };
    const { app, created } = await setup(false, workflow);
    try {
      await waitForRun(app, created.runId, (run) => run.nodes[0]?.status === 'running');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'review this interrupt' } })).statusCode).toBe(200);
      const finished = await waitForRun(app, created.runId, (run) => run.status === 'done');
      expect(finished.steers?.[0]?.status).toBe('reviewed');
      expect(finished.gateDecisions.find((decision) => decision.stageId === 'steer-1')).toMatchObject({ action: 'advance', degraded: true });
    } finally { await app.close(); }
  }, 30_000);

  it('expires a pending steer when the run is aborted during gating', async () => {
    const workflow = steerWorkflow();
    workflow.stages[0]!.gate = true;
    workflow.orchestrator = { enabled: true, agent: { provider: 'mock', model: 'slow:100', permission: 'safe' }, gateTimeoutSec: 5 };
    const { app, created } = await setup(false, workflow);
    try {
      await waitForRun(app, created.runId, (run) => run.status === 'gating');
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/steer`, payload: { text: 'pending at gate' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/abort` })).statusCode).toBe(200);
      const finished = await waitForRun(app, created.runId, (run) => run.status === 'aborted' && run.steers?.[0]?.status === 'expired');
      expect(finished.steers?.[0]?.status).toBe('expired');
      const events = (await app.inject({ method: 'GET', url: `/api/runs/${created.runId}/events?limit=10000` })).json() as AgentEvent[];
      expect(events).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ detail: 'steer-expired' }) }));
    } finally { await app.close(); }
  }, 30_000);
});
