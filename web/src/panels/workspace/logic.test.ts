import { describe, expect, it } from 'vitest';
import { isAbsolutePath, lastRunBadge, relativeTime, shortPath } from './logic.js';

describe('workspace panel logic', () => {
  it('formats compact relative times at each supported unit', () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    expect(relativeTime(now - 30_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 2 * 60 * 60_000, now)).toBe('2h ago');
    expect(relativeTime(now - 3 * 24 * 60 * 60_000, now)).toBe('3d ago');
    expect(relativeTime(now + 60_000, now)).toBe('just now');
    expect(relativeTime(now - 30_000, now, 'zh-TW')).toBe('剛剛');
    expect(relativeTime(now - 5 * 60_000, now, 'zh-TW')).toBe('5 分鐘前');
    expect(relativeTime(now - 2 * 60 * 60_000, now, 'zh-TW')).toBe('2 小時前');
    expect(relativeTime(now - 3 * 24 * 60 * 60_000, now, 'zh-TW')).toBe('3 天前');
  });

  it('builds the last-run badge shown in the workspace card', () => {
    const now = 8_000_000;
    expect(lastRunBadge({ runId: 'planning-run', workflowName: 'Planning', status: 'done', at: now - 2 * 60 * 60_000 }, now))
      .toBe('Planning · done · 2h ago');
    expect(lastRunBadge({ workflowId: 'pipeline', workflowBuiltin: true, workflowName: 'Pipeline: Implement → Test → Review', status: 'gating', at: now - 2 * 60 * 60_000, runId: 'pipeline-run' }, now, 'zh-TW'))
      .toBe('流程：實作 → 測試 → 審查 · 審查中 · 2 小時前');
    expect(lastRunBadge({ workflowId: 'planning-copy', workflowBuiltin: false, workflowName: 'Planning Mode Copy', status: 'done', at: now - 30_000, runId: 'copy-run' }, now, 'zh-TW'))
      .toBe('Planning Mode Copy · 完成 · 剛剛');
    expect(lastRunBadge({ workflowId: 'custom', workflowBuiltin: false, workflowName: 'Planning Mode', status: 'done', at: now - 30_000, runId: 'custom-run' }, now, 'zh-TW'))
      .toBe('Planning Mode · 完成 · 剛剛');
    expect(lastRunBadge({ workflowName: 'Review Mode', status: 'done', at: now - 30_000, runId: 'legacy-run' }, now, 'zh-TW'))
      .toBe('Review Mode · 完成 · 剛剛');
  });

  it('shortens long paths and recognizes absolute paths', () => {
    expect(shortPath('/home/ted/projects/mat')).toBe('…/projects/mat');
    expect(shortPath('/repo')).toBe('/repo');
    expect(shortPath('C:\\Users\\dev\\projects\\mat')).toBe('…/projects/mat');
    expect(isAbsolutePath('/repo')).toBe(true);
    expect(isAbsolutePath('repo')).toBe(false);
    expect(isAbsolutePath('C:\\Users\\dev\\repo')).toBe(true);
    expect(isAbsolutePath('C:/Users/dev/repo')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('C:')).toBe(false);
  });
});
