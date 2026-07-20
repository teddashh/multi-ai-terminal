import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentEventSchema, NodeRunSchema, ProviderInfoSchema, RunSnapshotSchema, StageSchema, SteerMessageSchema, SteerRequestSchema, WorkflowDefSchema, WorkspacePatchRequestSchema, WorkspaceSchema, applyWorkflowDefaults } from './index.js';

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

  it('round-trips evidence-plane fields', () => {
    const node = NodeRunSchema.parse({
      nodeRunId: 's.a.0', stageId: 's', slotId: 'a', instanceIndex: 0,
      agent: { provider: 'mock', permission: 'safe' }, label: 'A', status: 'done', attempt: 1, cwd: '/tmp',
      verification: { status: 'failed', command: 'npm test', exitCode: 1, durationMs: 25, outputTail: 'failed', reason: 'check failed', logFile: '/tmp/check.log' },
      handoff: { priorNodeRunIds: ['prior.a.0'], orchestratorContext: true, retryAddendum: false }, errorReason: 'mock is not signed in.',
    });
    expect(node.verification?.status).toBe('failed');
    expect(node.handoff?.priorNodeRunIds).toEqual(['prior.a.0']);
    expect(node.errorReason).toBe('mock is not signed in.');
    expect(RunSnapshotSchema.parse({ runId: 'r', workspaceId: 'w', workflow: preset('pipeline'), task: 't', status: 'done', nodes: [node], gateDecisions: [], providerVersions: { mock: 'mock/0' }, createdAt: 1, endedAt: 2 }).providerVersions).toEqual({ mock: 'mock/0' });
    expect(WorkspaceSchema.parse({ id: 'w', name: 'W', path: '/tmp', isGit: true, verifyCommand: 'npm test', verifyTimeoutSec: 60 })).toMatchObject({ verifyCommand: 'npm test', verifyTimeoutSec: 60 });
    expect(WorkspacePatchRequestSchema.parse({ verifyCommand: null, verifyTimeoutSec: null })).toEqual({ verifyCommand: null, verifyTimeoutSec: null });
    expect(StageSchema.parse({ id: 's', name: 'S', slots: [{ id: 'a', label: 'A', agent: { provider: 'mock', permission: 'safe' }, count: 1, promptTemplate: '' }] }).requireVerified).toBe(false);
  });

  it('keeps provider auth additions optional and strict', () => {
    const provider = { id: 'codex', tier: 'rich', ok: true, installable: true, models: ['gpt'], defaultModel: 'gpt', authAlert: { message: 'sign in', at: 1, runId: 'run' }, signInCommand: 'codex login' };
    expect(ProviderInfoSchema.parse(provider)).toEqual(provider);
    expect(ProviderInfoSchema.safeParse({ ...provider, extra: true }).success).toBe(false);
    const { authAlert: _alert, signInCommand: _command, ...legacy } = provider;
    expect(ProviderInfoSchema.parse(legacy)).toEqual(legacy);
  });

  it('enforces the per-stage fan-out cap', () => {
    const value = preset('planning');
    value.stages[0]!.slots[0]!.count = 8;
    value.stages[0]!.slots[1]!.count = 8;
    expect(WorkflowDefSchema.safeParse(value).success).toBe(false);
  });

  it('validates steer messages and defaults steer requests to interrupt', () => {
    const steer = { steerId: 's_1', text: 'change direction', mode: 'interrupt', status: 'pending', createdAt: 1 };
    expect(SteerMessageSchema.parse(steer)).toEqual(steer);
    expect(SteerRequestSchema.parse({ text: 'change direction' })).toEqual({ text: 'change direction', mode: 'interrupt' });
    expect(SteerRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(SteerRequestSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(SteerMessageSchema.safeParse({ ...steer, extra: true }).success).toBe(false);
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
  for (const name of ['planning', 'build', 'review', 'pipeline']) {
    it(`${name} parses as WorkflowDef`, () => expect(WorkflowDefSchema.parse(preset(name))).toBeTruthy());
  }
});

function preset(name: string): any {
  const path = fileURLToPath(new URL(`./presets/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}
