import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeRun, Workspace } from '@mat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCandidate } from '../../src/engine/verify.js';
import { configureDataDir } from '../../src/store/dataDir.js';
import { configureEventLog, readEventsAfter } from '../../src/store/eventLog.js';

let dataDir = '';
const dirs: string[] = [];

const candidate = (overrides: Partial<NodeRun> = {}): NodeRun => ({
  nodeRunId: 'stage.slot.0', stageId: 'stage', slotId: 'slot', instanceIndex: 0,
  agent: { provider: 'mock', permission: 'safe' }, label: 'Candidate', status: 'done', attempt: 1,
  cwd: dataDir, patchFile: join(dataDir, 'candidate.patch'), ...overrides,
});
const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'w', name: 'Workspace', path: dataDir, isGit: true, verifyCommand: 'node -e "process.exit(0)"', ...overrides,
});

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mat-verify-')); dirs.push(dataDir);
  configureDataDir(dataDir); configureEventLog(dataDir);
  await mkdir(join(dataDir, 'artifacts'), { recursive: true });
  await writeFile(join(dataDir, 'candidate.patch'), 'diff --git a/a b/a\n', 'utf8');
});
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))));

describe('candidate verification', () => {
  it('records passing checks and lifecycle evidence', async () => {
    const result = await verifyCandidate(candidate(), workspace(), 'run-pass');
    expect(result).toMatchObject({ status: 'passed', exitCode: 0, command: expect.stringContaining('process.exit(0)'), logFile: expect.stringContaining('.verify.log') });
    expect(readEventsAfter('run-pass', 0, 20).map((event) => event.data?.detail)).toEqual(['verify-start', 'verify-result']);
  });

  it('captures a failing output tail and full log', async () => {
    const result = await verifyCandidate(candidate(), workspace({ verifyCommand: 'node -e "console.error(123);process.exit(1)"' }), 'run-fail');
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, outputTail: expect.stringContaining('123') });
    expect(await readFile(result?.logFile ?? '', 'utf8')).toContain('123');
    expect(readEventsAfter('run-fail', 0, 20).at(-1)).toMatchObject({ kind: 'error', data: { detail: 'verify-result' } });
  });

  it('redacts environment values from verification results, events, and full logs', async () => {
    const sentinel = 'verify-env-sentinel-cf8d91';
    const prior = process.env.MAT_TEST_VERIFY_SECRET;
    process.env.MAT_TEST_VERIFY_SECRET = sentinel;
    try {
      const command = 'node -e "process.stderr.write(process.env.MAT_TEST_VERIFY_SECRET);process.exit(1)"';
      const result = await verifyCandidate(candidate(), workspace({ verifyCommand: command }), 'run-redacted');
      const log = await readFile(result?.logFile ?? '', 'utf8');
      const persisted = JSON.stringify({ result, events: readEventsAfter('run-redacted', 0, 20), log });
      expect(result).toMatchObject({ status: 'failed', command, outputTail: '[REDACTED_ENV]' });
      expect(persisted).not.toContain(sentinel);
      expect(persisted).toContain('[REDACTED_ENV]');
    } finally {
      if (prior === undefined) delete process.env.MAT_TEST_VERIFY_SECRET;
      else process.env.MAT_TEST_VERIFY_SECRET = prior;
    }
  }, 30_000);

  it('turns timeout into an error and kills the process tree', async () => {
    const result = await verifyCandidate(candidate(), workspace({ verifyCommand: 'node -e "setInterval(() => {}, 1000)"', verifyTimeoutSec: 0.05 }), 'run-timeout');
    expect(result).toMatchObject({ status: 'error', reason: 'timeout' });
  });

  it('skips unconfigured, unchanged, and unfinished candidates', async () => {
    await expect(verifyCandidate(candidate(), workspace({ verifyCommand: '  ' }), 'run-none')).resolves.toEqual({ status: 'skipped', reason: 'no-verify-command' });
    expect(readEventsAfter('run-none', 0, 20)).toEqual([]);
    await writeFile(join(dataDir, 'candidate.patch'), ' \n', 'utf8');
    await expect(verifyCandidate(candidate(), workspace(), 'run-empty')).resolves.toEqual({ status: 'skipped', reason: 'no-changes' });
    await expect(verifyCandidate(candidate({ status: 'failed' }), workspace(), 'run-undone')).resolves.toEqual({ status: 'skipped', reason: 'node-not-done' });
  });
});
