import { describe, expect, it } from 'vitest';
import type { RunSnapshot, Stage } from '@mat/shared';
import { parseDecision, tryParseDecision } from '../../src/orchestrator/decision.js';
import { buildGatePrompt, renderTemplate } from '../../src/orchestrator/prompts.js';

const stage: Stage = { id: 'round', name: 'Round Table', slots: [], isolation: 'none', join: 'all', timeoutSec: 30, stallSec: 10, gate: true };
const run = {
  runId: 'run-1', workspaceId: 'ws', task: 'Ship it', status: 'gating', currentStageId: 'round', createdAt: 1,
  workflow: { schemaVersion: 1, id: 'wf', name: 'Plan', description: '', orchestrator: { enabled: true, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 5 }, stages: [stage], maxParallel: 2, maxRetriesPerStage: 2 },
  nodes: [], gateDecisions: [],
} satisfies RunSnapshot;

describe('orchestrator decisions and prompts', () => {
  it('extracts the last fenced JSON block and filters retry ids', () => {
    const text = 'old ```json\n{"action":"abort","rationale":"old"}\n```\nnew ```json\n{"action":"retry","retryNodeRunIds":["round.r.0","made-up"],"promptAddendum":"focus","rationale":"again"}\n```';
    expect(tryParseDecision(text, 'round', 2, ['round.r.0'])).toMatchObject({ action: 'retry', retryNodeRunIds: ['round.r.0'], promptAddendum: 'focus' });
  });

  it('degrades invalid JSON and empty validated retries to advance', () => {
    expect(parseDecision('not json', 'round', 1, [])).toMatchObject({ action: 'advance', degraded: true });
    const invalidIds = '```json\n{"action":"retry","retryNodeRunIds":["wrong"],"rationale":"retry"}\n```';
    expect(parseDecision(invalidIds, 'round', 1, ['round.r.0'])).toMatchObject({ action: 'advance', degraded: true });
  });

  it('renders known variables, erases unknown variables, and builds the required gate brief', () => {
    expect(renderTemplate('{{task}}/{{missing}}/{{ instance_index }}', { task: 'x', instance_index: 2 })).toBe('x//2');
    const prompt = buildGatePrompt(run, stage, 'candidate digest');
    expect(prompt).toContain('Goal: Ship it');
    expect(prompt).toContain('candidate digest');
    expect(prompt).toContain('fenced json block');
  });
});
