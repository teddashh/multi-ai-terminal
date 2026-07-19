import type { AgentEvent, GateDecision, NodeRun, RunSnapshot } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { canRetryStage, decisionDisplay, formatElapsed, nodeDisplayStatus, verificationSummary } from './runLogic.js';

const node: NodeRun = {
  nodeRunId: 's1.r1.0', stageId: 's1', slotId: 'r1', instanceIndex: 0,
  agent: { provider: 'codex', permission: 'safe' }, label: 'R1 · codex', status: 'running', attempt: 1, cwd: 'test-workspace',
};
const event: AgentEvent = { id: 'e1', seq: 1, runId: 'run-1', stageId: 's1', nodeRunId: node.nodeRunId, attempt: 1, role: 'thinking', kind: 'thinking', text: 'reasoning', ts: 10 };
const decision: GateDecision = { stageId: 's1', gateAttempt: 1, action: 'advance', rationale: 'Ready', ts: 20 };

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-1', workspaceId: 'w1', task: 'Task', status: 'gating', currentStageId: 's1', createdAt: 1,
    workflow: {
      schemaVersion: 1, id: 'wf', name: 'Workflow', description: '', maxParallel: 2, maxRetriesPerStage: 2,
      orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 },
      stages: [{ id: 's1', name: 'One', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false }],
    },
    nodes: [node], gateDecisions: [], ...overrides,
  };
}

describe('run panel logic', () => {
  it('formats elapsed durations without rolling minutes past an hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_999)).toBe('1:05');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });

  it('shows thinking only as the latest-event display state of a running node', () => {
    expect(nodeDisplayStatus(node, event)).toBe('thinking');
    expect(nodeDisplayStatus({ ...node, status: 'stalled' }, event)).toBe('stalled');
    expect(nodeDisplayStatus(node, { ...event, kind: 'message', role: 'agent' })).toBe('running');
  });

  it('uses the degraded amber decision treatment only when flagged', () => {
    expect(decisionDisplay(decision)).toMatchObject({ degraded: false, label: 'advance' });
    expect(decisionDisplay({ ...decision, degraded: true }).borderClass).toContain('amber');
    expect(decisionDisplay({ ...decision, degraded: true }).label).toBe('advance · degraded');
  });

  it('enables retry only in the API validity window and below the gate budget', () => {
    const gated = run({ workflow: { ...run().workflow, orchestrator: { ...run().workflow.orchestrator, enabled: true } } });
    expect(canRetryStage(gated, 's1')).toBe(true);
    expect(canRetryStage(run({ status: 'running' }), 's1')).toBe(false);
    expect(canRetryStage({ ...gated, status: 'done', gateDecisions: [decision] }, 's1')).toBe(true);
    expect(canRetryStage({ ...gated, gateDecisions: [decision, { ...decision, gateAttempt: 2 }, { ...decision, gateAttempt: 3 }] }, 's1')).toBe(false);
    expect(canRetryStage(run({ nodes: [{ ...node, attempt: 3 }] }), 's1')).toBe(false);
  });

  it('summarizes normalized verification states', () => {
    expect(verificationSummary([
      { ...node, verification: { status: 'passed' } },
      { ...node, nodeRunId: 'failed', verification: { status: 'failed' } },
      { ...node, nodeRunId: 'error', verification: { status: 'error', reason: 'timeout' } },
      { ...node, nodeRunId: 'skipped', verification: { status: 'skipped', reason: 'no-changes' } },
      { ...node, nodeRunId: 'unconfigured', verification: { status: 'skipped', reason: 'no-verify-command' } },
      { ...node, nodeRunId: 'absent' },
    ])).toEqual({ passed: 1, failed: 2, skipped: 1 });
  });
});
