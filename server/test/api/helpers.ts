import type { ApiRouteDependencies } from '../../src/api/routes.js';
import type { AgentEvent, RunCreateRequest, RunSnapshot, WorkflowDef, Workspace } from '@mat/shared';
import { tmpdir } from 'node:os';

export const workflow = (overrides: Partial<WorkflowDef> = {}): WorkflowDef => ({
  schemaVersion: 1,
  id: 'custom',
  name: 'Custom',
  description: 'Test workflow',
  orchestrator: {
    enabled: false,
    agent: { provider: 'mock', model: 'ok', permission: 'safe' },
    gateTimeoutSec: 30,
  },
  stages: [{
    id: 'stage-1',
    name: 'Stage One',
    slots: [{
      id: 'slot-1',
      label: 'Candidate',
      agent: { provider: 'mock', model: 'ok', permission: 'safe' },
      count: 1,
      promptTemplate: '{{task}}',
    }],
    isolation: 'none',
    join: 'all',
    timeoutSec: 60,
    stallSec: 30,
    gate: true,
    requireVerified: false,
  }],
  maxParallel: 1,
  maxRetriesPerStage: 2,
  ...overrides,
});

export const runSnapshot = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  runId: 'run-1',
  workspaceId: 'workspace-1',
  workflow: workflow(),
  task: 'test task',
  status: 'done',
  currentStageId: 'stage-1',
  nodes: [{
    nodeRunId: 'stage-1.slot-1.0',
    stageId: 'stage-1',
    slotId: 'slot-1',
    instanceIndex: 0,
    agent: { provider: 'mock', model: 'ok', permission: 'safe' },
    label: 'Candidate · mock',
    status: 'done',
    attempt: 1,
    cwd: tmpdir(),
  }],
  gateDecisions: [],
  createdAt: 100,
  endedAt: 200,
  ...overrides,
});

export const event = (runId = 'run-1', seq = 1): AgentEvent => ({
  id: `event-${seq}`,
  seq,
  runId,
  stageId: null,
  nodeRunId: null,
  attempt: 0,
  role: 'system',
  kind: 'status',
  text: `event ${seq}`,
  ts: seq,
});

export function fakeApiDependencies(run = runSnapshot()): ApiRouteDependencies {
  let currentRun = structuredClone(run);
  const workspaces: Workspace[] = [];
  const workflows = [workflow()];
  return {
    providers: async () => [],
    report: (snapshot) => `# Run report — ${snapshot.workflow.name}\n`,
    workspaces: {
      list: async () => workspaces,
      get: async (id) => {
        const found = workspaces.find((workspace) => workspace.id === id);
        if (!found) throw Object.assign(new Error(`Workspace not found: ${id}`), { code: 'NOT_FOUND' });
        return found;
      },
      create: async (value) => {
        const created: Workspace = { ...value, id: 'workspace-1', isGit: false };
        workspaces.push(created);
        return created;
      },
      update: async (id, value) => {
        const index = workspaces.findIndex((workspace) => workspace.id === id);
        if (index < 0) throw Object.assign(new Error(`Workspace not found: ${id}`), { code: 'NOT_FOUND' });
        const next = { ...workspaces[index]!, ...value };
        if (Object.hasOwn(value, 'verifyCommand') && value.verifyCommand === undefined) delete next.verifyCommand;
        if (Object.hasOwn(value, 'verifyTimeoutSec') && value.verifyTimeoutSec === undefined) delete next.verifyTimeoutSec;
        workspaces[index] = next;
        return workspaces[index]!;
      },
      delete: async (id) => {
        const index = workspaces.findIndex((workspace) => workspace.id === id);
        if (index < 0) throw Object.assign(new Error(`Workspace not found: ${id}`), { code: 'NOT_FOUND' });
        workspaces.splice(index, 1);
      },
    },
    workflows: {
      list: async () => workflows,
      create: async (value) => value,
      update: async (id, value) => ({ ...workflows.find((item) => item.id === id)!, ...value }),
      delete: async () => undefined,
      duplicate: async (id) => ({ ...workflows.find((item) => item.id === id)!, id: `${id}-copy`, name: 'Custom Copy' }),
    },
    runs: {
      create: async (request: RunCreateRequest, providerVersions?: Record<string, string>) => {
        currentRun = runSnapshot({
          workspaceId: request.workspaceId,
          task: request.task,
          workflow: request.workflowOverride ?? workflow({ id: request.workflowId }),
          status: 'created',
          endedAt: undefined,
          ...(providerVersions ? { providerVersions } : {}),
        } as Partial<RunSnapshot>);
        return currentRun;
      },
      list: async () => [currentRun],
      get: async (id) => {
        if (id !== currentRun.runId) throw Object.assign(new Error(`Run not found: ${id}`), { code: 'NOT_FOUND' });
        return currentRun;
      },
      delete: async () => undefined,
      events: () => [event(currentRun.runId)],
      patch: async () => 'diff --git a/a b/a\n',
      abort: async () => { currentRun = { ...currentRun, status: 'aborted' }; },
      killNode: async (_runId, nodeRunId) => {
        currentRun = { ...currentRun, nodes: currentRun.nodes.map((node) => node.nodeRunId === nodeRunId ? { ...node, status: 'killed' } : node) };
      },
      retryStage: async (_runId, stageId) => ({ ...currentRun, status: 'running', currentStageId: stageId }),
      steer: async (_runId, request) => ({ ...currentRun, steers: [{ steerId: 's_test', text: request.text, mode: request.mode ?? 'interrupt', status: 'pending', createdAt: Date.now() }] }),
      applyPatch: async () => ({ ok: true, message: 'Applied' }),
    },
  };
}
