import type { NodeRun } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { displayNodeLabel } from './nodeLabel.js';

const node = (nodeRunId: string, instanceIndex: number, slotId = 'reviewer'): NodeRun => ({
  nodeRunId,
  stageId: 'review',
  slotId,
  instanceIndex,
  agent: { provider: 'codex', permission: 'safe' },
  label: 'Reviewer · codex',
  status: 'queued',
  attempt: 1,
  cwd: '/workspace',
});

describe('displayNodeLabel', () => {
  it('adds a stable ordinal only when a slot has multiple instances', () => {
    const first = node('review.reviewer.0', 0);
    const second = node('review.reviewer.1', 1);
    const single = node('review.final.0', 0, 'final');
    const nodes = [first, second, single];

    expect(displayNodeLabel(first, nodes)).toBe('Reviewer · codex · #1');
    expect(displayNodeLabel(second, nodes)).toBe('Reviewer · codex · #2');
    expect(displayNodeLabel(single, nodes)).toBe('Reviewer · codex');
  });
});
