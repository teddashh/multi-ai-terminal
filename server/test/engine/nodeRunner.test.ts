import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, NodeRun, ProviderId, Stage } from '@mat/shared';
import type { Adapter, NodeOutcome, SpawnedNode } from '../../src/adapters/base.js';
import { EventLog, configureEventLog } from '../../src/store/eventLog.js';
import { emitRetryBoundary, killActiveNode, markNodeKilled, registerNodeContext, resetNodeForRetry, runNode } from '../../src/engine/nodeRunner.js';
import { clearAllAuthAlerts, getAuthAlert } from '../../src/providers/auth.js';
import { mockAdapter } from '../../src/adapters/mock.js';
import { clearProviderSpawnSlots } from '../../src/adapters/base.js';

const dirs: string[] = [];
const oldDataDir = process.env.MAT_DATA_DIR;
const stage: Stage = { id: 's', name: 'Stage', slots: [], isolation: 'none', join: 'all', timeoutSec: 10, stallSec: 10, gate: false, requireVerified: false };
const makeNode = (): NodeRun => ({ nodeRunId: 's.slot.0', stageId: 's', slotId: 'slot', instanceIndex: 0, agent: { provider: 'mock', permission: 'safe' }, label: 'Slot · mock', status: 'queued', attempt: 1, cwd: '/' });

function setup(adapter: Adapter, persist?: () => Promise<void>): { node: NodeRun; events: () => AgentEvent[]; persisted: { count: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'mat-node-')); dirs.push(dir);
  process.env.MAT_DATA_DIR = dir;
  const log = configureEventLog(dir);
  const node = makeNode();
  const persisted = { count: 0 };
  registerNodeContext(node, { runId: 'run', adapter, persist: persist ?? (async () => { persisted.count += 1; }) });
  return { node, events: () => log.afterSeq('run'), persisted };
}

function adapterFrom(spawn: Adapter['spawn'], id: ProviderId = 'mock'): Adapter {
  return { id, tier: 'rich', models: ['test'], defaultModel: 'test', available: async () => ({ ok: true }), spawn };
}

afterEach(async () => {
  vi.useRealTimers();
  clearAllAuthAlerts();
  clearProviderSpawnSlots();
  if (oldDataDir === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = oldDataDir;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe('node runner lifecycle', () => {
  it('synthesizes the user prompt before spawned/running and stamps synchronous adapter content', async () => {
    const adapter = adapterFrom((_spec, io) => {
      io.onRaw('content', 'out');
      io.onEvent({ role: 'agent', kind: 'message', text: 'answer' });
      return { pid: 12345, kill() {}, completion: Promise.resolve({ exitCode: 0, resultText: 'answer' }) };
    });
    const { node, events, persisted } = setup(adapter);
    await runNode(node, stage, 'rendered prompt');
    expect(events().map((event) => [event.role, event.kind, event.data?.status])).toEqual([
      ['user', 'message', undefined],
      ['system', 'status', 'spawned'],
      ['system', 'status', 'running'],
      ['agent', 'message', undefined],
      ['system', 'result', undefined],
    ]);
    expect(events().every((event) => event.runId === 'run' && event.nodeRunId === node.nodeRunId && event.attempt === 1)).toBe(true);
    expect(node.status).toBe('done');
    expect(node.pid).toBeUndefined();
    expect(persisted.count).toBeGreaterThanOrEqual(2);
  });

  it('emits retry boundaries and uses the fully re-rendered addendum prompt on a fresh attempt', async () => {
    let spawns = 0;
    const adapter = adapterFrom(() => {
      spawns += 1;
      return { pid: 12345 + spawns, kill() {}, completion: Promise.resolve({ exitCode: 0, resultText: `answer-${spawns}` }) };
    });
    const { node, events } = setup(adapter);
    await runNode(node, stage, 'first prompt');
    node.attempt += 1;
    node.status = 'queued';
    emitRetryBoundary(node);
    await runNode(node, stage, 'full prompt; retry addendum: inspect tests');
    const second = events().filter((event) => event.attempt === 2);
    expect(second[0]).toMatchObject({ kind: 'status', data: { status: 'retry', attempt: 2 } });
    expect(second[1]).toMatchObject({ role: 'user', text: 'full prompt; retry addendum: inspect tests' });
    expect(spawns).toBe(2);
  });

  it('marks a silent node stalled, recovers on raw activity, and group-kills an active attempt', async () => {
    vi.useFakeTimers();
    let resolve!: (outcome: NodeOutcome) => void;
    let killed = false;
    const adapter = adapterFrom((_spec, io): SpawnedNode => {
      const completion = new Promise<NodeOutcome>((done) => { resolve = done; });
      setTimeout(() => io.onRaw('awake', 'out'), 20);
      setTimeout(() => resolve({ exitCode: 0, resultText: 'done' }), 30);
      return { pid: 12345, completion, kill() { killed = true; resolve({ exitCode: null, error: 'killed' }); } };
    });
    const { node, events } = setup(adapter);
    const running = runNode(node, { ...stage, stallSec: 0.01 }, 'prompt');
    await vi.advanceTimersByTimeAsync(11);
    expect(events().some((event) => event.data?.status === 'stalled')).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(events().some((event) => event.data?.detail === 'recovered')).toBe(true);
    expect(killActiveNode('run', node.nodeRunId, 'abort')).toBe(true);
    await running;
    expect(killed).toBe(true);
    expect(node.status).toBe('killed');
    expect(events().some((event) => event.data?.status === 'killed')).toBe(true);
  });

  it('hard-times out an attempt through the adapter group-kill surface and emits a failed error event', async () => {
    vi.useFakeTimers();
    let resolve!: (outcome: NodeOutcome) => void;
    let killSignal: NodeJS.Signals | undefined;
    const adapter = adapterFrom(() => ({
      pid: 12345,
      completion: new Promise<NodeOutcome>((done) => { resolve = done; }),
      kill(signal = 'SIGTERM') {
        killSignal = signal;
        resolve({ exitCode: null, signal, error: 'killed by timeout' });
      },
    }));
    const { node, events } = setup(adapter);
    const running = runNode(node, { ...stage, timeoutSec: 0.01 }, 'prompt');
    await vi.advanceTimersByTimeAsync(11);
    await running;
    expect(killSignal).toBe('SIGTERM');
    expect(node.status).toBe('failed');
    expect(events()).toContainEqual(expect.objectContaining({
      role: 'system',
      kind: 'error',
      data: expect.objectContaining({ status: 'failed', detail: 'timeout' }),
    }));
  });

  it('emits an error-category lifecycle event when a stalled attempt is killed', async () => {
    vi.useFakeTimers();
    let resolve!: (outcome: NodeOutcome) => void;
    const adapter = adapterFrom(() => ({
      pid: 12345,
      completion: new Promise<NodeOutcome>((done) => { resolve = done; }),
      kill(signal = 'SIGTERM') { resolve({ exitCode: null, signal, error: 'killed while stalled' }); },
    }));
    const { node, events } = setup(adapter);
    const running = runNode(node, { ...stage, stallSec: 0.01 }, 'prompt');
    await vi.advanceTimersByTimeAsync(11);
    expect(node.status).toBe('stalled');
    expect(killActiveNode('run', node.nodeRunId, 'user')).toBe(true);
    await running;
    expect(events()).toContainEqual(expect.objectContaining({
      role: 'system',
      kind: 'error',
      text: 'Stalled node attempt was killed',
      data: expect.objectContaining({ status: 'killed', detail: 'user' }),
    }));
  });

  it('normalizes synchronous spawn failures and nonzero outcomes into lifecycle error events', async () => {
    let setupResult = setup(adapterFrom(() => { throw new Error('spawn exploded'); }));
    await runNode(setupResult.node, stage, 'prompt');
    expect(setupResult.node.status).toBe('failed');
    expect(setupResult.node.error).toBe('spawn exploded');
    expect(setupResult.events()).toContainEqual(expect.objectContaining({
      role: 'system', kind: 'error', text: 'spawn exploded', data: expect.objectContaining({ status: 'failed' }),
    }));

    setupResult = setup(adapterFrom(() => ({
      pid: 12346,
      kill() {},
      completion: Promise.resolve({ exitCode: 7, error: 'provider failed' }),
    })));
    await runNode(setupResult.node, stage, 'prompt');
    expect(setupResult.node.status).toBe('failed');
    expect(setupResult.node.error).toBe('provider failed');
    expect(setupResult.events()).toContainEqual(expect.objectContaining({
      role: 'system', kind: 'error', text: 'provider failed', data: expect.objectContaining({ status: 'failed', exitCode: 7 }),
    }));
  });

  it('turns artifact-finalization failures into failed verification evidence', async () => {
    const adapter = adapterFrom(() => ({
      pid: 12345,
      kill() {},
      completion: Promise.resolve({ exitCode: 0, resultText: 'provider succeeded' }),
    }));
    const result = setup(adapter);
    registerNodeContext(result.node, {
      runId: 'run',
      adapter,
      persist: async () => undefined,
      finalize: async () => { throw new Error('artifact disk unavailable'); },
    });

    await runNode(result.node, { ...stage, isolation: 'worktree', gate: true, requireVerified: true }, 'prompt');

    expect(result.node).toMatchObject({
      status: 'failed',
      error: 'Artifact capture failed: artifact disk unavailable',
      verification: {
        status: 'error',
        reason: 'artifact-capture-failed',
        outputTail: 'artifact disk unavailable',
      },
    });
    expect(result.events()).toContainEqual(expect.objectContaining({
      role: 'system',
      kind: 'error',
      text: 'Artifact capture failed: artifact disk unavailable',
      data: expect.objectContaining({
        status: 'failed',
        detail: 'verify-result',
        phase: 'artifact-capture',
        verification: expect.objectContaining({ status: 'error', reason: 'artifact-capture-failed' }),
      }),
    }));
  });

  it('registers an auth alert from both output streams and clears it after provider success', async () => {
    const failing = adapterFrom((_spec, io) => {
      io.onRaw('request failed: 401 Unauthorized', 'out');
      io.onRaw('Please log out and sign in again', 'err');
      return { pid: 12345, kill() {}, completion: Promise.resolve({ exitCode: 1 }) };
    }, 'grok');
    const result = setup(failing); result.node.agent = { provider: 'grok', permission: 'safe' };
    await runNode(result.node, stage, 'prompt');
    expect(result.node.errorReason).toContain('grok sign-in expired.');
    expect(result.events()).toContainEqual(expect.objectContaining({ role: 'system', kind: 'error', data: expect.objectContaining({ detail: 'auth' }) }));
    expect(getAuthAlert('grok')).toMatchObject({ runId: 'run', nodeRunId: result.node.nodeRunId, message: result.node.errorReason });

    clearProviderSpawnSlots();
    const succeeding = setup(adapterFrom(() => ({ pid: 12346, kill() {}, completion: Promise.resolve({ exitCode: 0, resultText: 'ok' }) }), 'grok'));
    succeeding.node.agent = { provider: 'grok', permission: 'safe' };
    await runNode(succeeding.node, stage, 'prompt');
    expect(getAuthAlert('grok')).toBeUndefined();
  });

  it('redacts environment values from persisted prompts, provider output, snapshots, and raw logs', async () => {
    const sentinel = 'sk-ENV-SECRET-123';
    const prior = process.env.MAT_TEST_API_TOKEN;
    process.env.MAT_TEST_API_TOKEN = sentinel;
    try {
      let spawnedPrompt = '';
      const adapter = adapterFrom((spec, io) => {
        spawnedPrompt = spec.promptText;
        io.onRaw('Authentication required', 'err');
        io.onRaw(`Use API key ${sentinel}`, 'err');
        io.onEvent({
          role: 'agent',
          kind: 'tool_use',
          text: `provider echoed ${sentinel}`,
          tool: {
            name: 'credential-check',
            toolCallId: `call-${sentinel}`,
            input: `input=${sentinel}`,
            output: `output=${sentinel}`,
          },
          data: { nested: { echoed: sentinel } },
        });
        return {
          pid: 12345,
          kill() {},
          completion: Promise.resolve({
            exitCode: 1,
            resultText: `Use API key ${sentinel}`,
            error: `provider rejected ${sentinel}`,
          }),
        };
      }, 'grok');
      const result = setup(adapter);
      result.node.agent = { provider: 'grok', permission: 'safe' };
      const snapshots: string[] = [];
      registerNodeContext(result.node, {
        runId: 'run',
        adapter,
        persist: async () => { snapshots.push(JSON.stringify(result.node)); },
      });

      await runNode(result.node, stage, `prompt contains ${sentinel}`);

      expect(spawnedPrompt).toBe(`prompt contains ${sentinel}`);
      expect(result.node.errorReason).toBe('grok is not signed in.\nFix: grok login   (browser) · grok login --device-code (headless) · or set XAI_API_KEY');
      const raw = await readFile(join(process.env.MAT_DATA_DIR!, 'runs', 'run', 'raw', `${result.node.nodeRunId}.a1.jsonl`), 'utf8');
      const persisted = JSON.stringify({ node: result.node, events: result.events(), snapshots, raw });
      expect(persisted).not.toContain(sentinel);
      expect(persisted).toContain('[REDACTED_ENV]');
    } finally {
      if (prior === undefined) delete process.env.MAT_TEST_API_TOKEN;
      else process.env.MAT_TEST_API_TOKEN = prior;
    }
  }, 30_000);

  it('does not turn MOCK_AUTHFAIL output into a mock provider alert', async () => {
    const result = setup(mockAdapter); result.node.agent.model = 'MOCK_AUTHFAIL';
    await runNode(result.node, stage, 'prompt');
    expect(result.node.status).toBe('failed');
    expect(result.node.errorReason).toBeUndefined();
    expect(getAuthAlert('mock')).toBeUndefined();
  });

  it('does not spawn after a queued node is killed while prepare is blocked', async () => {
    let releasePrepare!: () => void;
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => { prepareStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const spawn = vi.fn(() => ({ pid: 12345, kill() {}, completion: Promise.resolve({ exitCode: 0, resultText: 'unexpected' }) }));
    const result = setup(adapterFrom(spawn));
    registerNodeContext(result.node, {
      runId: 'run',
      adapter: adapterFrom(spawn),
      prepare: async () => { prepareStarted(); await blocked; },
      persist: async () => undefined,
    });
    const running = runNode(result.node, stage, 'prompt');
    await started;
    markNodeKilled(result.node, 'run', 'user');
    releasePrepare();
    await running;
    expect(spawn).not.toHaveBeenCalled();
    expect(result.node.status).toBe('killed');
    expect(result.events().filter((event) => event.data?.status === 'killed')).toHaveLength(1);
  });

  it('reports a rejected fire-and-forget persist once and continues the attempt', async () => {
    vi.useFakeTimers();
    let resolve!: (outcome: NodeOutcome) => void;
    let calls = 0;
    const result = setup(adapterFrom(() => ({
      pid: 12345,
      kill() {},
      completion: new Promise<NodeOutcome>((done) => { resolve = done; }),
    })), async () => {
      calls += 1;
      if (calls === 2) throw new Error('disk temporarily unavailable');
    });
    const running = runNode(result.node, { ...stage, stallSec: 0.01 }, 'prompt');
    await vi.advanceTimersByTimeAsync(11);
    expect(result.events().filter((event) => event.data?.detail === 'persist-failed')).toHaveLength(1);
    resolve({ exitCode: 0, resultText: 'done' });
    await running;
    expect(result.node.status).toBe('done');
  });

  it('arms the hard timeout before the initial snapshot persist finishes', async () => {
    vi.useFakeTimers();
    let releasePersist!: () => void;
    const persistBlocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    let killed = false;
    let finish!: (outcome: NodeOutcome) => void;
    const result = setup(adapterFrom(() => ({
      pid: 12345,
      completion: new Promise<NodeOutcome>((resolve) => { finish = resolve; }),
      kill(signal = 'SIGTERM') { killed = true; finish({ exitCode: null, signal, error: 'timeout' }); },
    })), async () => persistBlocked);
    const running = runNode(result.node, { ...stage, timeoutSec: 0.01 }, 'prompt');
    await vi.advanceTimersByTimeAsync(11);
    expect(killed).toBe(true);
    releasePersist();
    await running;
    expect(result.node.status).toBe('failed');
  });

  it('uses one retry reset helper for attempt state, sessions, and tool counts', () => {
    const node = { ...makeNode(), status: 'done' as const, sessionRef: 'stale', resultText: 'old', pid: 123, startedAt: 1, endedAt: 2, verification: { status: 'passed' as const }, handoff: { priorNodeRunIds: ['old'], orchestratorContext: true, retryAddendum: true } };
    resetNodeForRetry(node);
    expect(node).toMatchObject({ attempt: 2, status: 'queued' });
    expect(node.sessionRef).toBeUndefined();
    expect(node.resultText).toBeUndefined();
    expect(node.verification).toBeUndefined();
    expect(node.handoff).toBeUndefined();
  });
});
