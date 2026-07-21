import type { AgentEvent, RunSnapshot } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { buildNarrativeItems, filterNarrativeItems, flattenNarrativeSources, resolveNarrativeActor } from './narrativeLogic.js';

const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', task: 'Explain it', status: 'running', createdAt: 1,
  workflow: {
    schemaVersion: 1, id: 'wf', name: 'Plan', description: '', maxParallel: 2, maxRetriesPerStage: 1,
    orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 },
    stages: [{ id: 's1', name: 'Round Table', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: false, requireVerified: false }],
  },
  nodes: [
    { nodeRunId: 's1.a.0', stageId: 's1', slotId: 'a', instanceIndex: 0, agent: { provider: 'codex', model: 'gpt-test', permission: 'safe' }, label: 'Planner · codex', status: 'running', attempt: 1, cwd: '/repo' },
    { nodeRunId: 's1.a.1', stageId: 's1', slotId: 'a', instanceIndex: 1, agent: { provider: 'codex', model: 'gpt-test', permission: 'safe' }, label: 'Planner · codex', status: 'running', attempt: 1, cwd: '/repo' },
  ], gateDecisions: [],
};

const event = (seq: number, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${seq}`, seq, runId: 'r1', stageId: 's1', nodeRunId: 's1.a.0', attempt: 1,
  role: 'agent', kind: 'message', text: String(seq), ts: seq, ...overrides,
});

describe('narrative projection', () => {
  it('merges only adjacent compatible text while preserving every source event', () => {
    const events = [
      event(1, { text: 'Hello ' }), event(2, { text: 'world' }),
      event(3, { role: 'system', kind: 'status', text: 'spawned' }),
      event(4, { role: 'system', kind: 'status', text: 'running' }),
      event(5, { nodeRunId: 's1.a.1', text: 'Other' }),
    ];
    const items = buildNarrativeItems(run, events);
    expect(items[0]).toMatchObject({ kind: 'message', text: 'Hello world', seqStart: 1, seqEnd: 2, key: 'e1' });
    expect(items.map((item) => item.text)).toEqual(['Hello world', 'spawned', 'running', 'Other']);
    expect(flattenNarrativeSources(items).map((source) => source.id)).toEqual(events.map((source) => source.id));
  });

  it('never pairs a delayed tool result across intervening evidence', () => {
    const use = event(1, { role: 'tool', kind: 'tool_use', text: 'run', tool: { name: 'shell', toolCallId: 't1', input: 'npm test' } });
    const result = event(2, { role: 'tool', kind: 'tool_result', text: 'pass', tool: { name: 'shell', toolCallId: 't1', output: 'PASS' } });
    expect(buildNarrativeItems(run, [use, result])).toHaveLength(1);
    const delayed = buildNarrativeItems(run, [use, event(2, { text: 'meanwhile' }), { ...result, id: 'e3', seq: 3, ts: 3 }]);
    expect(delayed.map((item) => item.kind)).toEqual(['tool', 'message', 'tool']);
    expect(flattenNarrativeSources(delayed).map((source) => source.seq)).toEqual([1, 2, 3]);
  });

  it('makes internal sequence gaps visible without inventing source evidence', () => {
    const items = buildNarrativeItems(run, [event(1), event(4)]);
    expect(items[1]).toMatchObject({ kind: 'gap', gap: { fromSeq: 2, toSeq: 3 } });
    expect(flattenNarrativeSources(items).map((source) => source.seq)).toEqual([1, 4]);
  });

  it('classifies verification, decisions, errors, and filters technical detail after projection', () => {
    const items = buildNarrativeItems(run, [
      event(1, { role: 'user', text: 'prompt' }),
      event(2, { role: 'thinking', kind: 'thinking', text: 'thinking' }),
      event(3, { role: 'system', kind: 'result', text: 'passed', data: { detail: 'verify-result' } }),
      event(4, { role: 'decision', kind: 'decision', nodeRunId: null, text: 'advance' }),
      event(5, { role: 'system', kind: 'error', text: 'Fix: sign in' }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['prompt', 'thinking', 'verification', 'decision', 'error']);
    expect(filterNarrativeItems(items).map((item) => item.kind)).toEqual(['verification', 'decision', 'error']);
    expect(filterNarrativeItems(items, { showTechnical: true, search: 'thinking' })).toHaveLength(1);
  });

  it('resolves stable node identity with an ordinal for repeated seats', () => {
    expect(resolveNarrativeActor(run, event(1))).toMatchObject({ label: 'Planner · codex · #1', provider: 'codex', model: 'gpt-test', stageName: 'Round Table' });
    expect(resolveNarrativeActor(run, event(1, { nodeRunId: 'legacy.unknown' }))).toMatchObject({ label: 'legacy.unknown', nodeRunId: 'legacy.unknown' });
  });
});
