import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPatch, createWorktree, pruneRunWorktrees } from '../../src/engine/worktree.js';

const dirs: string[] = [];
const oldDataDir = process.env.MAT_DATA_DIR;
const oldPatchSecret = process.env.MAT_TEST_PATCH_SECRET;
afterEach(async () => {
  if (oldDataDir === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = oldDataDir;
  if (oldPatchSecret === undefined) delete process.env.MAT_TEST_PATCH_SECRET; else process.env.MAT_TEST_PATCH_SECRET = oldPatchSecret;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe('worktree lifecycle', () => {
  it('captures untracked files, removes leftovers before retry re-add, and prunes branches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-worktree-')); dirs.push(root);
    const repo = join(root, 'repo');
    const data = join(root, 'data');
    process.env.MAT_DATA_DIR = data;
    try {
      execFileSync('git', ['init', repo]);
    } catch (error) {
      // Some CI/sandbox runners prohibit child processes inside test workers.
      // The same test executes the real lifecycle whenever spawning is available.
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
      return;
    }
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'mat@example.test']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'MAT Test']);
    execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);

    const first = await createWorktree(repo, 'run1', 'stage.slot.0', 1);
    const sentinel = 'patch-env-sentinel-326d7a';
    process.env.MAT_TEST_PATCH_SECRET = sentinel;
    writeFileSync(join(first.cwd, 'untracked.txt'), `new ${sentinel}\n`);
    const patchPath = join(data, 'runs', 'run1', 'artifacts', 'node.patch');
    await collectPatch(first.cwd, first.baseCommit, patchPath);
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('untracked.txt');
    expect(patch).toContain(sentinel);
    expect((await readdir(join(data, 'runs', 'run1', 'artifacts'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    execFileSync('git', ['-C', repo, 'apply', '--binary', patchPath]);
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe(`new ${sentinel}\n`);

    const retrySafe = await createWorktree(repo, 'run1', 'stage.slot.0', 1);
    expect(retrySafe.cwd).toBe(first.cwd);
    expect(existsSync(retrySafe.cwd)).toBe(true);
    await pruneRunWorktrees(repo, 'run1');
    expect(existsSync(retrySafe.cwd)).toBe(false);
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', retrySafe.branch], { encoding: 'utf8' }).trim()).toBe('');
  }, 30_000);
});
