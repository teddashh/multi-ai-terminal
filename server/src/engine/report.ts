import { existsSync, readFileSync } from 'node:fs';
import type { AgentEvent, NodeRun, RunSnapshot, Workspace } from '@mat/shared';
import { patchStat } from './digest.js';

function iso(value: number | undefined): string {
  return value === undefined ? 'n/a' : new Date(value).toISOString();
}

function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return 'n/a';
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${seconds.toFixed(1)}s`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value.replaceAll('```', '``\u200b`')}\n\`\`\``;
}

function generatedPatch(node: NodeRun): boolean {
  if (!node.patchFile || !existsSync(node.patchFile)) return false;
  try { return readFileSync(node.patchFile, 'utf8').trim().length > 0; } catch { return false; }
}

function verificationLabel(node: NodeRun): string {
  const value = node.verification;
  if (!value) return 'n/a';
  if (value.status === 'failed') return `failed (exit ${String(value.exitCode)})`;
  if (value.status === 'error') return `error (${value.reason ?? 'unknown'})`;
  if (value.status === 'skipped') return `skipped (${value.reason ?? 'unknown'})`;
  return 'passed';
}

export function buildRunReport(run: RunSnapshot, workspace: Workspace, events: AgentEvent[]): string {
  const lines: string[] = [`# Run report — ${run.workflow.name}`, ''];
  lines.push(`- Task: ${run.task}`);
  lines.push(`- Workspace: ${workspace.name} (${workspace.path})`);
  lines.push(`- Run ID: ${run.runId}`);
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Created: ${iso(run.createdAt)}`);
  lines.push(`- Ended: ${iso(run.endedAt)}`);
  lines.push(`- Total duration: ${duration(run.endedAt === undefined ? undefined : run.endedAt - run.createdAt)}`);
  if (run.providerVersions && Object.keys(run.providerVersions).length > 0) {
    lines.push(`- Provider versions: ${Object.entries(run.providerVersions).sort(([left], [right]) => left.localeCompare(right)).map(([id, version]) => `${id} ${version}`).join(' · ')}`);
  }
  const usageNodes = run.nodes.filter((node) => node.usage?.inputTokens !== undefined || node.usage?.outputTokens !== undefined || node.usage?.costUsd !== undefined);
  if (usageNodes.length > 0) {
    const input = usageNodes.reduce((sum, node) => sum + (node.usage?.inputTokens ?? 0), 0);
    const output = usageNodes.reduce((sum, node) => sum + (node.usage?.outputTokens ?? 0), 0);
    const cost = usageNodes.reduce((sum, node) => sum + (node.usage?.costUsd ?? 0), 0);
    lines.push(`- Aggregate usage: ${input} input tokens · ${output} output tokens · $${cost.toFixed(4)}`);
  }

  const generated = run.nodes.filter(generatedPatch).length;
  const passed = run.nodes.filter((node) => node.verification?.status === 'passed').length;
  const failedChecks = run.nodes.filter((node) => node.verification?.status === 'failed' || node.verification?.status === 'error').length;
  const degradedStages = [...new Set(run.gateDecisions.filter((decision) => decision.action === 'advance' && decision.degraded).map((decision) => run.workflow.stages.find((stage) => stage.id === decision.stageId)?.name ?? decision.stageId))];
  lines.push('', '## Outcome', '');
  const progression = run.status === 'done' ? 'advanced' : run.status;
  lines.push(`${generated} candidates generated · ${passed} verified · ${failedChecks} failed checks · ${progression}${degradedStages.length ? ` (degraded at stage ${degradedStages.join(', ')})` : ''}${run.steers?.length ? ` · ${run.steers.length} steers` : ''}`);

  lines.push('', '## Stages', '');
  for (const stage of run.workflow.stages) {
    lines.push(`### ${stage.name}`, '');
    for (const node of run.nodes.filter((candidate) => candidate.stageId === stage.id)) {
      const model = node.agent.model ? `/${node.agent.model}` : '';
      const tokens = node.usage ? (node.usage.inputTokens ?? 0) + (node.usage.outputTokens ?? 0) : undefined;
      const tools = events.filter((event) => event.nodeRunId === node.nodeRunId && event.kind === 'tool_use').length;
      lines.push(`- **${node.label}** — ${node.agent.provider}${model}; status ${node.status}; attempts ${node.attempt}; duration ${duration(node.startedAt === undefined || node.endedAt === undefined ? undefined : node.endedAt - node.startedAt)}; tokens ${tokens ?? 'n/a'}; diffstat ${patchStat(node.patchFile)}; verification ${verificationLabel(node)}; tool calls ${tools}`);
      if (node.status === 'failed' && (node.errorReason || node.error)) lines.push(`  - Error: ${truncate(node.errorReason ?? node.error!, 200)}`);
      if (node.handoff) {
        const sources = node.handoff.priorNodeRunIds.length > 0 ? `← ${node.handoff.priorNodeRunIds.join(', ')}` : '← no upstream nodes';
        const extras = [node.handoff.orchestratorContext ? 'orchestrator context' : '', node.handoff.retryAddendum ? 'retry note' : ''].filter(Boolean);
        lines.push(`  - Handoff: ${sources}${extras.length ? ` + ${extras.join(' + ')}` : ''}`);
      }
    }
    lines.push('');
  }

  if (run.steers?.length) {
    lines.push('## Steering', '');
    for (const steer of run.steers) {
      const decision = steer.steerStageId ? run.gateDecisions.find((candidate) => candidate.stageId === steer.steerStageId) : undefined;
      lines.push(`### ${steer.steerStageId ?? steer.steerId}`, '');
      lines.push(`- Mode: ${steer.mode}`);
      lines.push(`- Status: ${steer.status}`);
      lines.push(`- Created: ${iso(steer.createdAt)}`);
      lines.push(`- Applied: ${iso(steer.appliedAt)}`);
      lines.push(`- Interrupted: ${steer.interruptedStageId ?? 'stage boundary'}`);
      lines.push(`- Instruction: ${truncate(steer.text, 300)}`);
      if (decision) lines.push(`- Review: ${decision.action}${decision.degraded ? ' (degraded)' : ''} — ${decision.rationale}`);
      for (const node of run.nodes.filter((candidate) => candidate.stageId === steer.steerStageId)) {
        const model = node.agent.model ? `/${node.agent.model}` : '';
        lines.push(`- **${node.label}** — ${node.agent.provider}${model}; status ${node.status}; attempts ${node.attempt}; diffstat ${patchStat(node.patchFile)}; verification ${verificationLabel(node)}`);
      }
      lines.push('');
    }
  }

  lines.push('## Gate decisions', '');
  const decisions = [...run.gateDecisions].sort((left, right) => left.ts - right.ts || left.gateAttempt - right.gateAttempt);
  if (decisions.length === 0) lines.push('No gate decisions recorded.', '');
  for (const decision of decisions) {
    const stage = run.workflow.stages.find((candidate) => candidate.id === decision.stageId)?.name
      ?? run.steers?.find((steer) => steer.steerStageId === decision.stageId)?.steerStageId
      ?? decision.stageId;
    const verification = decision.verificationSummary
      ? ` [verification: ${decision.verificationSummary.passed} passed / ${decision.verificationSummary.failed} failed / ${decision.verificationSummary.skipped} skipped]`
      : '';
    lines.push(`- **${stage}** — ${decision.action}${decision.degraded ? ' (degraded)' : ''}: ${decision.rationale}${verification}`);
    if (decision.contextForNext) lines.push(`  > ${truncate(decision.contextForNext, 600).replaceAll('\n', '\n  > ')}`);
  }

  lines.push('', '## Verification logs', '');
  const failures = run.nodes.filter((node) => node.verification?.status === 'failed' || node.verification?.status === 'error');
  if (failures.length === 0) lines.push('No failed verification logs.', '');
  for (const node of failures) lines.push(`### ${node.label}`, '', fenced(node.verification?.outputTail ?? node.verification?.reason ?? ''), '');

  lines.push('## Result excerpts', '');
  const terminalStageId = run.workflow.stages.at(-1)?.id;
  const terminalNodes = run.nodes.filter((node) => node.stageId === terminalStageId);
  if (terminalNodes.length === 0) lines.push('No terminal-stage results.', '');
  for (const node of terminalNodes) lines.push(`### ${node.label}`, '', fenced(truncate(node.resultText ?? '', 1200)), '');
  return `${lines.join('\n').trimEnd()}\n`;
}
