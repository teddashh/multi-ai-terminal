import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexConnection, UNHANDLED, type CodexConnectionConfig } from '../../src/providers/codex/connection.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-app-server.mjs');
let root: string;
let recordFile: string;
let connections: CodexConnection[];

type Scenario = Record<string, unknown>;
type Recorded = { direction: 'in' | 'out'; message: Record<string, unknown>; spawnIndex: number; apiKeyPresent: boolean };

function records(): Recorded[] {
  try {
    return readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Recorded);
  } catch {
    return [];
  }
}

function configureScenario(scenario: Scenario): void {
  process.env.MAT_FAKE_APPSERVER_SCENARIO = JSON.stringify({ ...scenario, recordFile });
}

function connection(overrides: Partial<CodexConnectionConfig> = {}): CodexConnection {
  const value = new CodexConnection({
    command: process.execPath,
    spawnArgs: [fixturePath],
    codexHome: join(root, 'codex-home'),
    purpose: 'session',
    clientInfo: { name: 'mat-test', title: 'MAT test', version: '0.0.0' },
    onNotification: () => undefined,
    idleReaper: false,
    ...overrides,
  });
  connections.push(value);
  return value;
}

async function waitForRecord(predicate: (record: Recorded) => boolean): Promise<Recorded> {
  let found: Recorded | undefined;
  await vi.waitFor(() => {
    found = records().find(predicate);
    expect(found).toBeDefined();
  }, { timeout: 5_000, interval: 20 });
  return found!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mat-codex-connection-'));
  recordFile = join(root, 'wire.jsonl');
  connections = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.map((value) => value.dispose()));
  delete process.env.MAT_FAKE_APPSERVER_SCENARIO;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('CodexConnection', () => {
  it('completes initialize/initialized before writing the first caller request', async () => {
    configureScenario({ responses: { first: { result: 'ok', requireInitialized: true } } });
    await expect(connection().request('first', { value: 1 })).resolves.toBe('ok');

    const inbound = records().filter((entry) => entry.direction === 'in').map((entry) => entry.message);
    expect(inbound.map((message) => message.method)).toEqual(['initialize', 'initialized', 'first']);
    expect(inbound[0]).toMatchObject({ id: 1, params: { capabilities: { experimentalApi: true } } });
    expect(inbound[2]).toMatchObject({ id: 2 });
  }, 30_000);

  it('multiplexes concurrent requests and resolves out-of-order replies correctly', async () => {
    configureScenario({ responses: {
      slow: { result: 'slow-result', delayMs: 80 },
      fast: { result: 'fast-result', delayMs: 5 },
    } });
    const client = connection();
    const completionOrder: string[] = [];
    const slow = client.request<string>('slow').then((value) => { completionOrder.push(value); return value; });
    const fast = client.request<string>('fast').then((value) => { completionOrder.push(value); return value; });
    await expect(Promise.all([slow, fast])).resolves.toEqual(['slow-result', 'fast-result']);
    expect(completionOrder).toEqual(['fast-result', 'slow-result']);
  }, 30_000);

  it('dispatches notifications', async () => {
    configureScenario({ responses: { trigger: {
      result: true,
      notification: { method: 'turn/progress', params: { delta: 'hello' }, delayMs: 5 },
    } } });
    const onNotification = vi.fn();
    await connection({ onNotification }).request('trigger');
    await vi.waitFor(() => expect(onNotification).toHaveBeenCalledWith('turn/progress', { delta: 'hello' }));
  }, 30_000);

  it('answers a server-initiated request asynchronously with the echoed server id', async () => {
    configureScenario({ responses: { trigger: {
      result: true,
      serverRequest: { method: 'approval/request', id: 'server-7', params: { command: 'safe' } },
    } } });
    const client = connection({ onServerRequest: async (method, params) => ({ method, params }) });
    await client.request('trigger');
    const reply = await waitForRecord((entry) => entry.direction === 'in' && entry.message.id === 'server-7');
    expect(reply.message).toEqual({ id: 'server-7', result: { method: 'approval/request', params: { command: 'safe' } } });
  }, 30_000);

  it('answers an unhandled server request with method-not-found', async () => {
    configureScenario({ responses: { trigger: {
      result: true,
      serverRequest: { method: 'unknown/request', id: 44, params: {} },
    } } });
    await connection({ onServerRequest: async () => UNHANDLED }).request('trigger');
    const reply = await waitForRecord((entry) => entry.direction === 'in' && entry.message.id === 44);
    expect(reply.message).toEqual({ id: 44, error: { code: -32601, message: 'method not found' } });
  }, 30_000);

  it('times out one request, removes it, and ignores its late reply', async () => {
    configureScenario({ responses: {
      late: { result: 'too late', delayMs: 100 },
      next: { result: 'still alive' },
    } });
    const client = connection();
    await expect(client.request('late', undefined, { timeoutMs: 20 })).rejects.toThrow('timed out: late');
    await new Promise((resolve) => setTimeout(resolve, 130));
    await expect(client.request('next')).resolves.toBe('still alive');
  }, 30_000);

  it('drains pending work on EOF, fires the loss hook, then respawns and handshakes', async () => {
    const spawnMarkerFile = join(root, 'spawns.txt');
    writeFileSync(spawnMarkerFile, '');
    configureScenario({ spawnMarkerFile, responses: { work: {
      noReplyOnSpawn: 1,
      resultBySpawn: { 2: 'fresh-child' },
      exitAfter: 20,
      exitOnSpawn: 1,
    } } });
    const onConnectionLost = vi.fn();
    const client = connection({ onConnectionLost });
    await expect(client.request('work')).rejects.toThrow('connection lost');
    expect(onConnectionLost).toHaveBeenCalledTimes(1);
    await expect(client.request('work')).resolves.toBe('fresh-child');

    expect(readFileSync(spawnMarkerFile, 'utf8').trim().split('\n')).toHaveLength(2);
    const initializeSpawns = records()
      .filter((entry) => entry.direction === 'in' && entry.message.method === 'initialize')
      .map((entry) => entry.spawnIndex);
    expect(initializeSpawns).toEqual([1, 2]);
  }, 30_000);

  it('kills an idle connection idempotently', async () => {
    configureScenario({ responses: { ping: { result: 'pong' } } });
    const client = connection();
    await client.request('ping');
    expect(client.connected()).toBe(true);
    await client.kill();
    await client.kill();
    expect(client.connected()).toBe(false);
  }, 30_000);

  it('injects API-key presence only into session-purpose children', async () => {
    configureScenario({ responses: { ping: { result: true } } });
    const session = connection({ purpose: 'session', apiKey: 'test-secret-value' });
    await session.request('ping');
    await session.kill();

    const login = connection({ purpose: 'login', apiKey: 'test-secret-value' });
    await login.request('ping');
    const initializeRecords = records().filter((entry) => entry.direction === 'in' && entry.message.method === 'initialize');
    expect(initializeRecords.map((entry) => entry.apiKeyPresent)).toEqual([true, false]);
    expect(readFileSync(recordFile, 'utf8')).not.toContain('test-secret-value');
  }, 30_000);

  it('redacts credentials injected only into the child environment from stderr', async () => {
    const canary = 'mat-child-only-secret-canary';
    configureScenario({
      stderrEnvironmentName: 'MAT_TEST_CHILD_SECRET',
      responses: { ping: { result: true } },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const client = connection({ extraEnv: { MAT_TEST_CHILD_SECRET: canary } });
      await client.request('ping');
      await client.kill();
      await vi.waitFor(() => {
        expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('[REDACTED_ENV]');
      }, { timeout: 5_000, interval: 20 });
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain(canary);
    } finally {
      stderr.mockRestore();
    }
  }, 30_000);

  it('redacts a child-only credential echoed by a JSON-RPC error', async () => {
    const canary = 'mat-rpc-child-secret-canary';
    configureScenario({
      responses: {
        ping: { error: { code: 401, message: `provider rejected ${canary}` } },
      },
    });
    const client = connection({ apiKey: canary });
    let message = '';
    try {
      await client.request('ping');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('[REDACTED_ENV]');
    expect(message).not.toContain(canary);
  }, 30_000);

  it('replies -32601 with no handler configured and -32603 when the handler throws', async () => {
    configureScenario({ warningLine: 'codex: warming up', responses: {
      triggerUnhandled: { result: 'first', serverRequest: { method: 'approval/request', id: 91, params: {} } },
      triggerThrow: { result: 'second', serverRequest: { method: 'approval/request', id: 92, params: {} } },
    } });
    const bare = connection();
    // Resolving at all proves the non-JSON warning line was skipped, not fatal.
    await expect(bare.request('triggerUnhandled')).resolves.toBe('first');
    const unhandled = await waitForRecord((entry) => entry.direction === 'in' && entry.message.id === 91);
    expect(unhandled.message).toEqual({ id: 91, error: { code: -32601, message: 'method not found' } });
    await bare.kill();

    const throwing = connection({ onServerRequest: async () => { throw new Error('handler boom'); } });
    await expect(throwing.request('triggerThrow')).resolves.toBe('second');
    const failed = await waitForRecord((entry) => entry.direction === 'in' && entry.message.id === 92);
    expect(failed.message).toEqual({ id: 92, error: { code: -32603, message: 'handler boom' } });
  }, 30_000);

  it('does not reap a connection while a request is in flight', async () => {
    vi.useFakeTimers();
    configureScenario({ responses: { ping: { result: 'pong' }, slow: { result: 'done', delayMs: 150 } } });
    const client = connection({ idleReaper: { checkIntervalMs: 50, idleAfterMs: 100 } });
    await client.request('ping');
    const inFlight = client.request<string>('slow', undefined, { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(client.connected()).toBe(true);
    await expect(inFlight).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(150);
    expect(client.connected()).toBe(false);
  }, 30_000);

  it('reaps an idle connection and defers requested recycling until busy clears', async () => {
    vi.useFakeTimers();
    configureScenario({ responses: { ping: { result: 'pong' } } });
    let busy = false;
    const idle = connection({ isBusy: () => busy, idleReaper: { checkIntervalMs: 100, idleAfterMs: 200 } });
    await idle.request('ping');
    await vi.advanceTimersByTimeAsync(200);
    expect(idle.connected()).toBe(false);

    const deferred = connection({ isBusy: () => busy, idleReaper: { checkIntervalMs: 100, idleAfterMs: 10_000 } });
    await deferred.request('ping');
    busy = true;
    deferred.recycleIfIdle('auth changed');
    await vi.advanceTimersByTimeAsync(100);
    expect(deferred.connected()).toBe(true);
    busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(deferred.connected()).toBe(false);
  }, 30_000);
});
