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
  });

  it('builds the last-run badge shown in the workspace card', () => {
    const now = 8_000_000;
    expect(lastRunBadge({ workflowName: 'Planning', status: 'done', at: now - 2 * 60 * 60_000 }, now))
      .toBe('Planning · done · 2h ago');
  });

  it('shortens long paths and recognizes absolute paths', () => {
    expect(shortPath('/home/ted/projects/mat')).toBe('…/projects/mat');
    expect(shortPath('/repo')).toBe('/repo');
    expect(isAbsolutePath('/repo')).toBe(true);
    expect(isAbsolutePath('repo')).toBe(false);
  });
});
