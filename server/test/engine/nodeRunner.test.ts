import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, NodeRun, Stage } from '@mat/shared';
import type { Adapter, NodeOutcome, SpawnedNode } from '../../src/adapters/base.js';
import { EventLog, configureEventLog } from '../../src/store/eventLog.js';
import { emitRetryBoundary, killActiveNode, registerNodeContext, runNode } from '../../src/engine/nodeRunner.js';

const dirs: string[] = [];
const oldDataDir = process.env.MAT_DATA_DIR;
const stage: Stage = { id: 's', name: 'Stage', slots: [], isolation: 'none', join: 'all', timeoutSec: 10, stallSec: 10, gate: false };
const makeNode = (): NodeRun => ({ nodeRunId: 's.slot.0', stageId: 's', slotId: 'slot', instanceIndex: 0, agent: { provider: 'mock', permission: 'safe' }, label: 'Slot · mock', status: 'queued', attempt: 1, cwd: '/' });

function setup(adapter: Adapter): { node: NodeRun; events: () => AgentEvent[]; persisted: { count: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'mat-node-')); dirs.push(dir);
  process.env.MAT_DATA_DIR = dir;
  const log = configureEventLog(dir);
  const node = makeNode();
  const persisted = { count: 0 };
  registerNodeContext(node, { runId: 'run', adapter, persist: async () => { persisted.count += 1; } });
  return { node, events: () => log.afterSeq('run'), persisted };
}

function adapterFrom(spawn: Adapter['spawn']): Adapter {
  return { id: 'mock', tier: 'rich', models: ['test'], defaultModel: 'test', available: async () => ({ ok: true }), spawn };
}

afterEach(async () => {
  vi.useRealTimers();
  if (oldDataDir === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = oldDataDir;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
});
