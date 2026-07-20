import type { RunSnapshot, Stage } from '@mat/shared';

export type TemplateVariables = Record<string, string | number | null | undefined>;

export const STEER_TEMPLATE = [
  'The user issued a new instruction mid-run. Execute it now in this workspace. Original task and prior progress are context.',
  'Original task: {{task}}',
  'New instruction: {{steer_text}}',
  'Workspace: {{workspace_path}}',
  'Prior progress:',
  '{{prior_stage_digest}}',
  'Available patches:',
  '{{patches}}',
].join('\n');

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

export function buildGatePrompt(
  run: RunSnapshot,
  stage: Stage,
  digest: string,
  includeBrief = true,
  reask = false,
  review?: { interruptedStageName: string | null; steerText: string },
): string {
  const priorContext = [...run.gateDecisions].reverse().find((decision) => decision.contextForNext)?.contextForNext ?? '';
  const parts = includeBrief ? [buildRunBrief(run), ''] : [];
  parts.push(
    `Evaluate stage "${stage.name}" (${stage.id}).`,
    priorContext ? `Prior orchestrator context:\n${priorContext}` : '',
    `Stage results:\n${digest}`,
    review
      ? review.interruptedStageName
        ? `This is a steer review. The user instruction was: ${review.steerText}\nAction semantics: retry = re-run the interrupted stage '${review.interruptedStageName}' (fresh attempt; use promptAddendum to tell it what changed); advance = old progress + steer outcome suffice, continue the pipeline (use contextForNext to brief the next stage); abort = abort the run.`
        : `This is a boundary steer review. The user instruction was: ${review.steerText}\nAction semantics: advance = continue the pipeline (use contextForNext to brief the next stage); abort = abort the run. Retry is unavailable.`
      : "Verification results are deterministic evidence from the workspace's configured check command. Never claim a candidate works when its verification failed; prefer retrying failed-verification candidates with a corrective promptAddendum.",
    '',
    reask
      ? 'Your previous response was invalid. Reply with ONLY one fenced json block.'
      : 'Reply with concise reasoning, then one fenced json block.',
    review && !review.interruptedStageName
      ? 'The JSON must match this shape: {"action":"advance|abort","contextForNext":"...","rationale":"one paragraph"}.'
      : 'The JSON must match this shape: {"action":"advance|retry|abort","retryNodeRunIds":["stage.slot.0"],"promptAddendum":"...","contextForNext":"...","rationale":"one paragraph"}.',
    review && !review.interruptedStageName ? '' : 'For advance or abort, omit retryNodeRunIds and promptAddendum.',
  );
  return parts.filter((part) => part !== '').join('\n');
}
