import type { NodeRun } from '@mat/shared';

/**
 * Keep counted instances visually distinct without changing their persisted
 * label or nodeRunId. The ordinal comes from the immutable instance index.
 */
export function displayNodeLabel(node: NodeRun, nodes: readonly NodeRun[]): string {
  const siblingCount = nodes.filter((candidate) => candidate.stageId === node.stageId && candidate.slotId === node.slotId).length;
  return siblingCount > 1 ? `${node.label} · #${node.instanceIndex + 1}` : node.label;
}
