import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContentEvent, RuntimeChangedEvent } from '@mat/shared';
import type { ResolvedNodeSpec } from '../../src/adapters/base.js';
import { spawnClaude } from '../../src/adapters/claude.js';
import { resetClaudeSessionRuntimeForTest } from '../../src/providers/claude/runtime.js';
import { setSdkOverrideForTest, type AgentQueryStream, type AgentSdkModule } from '../../src/providers/claude/sdk-loader.js';

const spec = (permission: ResolvedNodeSpec['binding']['permission'] = 'standard', resumeSessionRef?: string): ResolvedNodeSpec => ({
  binding: { provider: 'claude', role: 'coder', permission }, promptText: 'hello', cwd: '/repo', ...(resumeSessionRef ? { resumeSessionRef } : {}),
});
const io = (events: AdapterContentEvent[] = []) => ({ onEvent: (event: AdapterContentEvent) => events.push(event), onRaw: () => undefined });

interface FakeQuery {
  options: Record<string, any>;
  prompts: Record<string, unknown>[];
  feed(message: Record<string, unknown>): void;
  end(): void;
  fail(error: Error): void;
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSdk(withInterrupt = true) {
  const queries: FakeQuery[] = [];
  const sdk: AgentSdkModule = { query: vi.fn(({ prompt, options }) => {
    const waiting: Array<{ resolve(value: IteratorResult<Record<string, unknown>>): void; reject(error: Error): void }> = [];
    const frames: IteratorResult<Record<string, unknown>>[] = [];
    const prompts: Record<string, unknown>[] = [];
    let failure: Error | undefined;
    void (async () => { for await (const value of prompt) prompts.push(value as Record<string, unknown>); })();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(() => query.end());
    const stream = {
      next: () => failure ? Promise.reject(failure) : frames.length ? Promise.resolve(frames.shift()!) : new Promise((resolve, reject) => waiting.push({ resolve, reject })),
      return: async () => ({ done: true as const, value: undefined }),
      throw: async (error: unknown) => { throw error; },
      [Symbol.asyncIterator]() { return this; },
      ...(withInterrupt ? { interrupt } : {}), close,
    } as AgentQueryStream;
    const query: FakeQuery = {
      options, prompts, interrupt, close,
      feed(message) { const frame = { done: false as const, value: message }; const waiter = waiting.shift(); waiter ? waiter.resolve(frame) : frames.push(frame); },
      end() { const frame = { done: true as const, value: undefined }; const waiter = waiting.shift(); waiter ? waiter.resolve(frame) : frames.push(frame); },
      fail(error) { failure = error; for (const waiter of waiting.splice(0)) waiter.reject(error); },
    };
    queries.push(query);
    return stream;
  }) };
  return { sdk, queries };
}

function setup(fake: ReturnType<typeof fakeSdk>, extra: { reapTickMs?: number; reapIdleMs?: number; interruptFallbackMs?: number; resolveBinary?: () => Promise<string | null> } = {}) {
  const listeners = new Set<(event: RuntimeChangedEvent) => void>();
  setSdkOverrideForTest(fake.sdk);
  resetClaudeSessionRuntimeForTest({ resolveBinary: async () => '/fake/claude', subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, ...extra });
  return { emitChange: () => { for (const listener of listeners) listener({ family: 'claude', state: 'managed' }); } };
}
async function query(fake: ReturnType<typeof fakeSdk>, index = 0) { await vi.waitFor(() => expect(fake.queries.length).toBeGreaterThan(index)); return fake.queries[index]!; }

afterEach(() => { setSdkOverrideForTest(undefined); resetClaudeSessionRuntimeForTest(); delete process.env.MAT_CLAUDE_RUNTIME; });

describe('Claude session runtime', () => {
  it('is the default path and translates streams, tools, usage, and result', async () => {
    const fake = fakeSdk(); setup(fake); const events: AdapterContentEvent[] = [];
    const run = spawnClaude(spec(), io(events)); const q = await query(fake);
    q.feed({ type: 'system', subtype: 'init', session_id: 'sdk-1' });
    q.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hel' } } });
    q.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'lo' } } });
    q.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }] } });
    q.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    q.feed({ type: 'result', subtype: 'success', result: 'hello', usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0.01, session_id: 'sdk-1' });
    await expect(run.completion).resolves.toEqual({ exitCode: 0, sessionRef: 'sdk-1', usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01 }, resultText: 'hello' });
    // Stream deltas coalesce into one message (flushed at turn end); tool events pass through directly.
    expect(events.map((event) => event.kind)).toEqual(['tool_use', 'tool_result', 'message']);
    expect(events[2]).toMatchObject({ role: 'agent', text: 'hello' });
  });

  it.each([['full', 'bypassPermissions', true], ['safe', 'plan', undefined], ['standard', 'acceptEdits', undefined]] as const)('builds %s query options', async (permission, mode, dangerous) => {
    const fake = fakeSdk(); setup(fake); const run = spawnClaude({ ...spec(permission), binding: { ...spec(permission).binding, model: 'opus', effort: 'high' } }, io());
    const q = await query(fake); expect(q.options).toMatchObject({ cwd: '/repo', permissionMode: mode, model: 'opus', effort: 'high', includePartialMessages: true, systemPrompt: { preset: 'claude_code' }, tools: { preset: 'claude_code' } });
    expect(q.options.allowDangerouslySkipPermissions).toBe(dangerous); q.feed({ type: 'result', subtype: 'success' }); await run.completion;
  });

  it('uses synchronous non-interactive tool policy', async () => {
    const fake = fakeSdk(); setup(fake); const standard = spawnClaude(spec(), io()); const q1 = await query(fake); const edit = q1.options.canUseTool('Edit', { x: 1 });
    expect(edit).toEqual({ behavior: 'allow', updatedInput: { x: 1 } }); expect(edit).not.toBeInstanceOf(Promise); expect(q1.options.canUseTool('Bash', {})).toMatchObject({ behavior: 'deny' }); q1.feed({ type: 'result', subtype: 'success' }); await standard.completion;
    const safe = spawnClaude(spec('safe'), io()); const q2 = await query(fake, 1); expect(q2.options.canUseTool('Read', {})).toMatchObject({ behavior: 'allow' }); expect(q2.options.canUseTool('Write', {})).toMatchObject({ behavior: 'deny' }); q2.feed({ type: 'result', subtype: 'success' }); await safe.completion;
    const full = spawnClaude(spec('full'), io()); const q3 = await query(fake, 2); expect(q3.options.canUseTool('Bash', { cmd: 'ls' })).toEqual({ behavior: 'allow', updatedInput: { cmd: 'ls' } }); q3.feed({ type: 'result', subtype: 'success' }); await full.completion;
  });

  it('maps maxTurns and systemPromptAppend into query options', async () => {
    const fake = fakeSdk(); setup(fake); const base = spec();
    const run = spawnClaude({ ...base, binding: { ...base.binding, maxTurns: 3, systemPromptAppend: 'extra rules' } }, io());
    const q = await query(fake);
    expect(q.options.maxTurns).toBe(3);
    expect(q.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'extra rules' });
    q.feed({ type: 'result', subtype: 'success' }); await run.completion;
  });

  it('interrupts a turn and reuses the live query', async () => {
    const fake = fakeSdk(); setup(fake); const first = spawnClaude(spec('standard', 'sdk-1'), io()); const q = await query(fake); first.kill(); await vi.waitFor(() => expect(q.interrupt).toHaveBeenCalledOnce()); q.feed({ type: 'result', subtype: 'success', session_id: 'sdk-1' });
    await expect(first.completion).resolves.toEqual({ exitCode: null, signal: 'SIGTERM', sessionRef: 'sdk-1' });
    const second = spawnClaude(spec('standard', 'sdk-1'), io()); await vi.waitFor(() => expect(q.prompts).toHaveLength(2)); q.feed({ type: 'result', subtype: 'success', session_id: 'sdk-1' }); await expect(second.completion).resolves.toMatchObject({ exitCode: 0 }); expect(fake.queries).toHaveLength(1);
  });

  it('falls back to close when interrupt is unsupported and never rejects', async () => {
    const fake = fakeSdk(false); setup(fake); const run = spawnClaude(spec(), io()); const q = await query(fake); run.kill(); await expect(run.completion).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM' }); expect(q.close).toHaveBeenCalled();
  });

  it('maps error results and unavailable SDK to resolved failures', async () => {
    const fake = fakeSdk(); setup(fake); const run = spawnClaude(spec(), io()); const q = await query(fake); q.feed({ type: 'result', subtype: 'error_during_execution' }); await expect(run.completion).resolves.toMatchObject({ exitCode: 1, error: expect.stringContaining('error_during_execution') });
    setSdkOverrideForTest(null); resetClaudeSessionRuntimeForTest({ resolveBinary: async () => '/fake/claude' }); await expect(spawnClaude(spec(), io()).completion).resolves.toMatchObject({ exitCode: 1, error: expect.stringContaining('MAT_CLAUDE_RUNTIME=cli') });
  });

  it('seeds resume and adopts a reported session id', async () => {
    const fake = fakeSdk(); setup(fake); const run = spawnClaude(spec('standard', 'sdk-9'), io()); const q = await query(fake); expect(q.options.resume).toBe('sdk-9'); q.feed({ type: 'system', session_id: 'sdk-new' }); q.feed({ type: 'result', subtype: 'success' }); await expect(run.completion).resolves.toMatchObject({ sessionRef: 'sdk-new' });
  });

  it('rebuilds a closed generator with resume', async () => {
    const fake = fakeSdk(); setup(fake); const first = spawnClaude(spec('standard', 'key'), io()); const q1 = await query(fake); q1.feed({ type: 'system', session_id: 'sdk-1' }); q1.feed({ type: 'result', subtype: 'success' }); q1.end(); await first.completion;
    const second = spawnClaude(spec('standard', 'key'), io()); const q2 = await query(fake, 1); expect(q2.options.resume).toBe('sdk-1'); q2.feed({ type: 'result', subtype: 'success' }); await second.completion;
  });

  it('kills a queued run before its turn starts without leaking interrupt state', async () => {
    const fake = fakeSdk(); setup(fake);
    const first = spawnClaude(spec('standard', 'key'), io());
    const second = spawnClaude(spec('standard', 'key'), io());
    const q = await query(fake); await vi.waitFor(() => expect(q.prompts).toHaveLength(1));
    second.kill();
    q.feed({ type: 'result', subtype: 'success' });
    await expect(first.completion).resolves.toMatchObject({ exitCode: 0 });
    await expect(second.completion).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    expect(q.prompts).toHaveLength(1); expect(q.interrupt).not.toHaveBeenCalled();
    const third = spawnClaude(spec('standard', 'key'), io()); await vi.waitFor(() => expect(q.prompts).toHaveLength(2));
    q.feed({ type: 'result', subtype: 'success' }); await expect(third.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it('classifies a kill during setup as killed, tears down the fresh live, and leaks no interrupt state', async () => {
    const fake = fakeSdk();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void; const reachedGate = new Promise<void>((resolve) => { reached = resolve; });
    setup(fake, { resolveBinary: async () => { reached(); await gate; return '/fake/claude'; } });
    const run = spawnClaude(spec('standard', 'key'), io());
    await reachedGate; run.kill(); release();
    await expect(run.completion).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    const q1 = await query(fake); expect(q1.interrupt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(q1.close).toHaveBeenCalled()); expect(q1.prompts).toHaveLength(0);
    const second = spawnClaude(spec('standard', 'key'), io()); const q2 = await query(fake, 1);
    await vi.waitFor(() => expect(q2.prompts).toHaveLength(1)); q2.feed({ type: 'result', subtype: 'success' });
    await expect(second.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it('force-closes when an accepted interrupt never yields a result', async () => {
    const fake = fakeSdk(); setup(fake, { interruptFallbackMs: 30 });
    const run = spawnClaude(spec(), io()); const q = await query(fake);
    await vi.waitFor(() => expect(q.prompts).toHaveLength(1));
    run.kill();
    await expect(run.completion).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    expect(q.interrupt).toHaveBeenCalledOnce(); expect(q.close).toHaveBeenCalled();
  });

  it('reaps an idle live query and rebuilds with resume', async () => {
    const fake = fakeSdk(); setup(fake, { reapTickMs: 10, reapIdleMs: 40 });
    const first = spawnClaude(spec('standard', 'key'), io()); const q1 = await query(fake);
    q1.feed({ type: 'system', session_id: 'sdk-1' }); q1.feed({ type: 'result', subtype: 'success' }); await first.completion;
    await vi.waitFor(() => expect(q1.close).toHaveBeenCalled());
    const second = spawnClaude(spec('standard', 'key'), io()); const q2 = await query(fake, 1);
    expect(q2.options.resume).toBe('sdk-1'); q2.feed({ type: 'result', subtype: 'success' }); await second.completion;
  });

  it('serializes turns for one session', async () => {
    const fake = fakeSdk(); setup(fake); const first = spawnClaude(spec('standard', 'key'), io()); const second = spawnClaude(spec('standard', 'key'), io()); const q = await query(fake); await vi.waitFor(() => expect(q.prompts).toHaveLength(1)); q.feed({ type: 'result', subtype: 'success' }); await first.completion; await vi.waitFor(() => expect(q.prompts).toHaveLength(2)); q.feed({ type: 'result', subtype: 'success' }); await second.completion;
  });

  it('keeps CLI as an explicit opt-out', async () => {
    const fake = fakeSdk(); setup(fake); process.env.MAT_CLAUDE_RUNTIME = 'cli'; const run = spawnClaude({ ...spec(), runtimeCommand: process.execPath }, io()); run.kill(); await run.completion; expect(fake.queries).toHaveLength(0);
  });

  it('enriches exit errors with cleaned stderr', async () => {
    const fake = fakeSdk(); setup(fake); const run = spawnClaude(spec(), io()); const q = await query(fake); q.options.stderr('\u001b[31m useful   detail \u001b[0m'); q.fail(new Error('claude exited with code 1')); await expect(run.completion).resolves.toMatchObject({ exitCode: 1, error: expect.stringContaining('useful detail') });
  });

  it('recycles an idle live query after a runtime change', async () => {
    const fake = fakeSdk(); const control = setup(fake); const first = spawnClaude(spec('standard', 'key'), io()); const q1 = await query(fake); q1.feed({ type: 'system', session_id: 'sdk-1' }); q1.feed({ type: 'result', subtype: 'success' }); await first.completion; control.emitChange(); expect(q1.close).toHaveBeenCalled();
    const second = spawnClaude(spec('standard', 'key'), io()); const q2 = await query(fake, 1); expect(q2.options.resume).toBe('sdk-1'); q2.feed({ type: 'result', subtype: 'success' }); await second.completion;
  });

  it('resolves a random generator failure', async () => {
    const fake = fakeSdk(); setup(fake); const run = spawnClaude(spec(), io()); const q = await query(fake); q.fail(new Error('random boom')); await expect(run.completion).resolves.toMatchObject({ exitCode: 1, error: expect.stringContaining('random boom') });
  });
});
