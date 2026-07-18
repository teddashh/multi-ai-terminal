import type { ProviderInfo, RunCreateRequest, Slot, Stage, WorkflowDef } from '@mat/shared';

export const MAX_STAGE_AGENTS = 12;
export const MAX_SLOT_COUNT = 8;

export function cloneWorkflow(workflow: WorkflowDef): WorkflowDef {
  return {
    ...workflow,
    orchestrator: { ...workflow.orchestrator, agent: { ...workflow.orchestrator.agent } },
    stages: workflow.stages.map((stage) => ({
      ...stage,
      slots: stage.slots.map((slot) => ({ ...slot, agent: { ...slot.agent } })),
    })),
  };
}

export function stageAgentCount(stage: Stage): number {
  return stage.slots.reduce((sum, slot) => sum + slot.count, 0);
}

export interface SlotCountValidation { valid: boolean; total: number; message?: string }

export function validateSlotCount(stage: Stage, slotId: string, nextCount: number): SlotCountValidation {
  if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > MAX_SLOT_COUNT) {
    return { valid: false, total: stageAgentCount(stage), message: 'Count must be between 1 and 8.' };
  }
  const current = stage.slots.find((slot) => slot.id === slotId);
  if (!current) return { valid: false, total: stageAgentCount(stage), message: 'Slot not found.' };
  const total = stageAgentCount(stage) - current.count + nextCount;
  return total <= MAX_STAGE_AGENTS
    ? { valid: true, total }
    : { valid: false, total, message: 'A stage can run at most 12 agents.' };
}

function nextSlotNumber(stage: Stage, provider: string): number {
  const prefix = `${provider}-`;
  const used = new Set(stage.slots.map((slot) => slot.id));
  let number = 1;
  while (used.has(`${prefix}${number}`)) number += 1;
  return number;
}

export function appendSlotWithProviderDefaults(stage: Stage, provider: ProviderInfo): Stage {
  if (stageAgentCount(stage) >= MAX_STAGE_AGENTS) return stage;
  const number = nextSlotNumber(stage, provider.id);
  const slot: Slot = {
    id: `${provider.id}-${number}`,
    label: `${provider.id.toUpperCase()} ${number}`,
    agent: { provider: provider.id, model: provider.defaultModel, permission: 'auto' },
    count: 1,
    promptTemplate: '{{task}}',
  };
  return { ...stage, slots: [...stage.slots, slot] };
}

export type EphemeralWorkflowEdits = Record<string, WorkflowDef>;

export function reduceWorkflowEdit(
  edits: EphemeralWorkflowEdits,
  workflow: WorkflowDef,
  update: (copy: WorkflowDef) => void,
): EphemeralWorkflowEdits {
  const copy = cloneWorkflow(edits[workflow.id] ?? workflow);
  update(copy);
  return { ...edits, [workflow.id]: copy };
}

export function createRunRequest(
  workspaceId: string,
  workflow: WorkflowDef,
  task: string,
  edits: EphemeralWorkflowEdits,
): RunCreateRequest {
  const override = edits[workflow.id];
  return {
    workspaceId,
    workflowId: workflow.id,
    task: task.trim(),
    ...(override ? { workflowOverride: cloneWorkflow(override) } : {}),
  };
}
