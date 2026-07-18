import type { ProviderInfo, Stage, WorkflowDef } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import {
  appendSlotWithProviderDefaults,
  createRunRequest,
  reduceWorkflowEdit,
  stageAgentCount,
  validateSlotCount,
} from './logic.js';

const provider: ProviderInfo = {
  id: 'codex', tier: 'rich', ok: true, models: ['gpt-test'], defaultModel: 'gpt-test',
};

const stage = (counts = [1]): Stage => ({
  id: 'plan', name: 'Plan', isolation: 'none', join: 'all', timeoutSec: 1_800,
  stallSec: 240, gate: true,
  slots: counts.map((count, index) => ({
    id: `slot-${index + 1}`, label: `Slot ${index + 1}`, count,
    agent: { provider: 'codex', model: 'base', permission: 'safe' },
    promptTemplate: '{{task}}',
  })),
});

const workflow = (): WorkflowDef => ({
  schemaVersion: 1, id: 'planning', name: 'Planning', description: 'Plan carefully', builtin: true,
  orchestrator: {
    enabled: true, gateTimeoutSec: 300,
    agent: { provider: 'claude', model: 'sonnet', permission: 'auto' },
  },
  stages: [stage()], maxParallel: 4, maxRetriesPerStage: 2,
});

describe('workflow panel logic', () => {
  it('validates slot bounds and the 12-agent stage sum', () => {
    const value = stage([8, 3]);
    expect(stageAgentCount(value)).toBe(11);
    expect(validateSlotCount(value, 'slot-2', 4)).toEqual({ valid: true, total: 12 });
    expect(validateSlotCount(value, 'slot-2', 5)).toMatchObject({ valid: false, total: 13 });
    expect(validateSlotCount(value, 'slot-1', 9)).toMatchObject({ valid: false, message: 'Count must be between 1 and 8.' });
  });

  it('reduces edits into a deep ephemeral copy and produces a workflowOverride', () => {
    const original = workflow();
    const edits = reduceWorkflowEdit({}, original, (copy) => {
      copy.stages[0]!.slots[0]!.count = 3;
      copy.orchestrator.agent.permission = 'full';
    });
    const request = createRunRequest('workspace-1', original, '  solve this  ', edits);

    expect(original.stages[0]!.slots[0]!.count).toBe(1);
    expect(original.orchestrator.agent.permission).toBe('auto');
    expect(request).toMatchObject({ workspaceId: 'workspace-1', workflowId: 'planning', task: 'solve this' });
    expect(request.workflowOverride?.stages[0]!.slots[0]!.count).toBe(3);
    expect(request.workflowOverride).not.toBe(edits.planning);
  });

  it('omits workflowOverride when the workflow has not been edited', () => {
    expect(createRunRequest('workspace-1', workflow(), 'task', {})).toEqual({
      workspaceId: 'workspace-1', workflowId: 'planning', task: 'task',
    });
  });

  it('appends a uniquely identified slot with provider defaults without mutating the stage', () => {
    const original = stage();
    original.slots.push({ ...original.slots[0]!, id: 'codex-1' });
    const appended = appendSlotWithProviderDefaults(original, provider);

    expect(original.slots).toHaveLength(2);
    expect(appended.slots).toHaveLength(3);
    expect(appended.slots.at(-1)).toEqual({
      id: 'codex-2', label: 'CODEX 2', count: 1,
      agent: { provider: 'codex', model: 'gpt-test', permission: 'auto' },
      promptTemplate: '{{task}}',
    });
  });

  it('does not append beyond the 12-agent stage cap', () => {
    const full = stage([8, 4]);
    expect(appendSlotWithProviderDefaults(full, provider)).toBe(full);
  });
});
