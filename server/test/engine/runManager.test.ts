import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, RunSnapshot, WorkflowDef, Workspace } from '@mat/shared';

const state = vi.hoisted(() => ({
  runs: new Map<string, RunSnapshot>(),
  workspace: { id: 'ws', name: 'Workspace', path: '/tmp/workspace', isGit: false } as Workspace,
  replies: [] as string[],
  active: 0,
  maxActive: 0,
  kills: 0,
  nextPid: 20_000,
}));

vi.mock('../../src/store/runs.js', () => ({
  saveRun: async (run: RunSnapshot) => { state.runs.set(run.runId, structuredClone(run)); },
  getRun: async (runId: string) => {
    const run = state.runs.get(runId);
    if (!run) throw new Error('not found');
    return structuredClone(run);
  },
  listRuns: async () => [...state.runs.values()].map((run) => structuredClone(run)),
  deleteRun: async (runId: string) => { state.runs.delete(runId); },
}));
vi.mock('../../src/store/workspaces.js', () => ({
  getWorkspace: async () => structuredClone(state.workspace),
  listWorkspaces: async () => [structuredClone(state.workspace)],
}));
vi.mock('../../src/store/workflows.js', () => ({ listWorkflows: async () => [] }));
vi.mock('../../src/adapters/registry.js', () => ({
  getAdapter: () => ({
    id: 'mock', tier: 'rich', models: ['ok'], defaultModel: 'ok', available: async () => ({ ok: true }),
    spawn(spec: { binding: { model?: string }; promptText: string }, io: { onRaw(line: string, stream: 'out'|'err'): void; onEvent(event: { role: 'agent'; kind: 'message'; text: string }): void }) {
      const pid = state.nextPid++;
      const model = spec.binding.model ?? 'ok';
      let settled = false;
      let finish!: (outcome: { exitCode: number | null; resultText?: string; error?: string; sessionRef?: string }) => void;
      const completion = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      const done = (outcome: Parameters<typeof finish>[0]) => {
        if (settled) return;
        settled = true;
        state.active -= 1;
        finish(outcome);
      };
      if (model === 'fail') {
        queueMicrotask(() => { io.onRaw('failed', 'err'); done({ exitCode: 1, error: 'failed' }); });
      } else if (model === 'slow' || model === 'gate-slow') {
        // Resolved by kill for abort and gate-timeout tests.
      } else {
        queueMicrotask(() => {
          const resultText = model === 'gate'
            ? (state.replies.shift() ?? '```json\n{"action":"advance","rationale":"ok"}\n```')
            : `RESULT: ${spec.promptText}`;
          io.onRaw(resultText, 'out');
          io.onEvent({ role: 'agent', kind: 'message', text: resultText });
          done({ exitCode: 0, resultText, ...(model === 'gate' ? { sessionRef: 'gate-session' } : {}) });
        });
      }
      return { pid, completion, kill() { state.kills += 1; done({ exitCode: null, error: 'killed' }); } };
    },
  }),
}));

import { configureEventLog, readEventsAfter } from '../../src/store/eventLog.js';
import { abortRun, createRun, retryStage, sweepOnBoot } from '../../src/engine/runManager.js';
import { waitForRun } from './fakes.js';

const dirs: string[] = [];
const oldDataDir = process.env.MAT_DATA_DIR;

const binding = (model: string) => ({ provider: 'mock' as const, model, permission: 'safe' as const });
const workflow = (options: { candidateModel?: string; orchestrator?: boolean; gateModel?: string; retries?: number; twoStages?: boolean } = {}): WorkflowDef => ({
  schemaVersion: 1,
  id: 'wf', name: 'Workflow', description: '',
  orchestrator: { enabled: options.orchestrator ?? true, agent: binding(options.gateModel ?? 'gate'), gateTimeoutSec: 1 },
  stages: [
    {
      id: 'round', name: 'Round', isolation: 'none', join: 'all', timeoutSec: 5, stallSec: 5, gate: true,
      slots: [{ id: 'candidate', label: 'Candidate', count: 3, agent: binding(options.candidateModel ?? 'ok'), promptTemplate: 'TASK={{task}} RETRY={{retry_addendum}}' }],
    },
    ...(options.twoStages === false ? [] : [{
      id: 'final', name: 'Final', isolation: 'none' as const, join: 'all' as const, timeoutSec: 5, stallSec: 5, gate: true,
      slots: [{ id: 'review', label: 'Review', count: 1, agent: binding(options.candidateModel ?? 'ok'), promptTemplate: 'DIGEST={{prior_stage_digest}} CONTEXT={{orchestrator_context}}' }],
    }]),
  ],
  maxParallel: 2,
  maxRetriesPerStage: options.retries ?? 2,
});

beforeEach(() => {
  state.runs.clear();
  state.replies.length = 0;
  state.active = 0;
  state.maxActive = 0;
  state.kills = 0;
  const dir = mkdtempSync(join(tmpdir(), 'mat-run-')); dirs.push(dir);
  process.env.MAT_DATA_DIR = dir;
  configureEventLog(dir);
});

afterEach(async () => {
  if (oldDataDir === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = oldDataDir;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(def: WorkflowDef): Promise<{ run: RunSnapshot; events: AgentEvent[] }> {
  const created = await createRun({ workspaceId: 'ws', workflowId: 'wf', task: 'Build it', workflowOverride: def });
  const run = await waitForRun(() => state.runs.get(created.runId), (candidate) => ['done', 'failed', 'aborted'].includes(candidate.status), 4000);
  return { run, events: readEventsAfter(created.runId, 0, 10_000) };
}

describe('run manager and stage state machine', () => {
  it('runs a two-stage fan-out FIFO, joins, gates, and carries digest/context into the next prompt', async () => {
    state.replies.push(
      'reason ```json\n{"action":"advance","contextForNext":"carry this","rationale":"good"}\n```',
      '```json\n{"action":"advance","rationale":"finished"}\n```',
    );
    const { run, events } = await start(workflow());
    expect(run.status).toBe('done');
    expect(state.maxActive).toBeLessThanOrEqual(2);
    expect(run.nodes.filter((node) => node.stageId === 'round').map((node) => node.status)).toEqual(['done', 'done', 'done']);
    expect(run.gateDecisions).toHaveLength(2);
    const finalPrompt = events.find((event) => event.role === 'user' && event.stageId === 'final');
    expect(finalPrompt?.text).toContain('RESULT: TASK=Build it');
    expect(finalPrompt?.text).toContain('carry this');
    for (const node of run.nodes.filter((candidate) => candidate.stageId !== null)) {
      const attemptEvents = events.filter((event) => event.nodeRunId === node.nodeRunId && event.attempt === 1);
      expect(attemptEvents.slice(0, 3).map((event) => [event.role, event.data?.status])).toEqual([['user', undefined], ['system', 'spawned'], ['system', 'running']]);
    }
  });

  it('retries fresh attempts with addenda and forces degraded advance when the gate budget is exhausted', async () => {
    state.replies.push(
      '```json\n{"action":"retry","retryNodeRunIds":["round.candidate.0"],"promptAddendum":"first addendum","rationale":"again"}\n```',
      '```json\n{"action":"retry","retryNodeRunIds":["round.candidate.0"],"promptAddendum":"second addendum","rationale":"again"}\n```',
      '```json\n{"action":"retry","retryNodeRunIds":["round.candidate.0"],"promptAddendum":"third addendum","rationale":"again"}\n```',
    );
    const def = workflow({ twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const { run, events } = await start(def);
    expect(run.nodes.find((node) => node.nodeRunId === 'round.candidate.0')?.attempt).toBe(3);
    expect(run.gateDecisions).toHaveLength(3);
    expect(run.gateDecisions.at(-1)).toMatchObject({ action: 'advance', degraded: true });
    expect(events.find((event) => event.nodeRunId === 'round.candidate.0' && event.attempt === 2 && event.role === 'user')?.text).toContain('first addendum');
    expect(events.filter((event) => event.nodeRunId === 'round.candidate.0' && event.data?.status === 'retry')).toHaveLength(2);
  });

  it('fails an all-failed stage when the orchestrator is disabled', async () => {
    const def = workflow({ candidateModel: 'fail', orchestrator: false, twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const { run } = await start(def);
    expect(run.status).toBe('failed');
  });

  it('lets an enabled orchestrator advance an all-failed stage', async () => {
    state.replies.push('```json\n{"action":"advance","rationale":"nothing usable"}\n```');
    const def = workflow({ candidateModel: 'fail', twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const { run } = await start(def);
    expect(run.status).toBe('done');
    expect(run.nodes.find((node) => node.stageId === 'round')?.status).toBe('failed');
  });

  it('aborts mid-stage and invokes process-group adapter kills', async () => {
    const def = workflow({ candidateModel: 'slow', orchestrator: false, twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const created = await createRun({ workspaceId: 'ws', workflowId: 'wf', task: 'Stop', workflowOverride: def });
    await waitForRun(() => state.runs.get(created.runId), (run) => run.nodes.some((node) => node.status === 'running'));
    await abortRun(created.runId);
    const run = await waitForRun(() => state.runs.get(created.runId), (candidate) => candidate.status === 'aborted');
    expect(run.status).toBe('aborted');
    expect(state.kills).toBe(1);
  });

  it('keeps an abort terminal when it interrupts an active gate', async () => {
    const def = workflow({ gateModel: 'gate-slow', twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const created = await createRun({ workspaceId: 'ws', workflowId: 'wf', task: 'Stop gate', workflowOverride: def });
    await waitForRun(() => state.runs.get(created.runId), (run) => run.status === 'gating');
    await abortRun(created.runId);
    const run = await waitForRun(() => state.runs.get(created.runId), (candidate) => candidate.status === 'aborted');
    expect(run.status).toBe('aborted');
    expect(state.kills).toBe(1);
  });

  it('retries a terminal ungated stage with the supplied addendum and enforces its retry budget', async () => {
    const def = workflow({ orchestrator: false, twoStages: false, retries: 1 });
    def.stages[0]!.gate = false;
    def.stages[0]!.slots[0]!.count = 1;
    const first = await start(def);
    await retryStage(first.run.runId, 'round', { promptAddendum: 'human follow-up' });
    const retried = await waitForRun(() => state.runs.get(first.run.runId), (run) => run.status === 'done' && run.nodes[0]?.attempt === 2);
    expect(retried.nodes[0]?.resultText).toContain('human follow-up');
    await expect(retryStage(first.run.runId, 'round', {})).rejects.toThrow('budget');
  });

  it('re-asks once on parse failure, degrades invalid retry ids, and degrades a gate timeout', async () => {
    state.replies.push('invalid', 'still invalid');
    let result = await start(workflow({ twoStages: false }));
    expect(result.run.gateDecisions[0]).toMatchObject({ action: 'advance', degraded: true });
    expect(result.events.filter((event) => event.nodeRunId === 'orchestrator' && event.role === 'user')).toHaveLength(2);

    state.runs.clear();
    state.replies.push('```json\n{"action":"retry","retryNodeRunIds":["bogus"],"rationale":"again"}\n```');
    result = await start(workflow({ twoStages: false }));
    expect(result.run.gateDecisions[0]).toMatchObject({ action: 'advance', degraded: true });

    state.runs.clear();
    result = await start(workflow({ twoStages: false, gateModel: 'gate-slow' }));
    expect(result.run.gateDecisions[0]).toMatchObject({ action: 'advance', degraded: true });
    expect(result.run.gateDecisions[0]?.rationale).toContain('timed out');
  }, 5000);

  it('sweeps stale persisted pids and marks non-terminal runs aborted on boot', async () => {
    const def = workflow({ twoStages: false });
    const stale: RunSnapshot = {
      runId: 'stale', workspaceId: 'ws', workflow: def, task: 'old', status: 'running', currentStageId: 'round', createdAt: 1, gateDecisions: [],
      nodes: [{ nodeRunId: 'round.candidate.0', stageId: 'round', slotId: 'candidate', instanceIndex: 0, agent: binding('ok'), label: 'Candidate · mock', status: 'running', attempt: 1, cwd: '/tmp/workspace', pid: 45678 }],
    };
    state.runs.set(stale.runId, stale);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await sweepOnBoot();
    const swept = state.runs.get('stale');
    expect(kill).toHaveBeenCalledWith(-45678, 'SIGTERM');
    expect(swept).toMatchObject({ status: 'aborted', nodes: [{ status: 'killed' }] });
    expect(swept?.nodes[0]?.pid).toBeUndefined();
    expect(readEventsAfter('stale').at(-1)?.data?.detail).toBe('server-restart');
    kill.mockRestore();
  });
});
