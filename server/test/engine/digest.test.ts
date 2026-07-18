import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeRun } from '@mat/shared';
import { assembleArtifacts, buildDigest, digestResultBudget, recordToolUse, resetToolCount } from '../../src/engine/digest.js';

const dirs: string[] = [];
const node = (id: string, resultText = 'answer', provider: NodeRun['agent']['provider'] = 'mock'): NodeRun => ({
  nodeRunId: id, stageId: 's', slotId: id, instanceIndex: 0, agent: { provider, permission: 'safe' }, label: id,
  status: 'done', attempt: 1, cwd: '/', startedAt: 10, endedAt: 20, resultText,
});

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('fan-in digest', () => {
  it('clamps deterministic per-candidate budgets at every edge', () => {
    expect(digestResultBudget(1)).toBe(6000);
    expect(digestResultBudget(4)).toBe(6000);
    expect(digestResultBudget(5)).toBe(4800);
    expect(digestResultBudget(12)).toBe(2000);
    expect(digestResultBudget(100)).toBe(800);
  });

  it('preserves supplied slot/instance order, tail-truncates, and marks grok tools n/a', () => {
    const digest = buildDigest([node('z', 'a'.repeat(7000)), node('a', 'grok', 'grok')]);
    expect(digest.indexOf('## z')).toBeLessThan(digest.indexOf('## a'));
    expect(digest).toContain('…[truncated]');
    expect(digest).toContain('tool-calls: n/a');
  });

  it('resets tool-call counts between attempts', () => {
    const candidate = node('candidate');
    recordToolUse(candidate);
    expect(buildDigest([candidate])).toContain('tool-calls: 1');
    resetToolCount(candidate);
    expect(buildDigest([candidate])).toContain('tool-calls: 0');
  });

  it('assembles patch headers and paths under the 30k cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-digest-')); dirs.push(dir);
    const first = join(dir, 'one.patch');
    const second = join(dir, 'two.patch');
    writeFileSync(first, 'x'.repeat(20_000));
    writeFileSync(second, 'y'.repeat(20_000));
    const one = { ...node('one'), patchFile: first };
    const two = { ...node('two'), patchFile: second };
    const artifacts = assembleArtifacts([one, two]);
    expect(artifacts.patches).toContain('--- patch one (one) ---');
    expect(artifacts.patches).toContain('…[patches truncated]');
    expect(artifacts.patches.length).toBeLessThanOrEqual(30_000);
    expect(artifacts.artifactPaths).toBe(`${first}\n${second}`);
  });
});
