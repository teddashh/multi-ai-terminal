import { existsSync, readFileSync } from 'node:fs';
import type { NodeRun } from '@mat/shared';

export const digestResultBudget = (candidateCount: number): number => {
  if (candidateCount <= 0) return 6000;
  return Math.max(800, Math.min(6000, Math.floor(24_000 / candidateCount)));
};

const toolCounts = new WeakMap<NodeRun, number>();
export function recordToolUse(node: NodeRun): void {
  toolCounts.set(node, (toolCounts.get(node) ?? 0) + 1);
}

export function resetToolCount(node: NodeRun): void {
  toolCounts.delete(node);
}

function truncateTail(text: string, budget: number): string {
  const marker = '…[truncated]';
  if (text.length <= budget) return text;
  return `${marker}${text.slice(-(budget - marker.length))}`;
}

function formatUsage(node: NodeRun): string {
  if (!node.usage) return 'n/a';
  const values = [
    node.usage.inputTokens !== undefined ? `in=${node.usage.inputTokens}` : '',
    node.usage.outputTokens !== undefined ? `out=${node.usage.outputTokens}` : '',
    node.usage.costUsd !== undefined ? `cost=$${node.usage.costUsd.toFixed(4)}` : '',
  ].filter(Boolean);
  return values.join(' ') || 'n/a';
}

function patchStat(path: string | undefined): string {
  if (!path || !existsSync(path)) return 'n/a';
  const patch = readFileSync(path, 'utf8');
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return `${files} files, +${additions}/-${deletions}`;
}

function lastError(node: NodeRun): string {
  if (node.status === 'failed') return node.resultText || (node.exitCode === undefined ? 'failed' : `exit ${String(node.exitCode)}`);
  if (node.status === 'killed') return 'killed';
  return 'none';
}

export function buildDigest(nodes: NodeRun[]): string {
  const ordered = [...nodes];
  const budget = digestResultBudget(ordered.length);
  return ordered.map((node) => {
    const model = node.agent.model ? `/${node.agent.model}` : '';
    const duration = node.startedAt === undefined ? 'n/a' : `${Math.max(0, (node.endedAt ?? Date.now()) - node.startedAt)}ms`;
    const toolCount = node.agent.provider === 'grok' ? 'n/a' : String(toolCounts.get(node) ?? 0);
    return [
      `## ${node.label} [${node.nodeRunId}]`,
      `provider/model: ${node.agent.provider}${model}`,
      `status: ${node.status}; attempt: ${node.attempt}; duration: ${duration}`,
      `usage: ${formatUsage(node)}; tool-calls: ${toolCount}; diffstat: ${patchStat(node.patchFile)}; last-error: ${lastError(node)}`,
      'result:',
      truncateTail(node.resultText ?? '', budget),
    ].join('\n');
  }).join('\n\n');
}

export function assembleArtifacts(nodes: readonly NodeRun[], cap = 30_000): { patches: string; artifactPaths: string } {
  const paths = nodes.map((node) => node.patchFile).filter((path): path is string => Boolean(path && existsSync(path)));
  const chunks: string[] = [];
  let used = 0;
  for (const node of nodes) {
    if (!node.patchFile || !existsSync(node.patchFile)) continue;
    const header = `--- patch ${node.nodeRunId} (${node.label}) ---\n`;
    const content = readFileSync(node.patchFile, 'utf8');
    const separator = chunks.length > 0 ? '\n' : '';
    const remaining = cap - used - separator.length;
    if (remaining <= 0) break;
    const whole = `${header}${content}`;
    if (whole.length <= remaining) {
      chunks.push(whole);
      used += separator.length + whole.length;
    } else {
      const marker = '\n…[patches truncated]';
      chunks.push(`${whole.slice(0, Math.max(0, remaining - marker.length))}${marker}`);
      used += separator.length + remaining;
      break;
    }
  }
  return { patches: chunks.join('\n'), artifactPaths: paths.join('\n') };
}
