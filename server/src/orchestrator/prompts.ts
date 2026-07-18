import type { RunSnapshot, Stage } from '@mat/shared';

export type TemplateVariables = Record<string, string | number | null | undefined>;

/** Deliberately small mustache implementation: variables only, with unknowns erased. */
export function renderTemplate(template: string, variables: TemplateVariables): string {
  return template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_match, name: string) => {
    const value = variables[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function buildRunBrief(run: RunSnapshot): string {
  const stages = run.workflow.stages
    .map((stage, index) => `${index + 1}. ${stage.name} (${stage.slots.map((slot) => `${slot.label} x${slot.count}`).join(', ')})`)
    .join('\n');
  return [
    'You are the workflow orchestrator for Multi-AI Terminal.',
    'Choose only the minimum branch needed at each gate: advance, retry selected existing nodes, or abort.',
    `Workflow: ${run.workflow.name}`,
    `Goal: ${run.task}`,
    'Stages:',
    stages,
  ].join('\n');
}

export function buildGatePrompt(run: RunSnapshot, stage: Stage, digest: string, includeBrief = true, reask = false): string {
  const priorContext = [...run.gateDecisions].reverse().find((decision) => decision.contextForNext)?.contextForNext ?? '';
  const parts = includeBrief ? [buildRunBrief(run), ''] : [];
  parts.push(
    `Evaluate stage "${stage.name}" (${stage.id}).`,
    priorContext ? `Prior orchestrator context:\n${priorContext}` : '',
    `Stage results:\n${digest}`,
    '',
    reask
      ? 'Your previous response was invalid. Reply with ONLY one fenced json block.'
      : 'Reply with concise reasoning, then one fenced json block.',
    'The JSON must match this shape: {"action":"advance|retry|abort","retryNodeRunIds":["stage.slot.0"],"promptAddendum":"...","contextForNext":"...","rationale":"one paragraph"}.',
    'For advance or abort, omit retryNodeRunIds and promptAddendum.',
  );
  return parts.filter((part) => part !== '').join('\n');
}
