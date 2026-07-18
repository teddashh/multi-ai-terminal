import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentEventSchema, RunSnapshotSchema, WorkflowDefSchema, applyWorkflowDefaults } from './index.js';

describe('shared schemas', () => {
  it('round-trips an event', () => {
    const event = { id: 'e1', seq: 1, runId: 'r1', stageId: null, nodeRunId: null, attempt: 0, role: 'system', kind: 'status', text: 'ready', ts: 1 };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('round-trips a run snapshot', () => {
    const workflow = preset('planning');
    const run = { runId: 'run', workspaceId: 'ws', workflow, task: 'task', status: 'created', nodes: [], gateDecisions: [], createdAt: 1 };
    expect(RunSnapshotSchema.parse(run)).toEqual(run);
  });

  it('applies workflow defaults', () => {
    const value = preset('planning') as Record<string, unknown>;
    delete value.maxParallel;
    delete value.maxRetriesPerStage;
    expect(applyWorkflowDefaults(value)).toMatchObject({ maxParallel: 4, maxRetriesPerStage: 2 });
  });

  it('enforces the per-stage fan-out cap', () => {
    const value = preset('planning');
    value.stages[0]!.slots[0]!.count = 8;
    value.stages[0]!.slots[1]!.count = 8;
    expect(WorkflowDefSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['workflow id', (value: any) => { value.id = '../escape'; }],
    ['stage id', (value: any) => { value.stages[0].id = '../../escape'; }],
    ['slot id', (value: any) => { value.stages[0].slots[0].id = 'a/b'; }],
  ])('rejects traversal in %s', (_label, mutate) => {
    const value = preset('planning');
    mutate(value);
    expect(WorkflowDefSchema.safeParse(value).success).toBe(false);
  });
});

describe('builtin presets', () => {
  for (const name of ['planning', 'build', 'review']) {
    it(`${name} parses as WorkflowDef`, () => expect(WorkflowDefSchema.parse(preset(name))).toBeTruthy());
  }
});

function preset(name: string): any {
  const path = fileURLToPath(new URL(`./presets/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}
