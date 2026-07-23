import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContentEvent } from '@mat/shared';
import { CodexConnection } from '../../src/providers/codex/connection.js';
import { CODEX_MODELS, DEFAULT_CODEX_MODEL, contextWindowForModel } from '../../src/providers/codex/models.js';
import { CodexThreadManager } from '../../src/providers/codex/threads.js';
import { parseTokenUsage, translateNotification } from '../../src/providers/codex/translate.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-app-server.mjs');
const roots: string[] = [];
const connections: CodexConnection[] = [];

type Recorded = { direction: 'in' | 'out'; message: Record<string, any>; spawnIndex: number };

function records(file: string): Recorded[] {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Recorded); }
  catch { return []; }
}

async function waitForRecord(file: string, predicate: (record: Recorded) => boolean): Promise<Recorded> {
  let found: Recorded | undefined;
  await vi.waitFor(() => {
    found = records(file).find(predicate);
    expect(found).toBeDefined();
  }, { timeout: 5_000, interval: 20 });
  return found!;
}

function setup(scenario: Record<string, unknown>, hooks: Partial<ConstructorParameters<typeof CodexThreadManager>[1]> = {}, opts: ConstructorParameters<typeof CodexThreadManager>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mat-codex-threads-')); roots.push(root);
  const recordFile = join(root, 'wire.jsonl');
  // Always track spawns: onSpawn/exitOnSpawn gating in scenarios is meaningless
  // without the marker file advancing spawnIndex past 1 on respawn.
  process.env.MAT_FAKE_APPSERVER_SCENARIO = JSON.stringify({ ...scenario, recordFile, spawnMarkerFile: join(root, 'spawns.txt') });
  let manager!: CodexThreadManager;
  const connection = new CodexConnection({ command: process.execPath, spawnArgs: [fixturePath], codexHome: join(root, 'codex-home'), purpose: 'session',
    clientInfo: { name: 'test', title: 'test', version: '0' }, idleReaper: false,
    onNotification: (method, params) => manager.handleNotification(method, params),
    onServerRequest: (method, params) => manager.handleServerRequest(method, params),
    onConnectionLost: (error) => manager.noteConnectionLost(error) });
  connections.push(connection);
  manager = new CodexThreadManager(connection, { onEvent: () => undefined, ...hooks }, opts);
  return { manager, recordFile };
}

const turnOptions = { prompt: 'hello', model: DEFAULT_CODEX_MODEL, cwd: '/repo' };

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.dispose()));
  delete process.env.MAT_FAKE_APPSERVER_SCENARIO;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Codex model and notification translation', () => {
  it('exposes the authoritative ordered model list and context windows', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(CODEX_MODELS).toHaveLength(10);
    expect(CODEX_MODELS.map((model) => model.value)).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'codex-mini-latest', 'o4-mini', 'o3', 'gpt-4.1']);
    expect(contextWindowForModel('gpt-5.6-luna')).toBe(353_400);
    expect(contextWindowForModel('o3')).toBe(1_000_000);
  });

  it('parses camel and snake case usage aliases and rejects invalid context windows', () => {
    expect(parseTokenUsage({ token_usage: { total_token_usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 3 }, last_token_usage: { input: 2, output: 1 }, model_context_window: 99 } })).toEqual({
      total: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 }, last: { inputTokens: 2, outputTokens: 1 }, contextWindow: 99,
    });
    expect(parseTokenUsage({ usage: { inputTokens: 4, outputTokens: 5, modelContextWindow: 0 } })).toEqual({ total: { inputTokens: 4, outputTokens: 5 }, last: { inputTokens: 4, outputTokens: 5 } });
  });

  it('accumulates stripped command output between matching tool events', () => {
    const outputs = new Map<string, string>();
    const start = translateNotification('item/started', { item: { id: 'tool-1', type: 'commandExecution', command: 'pwd', cwd: '/repo' } }, outputs);
    translateNotification('item/commandExecution/outputDelta', { item: { id: 'tool-1' }, delta: '\u001b[31mred\u001b[0m' }, outputs);
    const end = translateNotification('item/completed', { item: { id: 'tool-1', type: 'commandExecution', exitCode: 0 } }, outputs);
    expect(start[0]?.tool).toMatchObject({ toolCallId: 'tool-1', name: 'Bash' });
    expect(end[0]?.tool).toMatchObject({ toolCallId: 'tool-1', name: 'Bash', output: 'red', isError: false });
  });
});

describe('CodexThreadManager', () => {
  it('runs a real connection turn, streams/coalesces content, tools, usage, and reuses its thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-codex-threads-')); roots.push(root);
    const recordFile = join(root, 'wire.jsonl');
    process.env.MAT_FAKE_APPSERVER_SCENARIO = JSON.stringify({ recordFile, responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': [
        { result: { turn: { id: 'turn-1' } }, notifications: [
          { delayMs: 5, method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
          { delayMs: 10, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'hello ' } },
          { delayMs: 12, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'world' } },
          { delayMs: 15, method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: '/repo' } } },
          { delayMs: 17, method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1' }, delta: '/repo\n' } },
          { delayMs: 20, method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', exitCode: 0 } } },
          { delayMs: 25, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', usage: { input_tokens: 8, output_tokens: 3 } } } },
        ] },
        { result: { turn: { id: 'turn-2' } }, notifications: [
          { delayMs: 5, method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } },
          { delayMs: 10, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } },
        ] },
      ],
    } });
    const events: AdapterContentEvent[] = [];
    let manager!: CodexThreadManager;
    const connection = new CodexConnection({ command: process.execPath, spawnArgs: [fixturePath], codexHome: join(root, 'codex-home'), purpose: 'session',
      clientInfo: { name: 'test', title: 'test', version: '0' }, idleReaper: false,
      onNotification: (method, params) => manager.handleNotification(method, params),
      onServerRequest: (method, params) => manager.handleServerRequest(method, params),
      onConnectionLost: (error) => manager.noteConnectionLost(error) });
    connections.push(connection);
    manager = new CodexThreadManager(connection, { onEvent: (_session, event) => events.push(event) });
    const options = { prompt: 'hello', model: DEFAULT_CODEX_MODEL, cwd: '/repo' };
    await expect(manager.startTurn('session', options)).resolves.toMatchObject({ status: 'completed', usage: { inputTokens: 8, outputTokens: 3 }, resultText: 'hello world', threadId: 'thread-1' });
    expect(events.map((event) => event.kind)).toEqual(['tool_use', 'tool_result', 'message']);
    await expect(manager.startTurn('session', { ...options, prompt: 'again' })).resolves.toMatchObject({ status: 'completed', threadId: 'thread-1' });
    expect(records(recordFile).filter((entry) => entry.direction === 'in' && entry.message.method === 'thread/start')).toHaveLength(1);
  }, 30_000);

  it('resumes and retries a completed session when turn/start reports thread not found', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'thread/resume': { result: { thread: { id: 'thread-1' } } },
      'turn/start': [
        { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }] },
        { error: { code: -32602, message: 'thread thread-1 not found' } },
        { result: { turn: { id: 'turn-2' } }, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } }] },
      ],
    } });
    await expect(manager.startTurn('session', turnOptions)).resolves.toMatchObject({ status: 'completed' });
    await expect(manager.startTurn('session', { ...turnOptions, prompt: 'retry' })).resolves.toMatchObject({ status: 'completed', threadId: 'thread-1' });
    expect(records(recordFile).filter((entry) => entry.direction === 'in' && entry.message.method === 'thread/resume')).toHaveLength(1);
    expect(manager.threadIdFor('session')).toBe('thread-1');
  }, 30_000);

  it('starts a fresh thread instead of resuming after connection loss before any completed turn', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { noReplyOnSpawn: 1, exitAfter: 20, exitOnSpawn: 1, result: { turn: { id: 'turn-2' } }, notifications: [
        { onSpawn: 2, delayMs: 5, method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } },
        { onSpawn: 2, delayMs: 10, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } },
      ] },
    } });
    const lostOutcome = await manager.startTurn('session', turnOptions);
    expect(['interrupted', 'failed']).toContain(lostOutcome.status);
    await expect(manager.startTurn('session', { ...turnOptions, prompt: 'fresh' })).resolves.toMatchObject({ status: 'completed' });
    const inbound = records(recordFile).filter((entry) => entry.direction === 'in');
    expect(inbound.filter((entry) => entry.message.method === 'thread/start')).toHaveLength(2);
    expect(inbound.filter((entry) => entry.message.method === 'thread/resume')).toHaveLength(0);
  }, 30_000);

  it('round-trips command approval through the hook and server request reply', async () => {
    const approvals: Array<{ session: string; request: Record<string, unknown> }> = [];
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { delayMs: 5, serverRequest: { method: 'item/commandExecution/requestApproval', id: 'server-9', params: { threadId: 'thread-1', requestId: 'req-9', item: { id: 'cmd-9', command: 'npm test', cwd: '/repo' } } } },
        { delayMs: 20, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
      ] },
    } }, { onApprovalRequest: async (session, request) => { approvals.push({ session, request }); return 'acceptForSession'; } });
    await expect(manager.startTurn('session', turnOptions)).resolves.toMatchObject({ status: 'completed' });
    expect(approvals).toEqual([{ session: 'session', request: expect.objectContaining({ toolUseId: 'codex-approval-req-9', toolName: 'Bash', detail: { command: 'npm test', cwd: '/repo' } }) }]);
    const reply = await waitForRecord(recordFile, (entry) => entry.direction === 'in' && entry.message.id === 'server-9');
    expect(reply.message).toEqual({ id: 'server-9', result: 'acceptForSession' });
  }, 30_000);

  it('auto-cancels an outstanding approval when the turn is aborted', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { delayMs: 5, serverRequest: { method: 'item/commandExecution/requestApproval', id: 'server-pending', params: { threadId: 'thread-1', requestId: 'pending', item: { command: 'danger', cwd: '/repo' } } } },
      ] },
      'turn/interrupt': { result: {}, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }] },
    } }, { onApprovalRequest: async () => new Promise<never>(() => undefined) });
    const outcome = manager.startTurn('session', turnOptions);
    await waitForRecord(recordFile, (entry) => entry.direction === 'out' && entry.message.id === 'server-pending');
    await manager.abort('session');
    await expect(outcome).resolves.toMatchObject({ status: 'interrupted' });
    const reply = await waitForRecord(recordFile, (entry) => entry.direction === 'in' && entry.message.id === 'server-pending');
    expect(reply.message).toEqual({ id: 'server-pending', result: 'cancel' });
  }, 30_000);

  it('interrupts a started turn using its live turn id', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'pending-id' } }, notifications: [{ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-live' } } }] },
      'turn/interrupt': { result: {}, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'interrupted' } } }] },
    } });
    const outcome = manager.startTurn('session', turnOptions);
    await waitForRecord(recordFile, (entry) => entry.direction === 'out' && entry.message.method === 'turn/started');
    await manager.abort('session');
    await expect(outcome).resolves.toMatchObject({ status: 'interrupted' });
    expect(records(recordFile).find((entry) => entry.direction === 'in' && entry.message.method === 'turn/interrupt')?.message.params.turnId).toBe('turn-live');
  }, 30_000);

  it('retries abort-before-started with the active turn id reported by the server', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-A' } }, notifications: [{ delayMs: 80, method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-A' } } }] },
      'turn/interrupt': [
        { error: { code: -32602, message: 'no turn turn-A active, but found turn-B' } },
        { result: {}, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-B', status: 'interrupted' } } }] },
      ],
    } });
    const outcome = manager.startTurn('session', turnOptions);
    await manager.abort('session');
    await expect(outcome).resolves.toMatchObject({ status: 'interrupted' });
    const interrupts = records(recordFile).filter((entry) => entry.direction === 'in' && entry.message.method === 'turn/interrupt');
    expect(interrupts).toHaveLength(2);
    expect(interrupts[1]?.message.params.turnId).toBe('turn-B');
  }, 30_000);

  it('filters late events from an interrupted turn before the next turn', async () => {
    const events: AdapterContentEvent[] = [];
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': [
        { result: { turn: { id: 'turn-old' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-old' } } },
          { delayMs: 80, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-old', delta: 'STALE' } },
        ] },
        { result: { turn: { id: 'turn-new' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-new' } } },
          { delayMs: 30, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-new', delta: 'clean' } },
          { delayMs: 120, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-new', status: 'completed' } } },
        ] },
      ],
      'turn/interrupt': { result: {}, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-old', status: 'interrupted' } } }] },
    } }, { onEvent: (_session, event) => events.push(event) });
    const first = manager.startTurn('session', turnOptions);
    await waitForRecord(recordFile, (entry) => entry.direction === 'out' && entry.message.method === 'turn/started');
    await manager.abort('session');
    await expect(first).resolves.toMatchObject({ status: 'interrupted' });
    await expect(manager.startTurn('session', { ...turnOptions, prompt: 'next' })).resolves.toMatchObject({ status: 'completed', resultText: 'clean' });
    expect(events.map((event) => 'text' in event ? event.text : '').join('')).not.toContain('STALE');
  }, 30_000);

  it('keeps a retrying turn alive and returns to ready on later activity', async () => {
    const statuses: string[] = [];
    const { manager } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { delayMs: 5, method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', message: 'transient', willRetry: true } },
        { delayMs: 10, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'recovered' } },
        { delayMs: 15, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
      ] },
    } }, { onStatus: (_session, status) => statuses.push(status) });
    await expect(manager.startTurn('session', turnOptions)).resolves.toMatchObject({ status: 'completed', resultText: 'recovered' });
    expect(statuses).toEqual(['reconnecting', 'ready']);
  }, 30_000);

  it('fails a turn on a non-retrying error notification', async () => {
    const { manager } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [
        { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
        { delayMs: 5, method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', message: 'boom', willRetry: false } },
      ] },
    } });
    await expect(manager.startTurn('session', turnOptions)).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('boom') });
  }, 30_000);

  it('routes interleaved notifications only to their owning sessions', async () => {
    const seen: Record<string, string[]> = { A: [], B: [] };
    const { manager, recordFile } = setup({ responses: {
      'thread/start': [{ result: { thread: { id: 'thread-1' } } }, { result: { thread: { id: 'thread-2' } } }],
      'turn/start': [
        { result: { turn: { id: 'turn-A' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-A' } } },
          { delayMs: 50, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-A', delta: 'A-own' } },
          { delayMs: 120, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-A', status: 'completed' } } },
        ] },
        { result: { turn: { id: 'turn-B' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-2', turn: { id: 'turn-B' } } },
          { delayMs: 10, method: 'item/agentMessage/delta', params: { threadId: 'thread-2', turnId: 'turn-B', delta: 'B-own' } },
          { delayMs: 15, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-A', delta: 'A-cross' } },
          { delayMs: 20, method: 'item/agentMessage/delta', params: { threadId: 'thread-unknown', turnId: 'turn-X', delta: 'UNKNOWN' } },
          { delayMs: 80, method: 'turn/completed', params: { threadId: 'thread-2', turn: { id: 'turn-B', status: 'completed' } } },
        ] },
      ],
    } }, { onEvent: (session, event) => { if ('text' in event) seen[session]?.push(event.text); } });
    const a = manager.startTurn('A', { ...turnOptions, prompt: 'A' });
    await waitForRecord(recordFile, (entry) => entry.direction === 'in' && entry.message.method === 'turn/start' && entry.message.params.threadId === 'thread-1');
    const b = manager.startTurn('B', { ...turnOptions, prompt: 'B' });
    await expect(Promise.all([a, b])).resolves.toMatchObject([{ status: 'completed' }, { status: 'completed' }]);
    // A-own and A-cross ride two independent real-time timelines (A's and B's
    // notification scripts), so their relative order is scheduler-dependent.
    const joinedA = seen.A.join('');
    expect(joinedA).toContain('A-own');
    expect(joinedA).toContain('A-cross');
    expect(joinedA).toHaveLength('A-ownA-cross'.length);
    expect(seen.B.join('')).toBe('B-own');
    expect(`${seen.A.join('')}${seen.B.join('')}`).not.toContain('UNKNOWN');
  }, 30_000);

  it('serializes turns per session without blocking another session', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': [{ result: { thread: { id: 'thread-1' } } }, { result: { thread: { id: 'thread-2' } } }],
      'turn/start': [
        { result: { turn: { id: 'turn-A1' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-A1' } } },
          { delayMs: 150, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-A1', status: 'completed' } } },
        ] },
        { result: { turn: { id: 'turn-B1' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-2', turn: { id: 'turn-B1' } } },
          { delayMs: 20, method: 'turn/completed', params: { threadId: 'thread-2', turn: { id: 'turn-B1', status: 'completed' } } },
        ] },
        { result: { turn: { id: 'turn-A2' } }, notifications: [{ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-A2' } } }] },
        { result: { turn: { id: 'turn-A3' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-A3' } } },
          { delayMs: 20, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-A3', status: 'completed' } } },
        ] },
      ],
      'turn/interrupt': { result: {}, notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-A2', status: 'interrupted' } } }] },
    } });
    let aDone = false;
    const a1 = manager.startTurn('A', { ...turnOptions, prompt: 'A1' }).then((value) => { aDone = true; return value; });
    await waitForRecord(recordFile, (entry) => entry.direction === 'in' && entry.message.method === 'turn/start' && entry.message.params.threadId === 'thread-1');
    await expect(manager.startTurn('B', { ...turnOptions, prompt: 'B1' })).resolves.toMatchObject({ status: 'completed' });
    expect(aDone).toBe(false);
    await expect(a1).resolves.toMatchObject({ status: 'completed' });

    const a2 = manager.startTurn('A', { ...turnOptions, prompt: 'A2' });
    await waitForRecord(recordFile, (entry) => entry.direction === 'out' && entry.message.method === 'turn/started' && entry.message.params.turn.id === 'turn-A2');
    const abort = manager.abort('A');
    const a3 = manager.startTurn('A', { ...turnOptions, prompt: 'A3' });
    await abort;
    await expect(a2).resolves.toMatchObject({ status: 'interrupted' });
    await expect(a3).resolves.toMatchObject({ status: 'completed' });
    const inbound = records(recordFile).filter((entry) => entry.direction === 'in');
    const interruptIndex = inbound.findIndex((entry) => entry.message.method === 'turn/interrupt');
    const nextIndex = inbound.findIndex((entry, index) => index > interruptIndex && entry.message.method === 'turn/start' && entry.message.params.input?.[0]?.text === 'A3');
    expect(interruptIndex).toBeGreaterThan(-1);
    expect(nextIndex).toBeGreaterThan(interruptIndex);
  }, 30_000);

  it('settles a replaced turn before starting the next when its completion arrives late', async () => {
    const { manager, recordFile } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': [
        { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }] },
        { result: { turn: { id: 'turn-2' } }, notifications: [
          { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } },
          { delayMs: 30, method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-2', delta: 'fresh' } },
          { delayMs: 60, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', usage: { input_tokens: 2, output_tokens: 9 } } } },
        ] },
      ],
      // The interrupt reply is immediate but the interrupted completion lands
      // 60ms later — the replacing turn must wait for it, not race it.
      'turn/interrupt': { result: {}, notifications: [{ delayMs: 60, method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }] },
    } });
    const first = manager.startTurn('session', turnOptions);
    await waitForRecord(recordFile, (entry) => entry.direction === 'out' && entry.message.method === 'turn/started');
    const second = manager.startTurn('session', { ...turnOptions, prompt: 'replace' });
    await expect(first).resolves.toMatchObject({ status: 'interrupted' });
    await expect(second).resolves.toMatchObject({ status: 'completed', usage: { inputTokens: 2, outputTokens: 9 }, resultText: 'fresh' });
  }, 30_000);

  it('force-settles an interrupted turn when the server never reports completion', async () => {
    const { manager } = setup({ responses: {
      'thread/start': { result: { thread: { id: 'thread-1' } } },
      'turn/start': { result: { turn: { id: 'turn-1' } }, notifications: [{ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }] },
      'turn/interrupt': { result: {} },
    } }, {}, { interruptSettleMs: 200 });
    const outcome = manager.startTurn('session', turnOptions);
    await manager.abort('session');
    await expect(outcome).resolves.toMatchObject({ status: 'interrupted' });
  }, 30_000);
});
