import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diag } from '../src/diag.js';
import { configureDataDir } from '../src/store/dataDir.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('diagnostic journal', () => {
  it('writes valid run JSONL and rotates the server journal at five megabytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-diag-'));
    dirs.push(root);
    configureDataDir(root);
    diag('run-1', 'stage', { stageId: 'one', phase: 'start' });
    const line = readFileSync(join(root, 'runs', 'run-1', 'diag.jsonl'), 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ cat: 'stage', stageId: 'one', phase: 'start' });

    const serverPath = join(root, 'logs', 'server-diag.jsonl');
    diag(null, 'probe', { command: 'seed', ok: true });
    writeFileSync(serverPath, Buffer.alloc(5 * 1024 * 1024));
    expect(() => diag(null, 'probe', { command: 'mock', ok: true })).not.toThrow();
    expect(existsSync(`${serverPath}.1`)).toBe(true);
    expect(JSON.parse(readFileSync(serverPath, 'utf8').trim())).toMatchObject({ cat: 'probe', command: 'mock', ok: true });
  });

  it('recreates a missing configured directory without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-diag-missing-'));
    dirs.push(root);
    configureDataDir(root);
    await rm(root, { recursive: true, force: true });
    expect(() => diag('run-2', 'run', { action: 'create' })).not.toThrow();
  });
});
