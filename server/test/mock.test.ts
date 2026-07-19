import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContentEvent } from '@mat/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mockAdapter } from '../src/adapters/mock.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('mock adapter', () => {
  it('emits the deterministic ok content sequence and outcome', async () => {
    const events: AdapterContentEvent[] = [];
    const raw: string[] = [];
    const spawned = mockAdapter.spawn({ binding: { provider: 'mock', model: 'ok', permission: 'safe' }, promptText: 'go', cwd: '/' }, { onEvent: (event) => events.push(event), onRaw: (line) => raw.push(line) });
    await expect(spawned.completion).resolves.toMatchObject({ exitCode: 0, resultText: 'Mock task completed.' });
    expect(events.map((event) => event.kind)).toEqual(['thinking', 'tool_use', 'tool_result', 'message']);
    expect(raw).toHaveLength(4);
  });
  it('returns an error outcome for fail', async () => {
    const spawned = mockAdapter.spawn({ binding: { provider: 'mock', model: 'fail', permission: 'safe' }, promptText: 'go', cwd: '/' }, { onEvent: () => undefined, onRaw: () => undefined });
    await expect(spawned.completion).resolves.toMatchObject({ exitCode: 1, error: 'mock failure' });
  });
  it('writes a deterministic artifact inside cwd and ignores traversal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mat-mock-write-')); dirs.push(cwd);
    const written = mockAdapter.spawn({ binding: { provider: 'mock', model: 'ok', permission: 'safe' }, promptText: 'MOCK_WRITE:nested/file.txt\nMOCK_REPLY: done', cwd }, { onEvent: () => undefined, onRaw: () => undefined });
    await written.completion;
    expect(readFileSync(join(cwd, 'nested', 'file.txt'), 'utf8')).toContain('nested/file.txt');
    const rejected = mockAdapter.spawn({ binding: { provider: 'mock', model: 'ok', permission: 'safe' }, promptText: 'MOCK_WRITE:../escape.txt', cwd }, { onEvent: () => undefined, onRaw: () => undefined });
    await rejected.completion;
    expect(existsSync(join(cwd, '..', 'escape.txt'))).toBe(false);
  });
});
