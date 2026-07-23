import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContentEvent, RuntimeChangedEvent } from '@mat/shared';
import { spawnCodex } from '../../src/adapters/codex.js';
import type { ResolvedNodeSpec } from '../../src/adapters/base.js';
import { CodexConnection } from '../../src/providers/codex/connection.js';
import { resetCodexSessionRuntimeForTest } from '../../src/providers/codex/runtime.js';
import { SIGNIN_RUNTIME_BUSY, resetSignInForTests, setSignInRecipeForTests, startSignIn } from '../../src/providers/signin.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-app-server.mjs');
const roots: string[] = [];

type Recorded = { direction: 'in' | 'out'; message: Record<string, any>; spawnIndex: number };
const records = (file: string): Recorded[] => {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Recorded); }
  catch { return []; }
};
const spec = (resumeSessionRef?: string): ResolvedNodeSpec => ({
  binding: { provider: 'codex', role: 'coder', permission: 'standard' }, promptText: 'hello', cwd: '/repo', ...(resumeSessionRef ? { resumeSessionRef } : {}),
});

function setup(scenario: Record<string, unknown>, opts: { missingBinary?: boolean; failResolve?: boolean; poisonDispose?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mat-codex-runtime-')); roots.push(root);
  const recordFile = join(root, 'wire.jsonl');
  process.env.MAT_FAKE_APPSERVER_SCENARIO = JSON.stringify({ ...scenario, recordFile, spawnMarkerFile: join(root, 'spawns.txt') });
  let creates = 0;
  let resolves = 0;
  let connection: CodexConnection | undefined;
  const listeners = new Set<(event: RuntimeChangedEvent) => void>();
  resetCodexSessionRuntimeForTest({
    resolveBinary: async (_dataDir, _family) => {
      resolves += 1;
      if (opts.failResolve) throw new Error('resolver down');
      return opts.missingBinary ? null : process.execPath;
    },
    createConnection: (config) => {
      creates += 1;
      connection = new CodexConnection({ ...config, spawnArgs: [fixturePath], codexHome: join(root, 'codex-home'), idleReaper: false });
      if (opts.poisonDispose) {
        const original = connection.dispose.bind(connection);
        connection.dispose = async () => { await original(); throw new Error('dispose boom'); };
      }
      return connection;
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return {
    recordFile, creates: () => creates, resolves: () => resolves, connection: () => connection,
    emitChange: (family: RuntimeChangedEvent['family'] = 'codex') => { for (const listener of [...listeners]) listener({ family, state: 'managed' }); },
  };
}

afterEach(() => {
  resetCodexSessionRuntimeForTest();
  resetSignInForTests();
  delete process.env.MAT_CODEX_RUNTIME;
  delete process.env.MAT_CODEX_BIN;
  delete process.env.MAT_FAKE_APPSERVER_SCENARIO;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Codex session runtime', () => {
  it('is the default spawnCodex path and maps streamed content and completion', async () => {
    const { recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { delayMs: 3, method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-0', type: 'userMessage', text: 'hello' } } },
        { delayMs: 4, method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-0', type: 'userMessage', text: 'hello' } } },
        { delayMs: 5, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'hello ' } },
        { delayMs: 7, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'world' } },
        { delayMs: 9, method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: '/repo' } } },
        { delayMs: 11, method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', output: '/repo', exitCode: 0 } } },
        { delayMs: 13, method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'hello world' } } },
        { delayMs: 15, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', usage: { input_tokens: 8, output_tokens: 3 } } } },
      ] },
    } });
    const events: AdapterContentEvent[] = [];
    const run = spawnCodex(spec(), { onEvent: (event) => events.push(event), onRaw: () => undefined });
    await expect(run.completion).resolves.toEqual({ exitCode: 0, sessionRef: 'thread-1', usage: { inputTokens: 8, outputTokens: 3 }, resultText: 'hello world' });
    expect(events.map((event) => event.kind)).toEqual(['tool_use', 'tool_result', 'message']);
    expect(records(recordFile).filter((entry) => entry.message.method === 'initialize')).toHaveLength(1);
  }, 30_000);

  it('maps kill to a SIGTERM interrupted outcome', async () => {
    const { recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }] },
      'turn/interrupt': { result: {}, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }] },
    } });
    const run = spawnCodex(spec(), { onEvent: () => undefined, onRaw: () => undefined });
    await vi.waitFor(() => expect(records(recordFile).some((entry) => entry.direction === 'out' && entry.message.method === 'turn/started')).toBe(true), { timeout: 5_000, interval: 20 });
    run.kill();
    await expect(run.completion).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM', sessionRef: 'thread-1' });
  }, 30_000);

  it('refuses codex sign-in while a turn is running', async () => {
    const { recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } } },
    } });
    // Hermetic even if the refusal regressed: empty fake home (capture refuses
    // before writing) and a harmless test recipe instead of the real codex CLI.
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(dirname(recordFile), 'codex-home');
    setSignInRecipeForTests('codex', {
      mode: 'device', command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 3000)'], trustedHosts: ['openai.com'],
    });
    try {
      const run = spawnCodex(spec(), { onEvent: () => undefined, onRaw: () => undefined });
      await expect(startSignIn('codex')).resolves.toMatchObject({ ok: false, error: SIGNIN_RUNTIME_BUSY });
      run.kill();
      await run.completion;
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  }, 30_000);

  it('resolves provider failure instead of rejecting', async () => {
    setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', message: 'fatal boom', willRetry: false } }] },
    } });
    await expect(spawnCodex(spec(), { onEvent: () => undefined, onRaw: () => undefined }).completion).resolves.toMatchObject({ exitCode: 1, error: expect.stringContaining('fatal boom') });
  }, 30_000);

  it('adopts a resumed thread without starting a new one', async () => {
    const { recordFile } = setup({ responses: {
      'thread/resume': { result: { thread: { id: 'thread-9' } } },
      'turn/start': { result: { turn: { id: 'turn-9' } }, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-9', turn: { id: 'turn-9', status: 'completed' } } }] },
    } });
    await expect(spawnCodex(spec('thread-9'), { onEvent: () => undefined, onRaw: () => undefined }).completion).resolves.toMatchObject({ exitCode: 0, sessionRef: 'thread-9' });
    const inbound = records(recordFile).filter((entry) => entry.direction === 'in');
    expect(inbound.find((entry) => entry.message.method === 'thread/resume')?.message.params.threadId).toBe('thread-9');
    expect(inbound.some((entry) => entry.message.method === 'thread/start')).toBe(false);
  }, 30_000);

  it('keeps the legacy exec path as an explicit opt-out', async () => {
    const { creates } = setup({});
    process.env.MAT_CODEX_RUNTIME = 'exec';
    const run = spawnCodex({ ...spec(), runtimeCommand: process.execPath }, { onEvent: () => undefined, onRaw: () => undefined });
    run.kill();
    await run.completion;
    expect(creates()).toBe(0);
  }, 30_000);

  it('respawns after an idle runtime-change recycle', async () => {
    const { recordFile, connection } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }] },
    } });
    const io = { onEvent: () => undefined, onRaw: () => undefined };
    await spawnCodex(spec(), io).completion;
    connection()?.recycleIfIdle('runtime changed');
    await spawnCodex(spec(), io).completion;
    expect(records(recordFile).filter((entry) => entry.direction === 'in' && entry.message.method === 'initialize')).toHaveLength(2);
  }, 30_000);

  it('retires the pair on an idle runtime change and re-resolves the binary', async () => {
    const { recordFile, creates, resolves, emitChange } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }] },
    } });
    const io = { onEvent: () => undefined, onRaw: () => undefined };
    await spawnCodex(spec(), io).completion;
    emitChange('claude');
    await spawnCodex(spec(), io).completion;
    expect(creates()).toBe(1);
    const resolvedBefore = resolves();
    emitChange('codex');
    await spawnCodex(spec(), io).completion;
    expect(creates()).toBe(2);
    expect(resolves()).toBeGreaterThan(resolvedBefore);
    expect(records(recordFile).filter((entry) => entry.direction === 'in' && entry.message.method === 'initialize')).toHaveLength(2);
  }, 30_000);

  it('keeps completion resolved when post-change disposal rejects', async () => {
    const { creates, recordFile, emitChange } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { delayMs: 120, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
      ] },
    } }, { poisonDispose: true });
    const io = { onEvent: () => undefined, onRaw: () => undefined };
    const run = spawnCodex(spec(), io);
    await vi.waitFor(() => expect(records(recordFile).some((entry) => entry.direction === 'out' && entry.message.method === 'turn/started')).toBe(true), { timeout: 5_000, interval: 20 });
    emitChange('codex');
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0, sessionRef: 'thread-1' });
    await spawnCodex(spec(), io).completion;
    expect(creates()).toBe(2);
  }, 30_000);

  it('does not build a runtime pair for kill after a failed spawn', async () => {
    const { creates, resolves } = setup({}, { failResolve: true });
    const run = spawnCodex(spec(), { onEvent: () => undefined, onRaw: () => undefined });
    await expect(run.completion).resolves.toMatchObject({ exitCode: 1, error: expect.stringContaining('resolver down') });
    const resolvedBefore = resolves();
    run.kill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(creates()).toBe(0);
    expect(resolves()).toBe(resolvedBefore);
  }, 30_000);

  it('falls back to the unprobed spawn command when resolution returns null', async () => {
    const { creates } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }] },
    } }, { missingBinary: true });
    process.env.MAT_CODEX_BIN = process.execPath;
    await expect(spawnCodex(spec(), { onEvent: () => undefined, onRaw: () => undefined }).completion).resolves.toMatchObject({ exitCode: 0, sessionRef: 'thread-1' });
    expect(creates()).toBe(1);
  }, 30_000);
});
