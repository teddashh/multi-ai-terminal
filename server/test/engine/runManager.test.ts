import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

import { appendEvent, configureEventLog, readEventsAfter } from '../../src/store/eventLog.js';
import { abortRun, applyPatch, createRun, killNode, retryStage, sweepOnBoot } from '../../src/engine/runManager.js';
import { waitForRun } from './fakes.js';

const dirs: string[] = [];
const oldDataDir = process.env.MAT_DATA_DIR;
const oldPath = process.env.PATH;

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
  state.workspace.isGit = false;
  const dir = mkdtempSync(join(tmpdir(), 'mat-run-')); dirs.push(dir);
  process.env.MAT_DATA_DIR = dir;
  configureEventLog(dir);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (oldDataDir === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = oldDataDir;
  process.env.PATH = oldPath;
  delete process.env.MAT_TEST_GIT_LOG;
  delete process.env.MAT_TEST_GIT_MARKER;
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
    expect(events.filter((event) => event.kind === 'decision').every((event) => event.stageId === null && event.nodeRunId === 'orchestrator')).toBe(true);
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

  it('keeps an immediate post-create abort terminal on the canonical live snapshot', async () => {
    const def = workflow({ candidateModel: 'slow', orchestrator: false, twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const created = await createRun({ workspaceId: 'ws', workflowId: 'wf', task: 'Abort immediately', workflowOverride: def });
    await abortRun(created.runId);
    const run = state.runs.get(created.runId);
    expect(run?.status).toBe('aborted');
    expect(run?.nodes[0]?.status).toBe('killed');
  });

  it('kills a queued node durably and never dispatches it later', async () => {
    const def = workflow({ candidateModel: 'slow', orchestrator: false, twoStages: false });
    def.maxParallel = 1;
    def.stages[0]!.slots[0]!.count = 2;
    const created = await createRun({ workspaceId: 'ws', workflowId: 'wf', task: 'Skip queued', workflowOverride: def });
    await waitForRun(() => state.runs.get(created.runId), (run) => run.nodes[0]?.status === 'running');
    await killNode(created.runId, 'round.candidate.1');
    await abortRun(created.runId);
    const events = readEventsAfter(created.runId, 0, 10_000);
    expect(state.runs.get(created.runId)?.nodes[1]?.status).toBe('killed');
    expect(events.filter((event) => event.nodeRunId === 'round.candidate.1' && event.role === 'user')).toHaveLength(0);
    expect(events.filter((event) => event.nodeRunId === 'round.candidate.1' && event.data?.status === 'killed')).toHaveLength(1);
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

  it('serializes concurrent terminal retries and rejects the duplicate with a typed conflict', async () => {
    const def = workflow({ orchestrator: false, twoStages: false, retries: 2 });
    def.stages[0]!.gate = false;
    def.stages[0]!.slots[0]!.count = 1;
    const first = await start(def);
    const results = await Promise.allSettled([
      retryStage(first.run.runId, 'round', { promptAddendum: 'first' }),
      retryStage(first.run.runId, 'round', { promptAddendum: 'duplicate' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
    const done = await waitForRun(() => state.runs.get(first.run.runId), (run) => run.status === 'done' && run.nodes[0]?.attempt === 2);
    expect(done.nodes[0]?.attempt).toBe(2);
    expect(readEventsAfter(first.run.runId, 0, 10_000).filter((event) => event.nodeRunId === 'round.candidate.0' && event.attempt === 2 && event.role === 'user')).toHaveLength(1);
  });

  it('records manual gate interruption as user-retry and accepts it as a normal retry', async () => {
    const def = workflow({ gateModel: 'gate-slow', twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const created = await createRun({ workspaceId: 'ws', workflowId: 'wf', task: 'Manual retry', workflowOverride: def });
    await waitForRun(() => state.runs.get(created.runId), (run) => run.status === 'gating');
    await retryStage(created.runId, 'round', { promptAddendum: 'try another angle' });
    await waitForRun(() => state.runs.get(created.runId), (run) => run.nodes[0]?.attempt === 2);
    const events = readEventsAfter(created.runId, 0, 10_000);
    expect(events).toContainEqual(expect.objectContaining({ nodeRunId: 'orchestrator', data: expect.objectContaining({ status: 'killed', detail: 'user-retry' }) }));
    await abortRun(created.runId);
  });

  it('records a synthetic decision for a gated stage when orchestration is disabled', async () => {
    const def = workflow({ orchestrator: false, twoStages: false });
    def.stages[0]!.slots[0]!.count = 1;
    const result = await start(def);
    expect(result.run.gateDecisions).toEqual([expect.objectContaining({ gateAttempt: 1, action: 'advance', rationale: 'Gate auto-advanced: orchestrator disabled', degraded: false })]);
    expect(result.events.find((event) => event.kind === 'decision')).toMatchObject({ stageId: null, nodeRunId: 'orchestrator' });
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
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await sweepOnBoot();
    const swept = state.runs.get('stale');
    expect(kill).toHaveBeenCalledWith(-45678, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).toHaveBeenCalledWith(-45678, 'SIGKILL');
    expect(swept).toMatchObject({ status: 'aborted', nodes: [{ status: 'killed' }] });
    expect(swept?.nodes[0]?.pid).toBeUndefined();
    expect(readEventsAfter('stale').at(-1)?.data?.detail).toBe('server-restart');
  });

  it('does not duplicate a server-restart recovery event already at the log tail', async () => {
    const def = workflow({ twoStages: false });
    state.runs.set('stale-tail', {
      runId: 'stale-tail', workspaceId: 'ws', workflow: def, task: 'old', status: 'running', currentStageId: 'round', createdAt: 1, gateDecisions: [], nodes: [],
    });
    appendEvent('stale-tail', { runId: 'stale-tail', stageId: null, nodeRunId: null, attempt: 0, role: 'system', kind: 'status', text: 'restarting', data: { status: 'aborted', detail: 'server-restart' } });
    await sweepOnBoot();
    expect(readEventsAfter('stale-tail').filter((event) => event.data?.detail === 'server-restart')).toHaveLength(1);
  });

  it('serializes patch applies per workspace and falls back when old Git rejects check-with-3way', async () => {
    const root = dirs.at(-1)!;
    const bin = join(root, 'bin');
    const log = join(root, 'git.log');
    const marker = join(root, 'applied');
    const patchFile = join(root, 'candidate.patch');
    await writeFile(patchFile, 'diff --git a/a b/a\n', 'utf8');
    await mkdir(bin);
    const git = join(bin, 'git');
    await writeFile(git, `#!/bin/sh
echo "$*" >> "$MAT_TEST_GIT_LOG"
case "$*" in
  *"rev-parse --is-inside-work-tree"*) echo true; exit 0 ;;
  *"apply --check --3way"*) echo "error: --check cannot be used together with --3way" >&2; exit 1 ;;
  *"apply --check --binary"*) if [ -f "$MAT_TEST_GIT_MARKER" ]; then echo "error: patch does not apply" >&2; exit 1; fi; exit 0 ;;
  *"apply --3way --binary"*) touch "$MAT_TEST_GIT_MARKER"; exit 0 ;;
esac
exit 1
`, 'utf8');
    await chmod(git, 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    process.env.MAT_TEST_GIT_LOG = log;
    process.env.MAT_TEST_GIT_MARKER = marker;
    state.workspace.isGit = true;
    const def = workflow({ orchestrator: false, twoStages: false });
    state.runs.set('patch-run', {
      runId: 'patch-run', workspaceId: 'ws', workflow: def, task: 'patch', status: 'done', currentStageId: 'round', createdAt: 1, endedAt: 2, gateDecisions: [],
      nodes: [{ nodeRunId: 'round.candidate.0', stageId: 'round', slotId: 'candidate', instanceIndex: 0, agent: binding('ok'), label: 'Candidate', status: 'done', attempt: 1, cwd: '/tmp/workspace', patchFile }],
    });

    const [first, second] = await Promise.all([applyPatch('patch-run', 'round.candidate.0'), applyPatch('patch-run', 'round.candidate.0')]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls.filter((line) => line.includes('apply --check --3way'))).toHaveLength(2);
    expect(calls.filter((line) => line.includes('apply --3way --binary') && !line.includes('--check'))).toHaveLength(1);
  });
});
