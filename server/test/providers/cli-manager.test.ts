import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeOutcome, ResolvedNodeSpec, SpawnedNode } from '../../src/adapters/base.js';
import { CliSessionManager, type CliTransport } from '../../src/providers/cli/manager.js';
import { resetAgySessionRuntimeForTest, spawnAgy } from '../../src/providers/agy/runtime.js';
import { resetGrokSessionRuntimeForTest, spawnGrok } from '../../src/providers/grok/runtime.js';

const io = { onEvent: () => undefined, onRaw: () => undefined };

const spec = (
  provider: 'grok' | 'agy',
  promptText: string,
  resumeSessionRef?: string,
): ResolvedNodeSpec => ({
  binding: { provider, permission: 'auto' },
  promptText,
  cwd: '/repo',
  ...(resumeSessionRef ? { resumeSessionRef } : {}),
});

interface ControlledSpawn {
  spec: ResolvedNodeSpec;
  io: Parameters<CliTransport>[1];
  pid: number;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => void>>;
  resolve(outcome: NodeOutcome): void;
  reject(error: unknown): void;
}

function controlledTransport(): { spawn: CliTransport; calls: ControlledSpawn[] } {
  const calls: ControlledSpawn[] = [];
  const spawn: CliTransport = (nodeSpec, spawnIo): SpawnedNode => {
    let resolve!: (outcome: NodeOutcome) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<NodeOutcome>((done, fail) => { resolve = done; reject = fail; });
    const call: ControlledSpawn = {
      spec: nodeSpec,
      io: spawnIo,
      pid: 10_000 + calls.length,
      kill: vi.fn(),
      resolve,
      reject,
    };
    calls.push(call);
    return { pid: call.pid, kill: call.kill, completion };
  };
  return { spawn, calls };
}

afterEach(() => {
  resetGrokSessionRuntimeForTest();
  resetAgySessionRuntimeForTest();
  delete process.env.MAT_CLI_MANAGER_TEST_SECRET;
});

describe('CliSessionManager', () => {
  it('runs one resumable session FIFO, keeps different sessions parallel, and preserves fast-path pids', async () => {
    const transport = controlledTransport();
    const manager = new CliSessionManager({
      provider: 'grok',
      resumable: true,
      spawn: transport.spawn,
      createSessionId: () => 'fresh',
    });

    const first = manager.startRun(spec('grok', 'first', 'session-a'), io);
    const queued = manager.startRun(spec('grok', 'second', 'session-a'), io);
    const parallel = manager.startRun(spec('grok', 'parallel', 'session-b'), io);

    expect(first.pid).toBe(10_000);
    expect(queued.pid).toBe(0);
    expect(parallel.pid).toBe(10_001);
    expect(transport.calls.map((call) => call.spec.promptText)).toEqual(['first', 'parallel']);

    transport.calls[0]!.resolve({ exitCode: 0, sessionRef: 'session-a', resultText: 'one' });
    await vi.waitFor(() => expect(transport.calls).toHaveLength(3));
    expect(transport.calls.map((call) => call.spec.promptText)).toEqual(['first', 'parallel', 'second']);

    transport.calls[1]!.resolve({ exitCode: 0, sessionRef: 'session-b', resultText: 'other' });
    transport.calls[2]!.resolve({ exitCode: 0, sessionRef: 'session-a', resultText: 'two' });
    await expect(Promise.all([first.completion, queued.completion, parallel.completion])).resolves.toEqual([
      { exitCode: 0, sessionRef: 'session-a', resultText: 'one' },
      { exitCode: 0, sessionRef: 'session-a', resultText: 'two' },
      { exitCode: 0, sessionRef: 'session-b', resultText: 'other' },
    ]);
  }, 30_000);

  it('cancels a queued turn without spawning it', async () => {
    const transport = controlledTransport();
    const manager = new CliSessionManager({ provider: 'grok', resumable: true, spawn: transport.spawn });
    const active = manager.startRun(spec('grok', 'active', 'session-a'), io);
    const queued = manager.startRun(spec('grok', 'queued', 'session-a'), io);

    queued.kill('SIGKILL');
    await expect(queued.completion).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
    transport.calls[0]!.resolve({ exitCode: 0 });
    await active.completion;
    expect(transport.calls).toHaveLength(1);
  }, 30_000);

  it('normalizes an active kill and settles through the bounded fallback', async () => {
    const transport = controlledTransport();
    const manager = new CliSessionManager({
      provider: 'grok',
      resumable: true,
      spawn: transport.spawn,
      killFallbackMs: 20,
    });
    const active = manager.startRun(spec('grok', 'active', 'session-a'), io);

    active.kill();
    expect(transport.calls[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(active.completion).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
    transport.calls[0]!.resolve({ exitCode: 1, error: 'late provider failure' });
  }, 30_000);

  it('holds the FIFO slot and drops late output until a killed transport actually closes', async () => {
    const transport = controlledTransport();
    const onEvent = vi.fn();
    const onRaw = vi.fn();
    const manager = new CliSessionManager({
      provider: 'grok',
      resumable: true,
      spawn: transport.spawn,
      killFallbackMs: 20,
    });
    const active = manager.startRun(spec('grok', 'active', 'session-a'), { onEvent, onRaw });
    const queued = manager.startRun(spec('grok', 'queued', 'session-a'), { onEvent, onRaw });

    active.kill();
    await expect(active.completion).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
    expect(transport.calls).toHaveLength(1);
    transport.calls[0]!.io.onRaw('late raw output', 'out');
    transport.calls[0]!.io.onEvent({ role: 'agent', kind: 'message', text: 'late event' });
    expect(onRaw).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();

    transport.calls[0]!.resolve({ exitCode: 1, error: 'late close' });
    await vi.waitFor(() => expect(transport.calls).toHaveLength(2));
    transport.calls[1]!.resolve({ exitCode: 0, resultText: 'next' });
    await expect(queued.completion).resolves.toEqual({ exitCode: 0, resultText: 'next' });
  }, 30_000);

  it('turns throws and rejected completions into redacted exit-1 outcomes', async () => {
    process.env.MAT_CLI_MANAGER_TEST_SECRET = 'cli-manager-secret-482719';
    const secret = process.env.MAT_CLI_MANAGER_TEST_SECRET;
    const throwing = new CliSessionManager({
      provider: 'grok',
      resumable: true,
      spawn: () => { throw new Error(`spawn failed ${secret}`); },
    });
    const thrown = throwing.startRun(spec('grok', 'throw'), io);
    await expect(thrown.completion).resolves.toMatchObject({ exitCode: 1, error: expect.not.stringContaining(secret) });

    const transport = controlledTransport();
    const rejecting = new CliSessionManager({ provider: 'agy', resumable: false, spawn: transport.spawn });
    const rejected = rejecting.startRun(spec('agy', 'reject'), io);
    transport.calls[0]!.reject(new Error(`transport failed ${secret}`));
    await expect(rejected.completion).resolves.toMatchObject({ exitCode: 1, error: expect.not.stringContaining(secret) });
  }, 30_000);

  it('normalizes provider failures and admits only strict Usage fields', async () => {
    process.env.MAT_CLI_MANAGER_TEST_SECRET = 'cli-manager-secret-915204';
    const secret = process.env.MAT_CLI_MANAGER_TEST_SECRET;
    const transport = controlledTransport();
    const manager = new CliSessionManager({ provider: 'agy', resumable: false, spawn: transport.spawn });
    const failed = manager.startRun(spec('agy', 'failure'), io);
    transport.calls[0]!.resolve({
      exitCode: 7,
      error: `provider failed ${secret}`,
      sessionRef: secret,
      usage: {
        inputTokens: 2,
        outputTokens: -1,
        costUsd: 0,
        secretTokens: 99,
      } as NodeOutcome['usage'],
    });
    await expect(failed.completion).resolves.toEqual({
      exitCode: 1,
      sessionRef: '[REDACTED_ENV]',
      usage: { inputTokens: 2, costUsd: 0 },
      error: expect.not.stringContaining(secret),
    });
  }, 30_000);
});

describe('grok and agy CLI runtimes', () => {
  it('configures Grok as resumable and Agy as non-resumable', async () => {
    const grok = controlledTransport();
    resetGrokSessionRuntimeForTest({ spawn: grok.spawn });
    const grokFirst = spawnGrok(spec('grok', 'grok-1', 'same'), io);
    const grokSecond = spawnGrok(spec('grok', 'grok-2', 'same'), io);
    expect(grok.calls).toHaveLength(1);
    grok.calls[0]!.resolve({ exitCode: 0 });
    await vi.waitFor(() => expect(grok.calls).toHaveLength(2));
    grok.calls[1]!.resolve({ exitCode: 0 });
    await Promise.all([grokFirst.completion, grokSecond.completion]);

    const agy = controlledTransport();
    resetAgySessionRuntimeForTest({ spawn: agy.spawn });
    const agyFirst = spawnAgy(spec('agy', 'agy-1', 'ignored'), io);
    const agySecond = spawnAgy(spec('agy', 'agy-2', 'ignored'), io);
    expect(agy.calls).toHaveLength(2);
    expect([agyFirst.pid, agySecond.pid]).toEqual([10_000, 10_001]);
    agy.calls[0]!.resolve({ exitCode: 0 });
    agy.calls[1]!.resolve({ exitCode: 0 });
    await Promise.all([agyFirst.completion, agySecond.completion]);
  }, 30_000);
});
