import { describe, expect, it, vi } from 'vitest';
import { LiveQuery } from '../../src/providers/claude/live-query.js';
import type { AgentQueryStream, AgentSdkModule } from '../../src/providers/claude/sdk-loader.js';

function fakeSdk(withControls = true) {
  const output: Record<string, unknown>[] = [];
  let outputWaker: (() => void) | undefined;
  let terminal: { error?: unknown } | undefined;
  const pushedValues: unknown[] = [];
  const calls = {
    options: undefined as Record<string, unknown> | undefined,
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(),
    setModel: vi.fn(async (_model: string) => undefined),
    setPermissionMode: vi.fn(async (_mode: string) => undefined),
    stopTask: vi.fn(async (_taskId: string) => undefined),
  };

  async function* outputs(): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
      if (output.length > 0) yield output.shift()!;
      else if (terminal) {
        if (terminal.error !== undefined) throw terminal.error;
        return;
      } else {
        await new Promise<void>((resolve) => { outputWaker = resolve; });
        outputWaker = undefined;
      }
    }
  }

  const sdk: AgentSdkModule = {
    query: ({ prompt, options }) => {
      calls.options = options;
      void (async () => { for await (const message of prompt) pushedValues.push(message); })();
      const generator = outputs() as AgentQueryStream;
      if (withControls) {
        generator.interrupt = calls.interrupt;
        generator.close = calls.close;
        generator.setModel = calls.setModel;
        generator.setPermissionMode = calls.setPermissionMode;
        generator.stopTask = calls.stopTask;
      } else {
        generator.close = calls.close;
      }
      return generator;
    },
  };
  const wake = (): void => { outputWaker?.(); };
  return {
    sdk,
    feed: (message: Record<string, unknown>) => { output.push(message); wake(); },
    end: () => { terminal = {}; wake(); },
    fail: (error: unknown) => { terminal = { error }; wake(); },
    pushed: () => pushedValues,
    calls,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LiveQuery', () => {
  it('resolves a push on its result frame and dispatches every message', async () => {
    const fake = fakeSdk();
    const onMessage = vi.fn();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage });
    const pending = query.push({ role: 'user' });
    const messages = [{ type: 'stream_event' }, { type: 'assistant' }, { type: 'result', subtype: 'success' }];
    for (const message of messages) { fake.feed(message); await tick(); }
    await expect(pending).resolves.toBe(messages[2]);
    expect(onMessage.mock.calls.map(([message]) => message)).toEqual(messages);
    query.close();
  });

  it('matches two turns to result frames FIFO and preserves prompt order', async () => {
    const fake = fakeSdk();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined });
    const firstMessage = { turn: 1 };
    const secondMessage = { turn: 2 };
    const first = query.push(firstMessage);
    const second = query.push(secondMessage);
    await tick();
    const firstResult = { type: 'result', turn: 1 };
    const secondResult = { type: 'result', turn: 2 };
    fake.feed(firstResult); await tick();
    fake.feed(secondResult);
    await expect(first).resolves.toBe(firstResult);
    await expect(second).resolves.toBe(secondResult);
    expect(fake.pushed()).toEqual([firstMessage, secondMessage]);
    query.close();
  });

  it('continues draining when onMessage throws', async () => {
    const fake = fakeSdk();
    const callbackError = new Error('callback failed');
    const onError = vi.fn();
    const onMessage = vi.fn(() => { if (onMessage.mock.calls.length === 1) throw callbackError; });
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage, onError });
    const pending = query.push({ role: 'user' });
    fake.feed({ type: 'assistant' }); await tick();
    const result = { type: 'result' };
    fake.feed(result);
    await expect(pending).resolves.toBe(result);
    expect(onError).toHaveBeenCalledWith(callbackError);
    query.close();
  });

  it('rejects all pending pushes when the generator throws', async () => {
    const fake = fakeSdk();
    const onError = vi.fn();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined, onError });
    const first = query.push({ turn: 1 });
    const second = query.push({ turn: 2 });
    const error = new Error('boom');
    fake.fail(error);
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(onError).toHaveBeenCalledWith(error);
    expect(query.isClosed).toBe(true);
  });

  it('rejects a pending push when the generator ends gracefully', async () => {
    const fake = fakeSdk();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined });
    const pending = query.push({ role: 'user' });
    fake.end();
    await expect(pending).rejects.toThrow('closed before turn completed');
    expect(query.isClosed).toBe(true);
  });

  it('rejects push after close immediately', async () => {
    const fake = fakeSdk();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined });
    query.close();
    await expect(query.push({ role: 'user' })).rejects.toThrow('LiveQuery is closed');
  });

  it('wakes the prompt iterator and closes the generator once', async () => {
    const fake = fakeSdk();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined });
    await tick();
    query.close();
    query.close();
    expect(fake.calls.close).toHaveBeenCalledTimes(1);
    expect(query.isClosed).toBe(true);
  });

  it('delegates interrupt and reports unsupported and closed states', async () => {
    const fake = fakeSdk();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined });
    await query.interrupt();
    expect(fake.calls.interrupt).toHaveBeenCalledOnce();
    const unsupported = new LiveQuery({ sdk: fakeSdk(false).sdk, queryOptions: {}, onMessage: () => undefined });
    await expect(unsupported.interrupt()).rejects.toThrow('interrupt not supported by this SDK build');
    query.close(); unsupported.close();
    await expect(query.interrupt()).rejects.toThrow('LiveQuery is closed');
  });

  it('delegates setModel with its value and reports unsupported and closed states', async () => {
    const fake = fakeSdk();
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: {}, onMessage: () => undefined });
    await query.setModel('claude-sonnet');
    expect(fake.calls.setModel).toHaveBeenCalledWith('claude-sonnet');
    const unsupported = new LiveQuery({ sdk: fakeSdk(false).sdk, queryOptions: {}, onMessage: () => undefined });
    await expect(unsupported.setModel('x')).rejects.toThrow('setModel not supported by this SDK build');
    query.close(); unsupported.close();
    await expect(query.setModel('x')).rejects.toThrow('LiveQuery is closed');
  });

  it('validates sdk.query and onMessage', () => {
    expect(() => new LiveQuery({ sdk: {} as AgentSdkModule, queryOptions: {}, onMessage: () => undefined })).toThrow('sdk.query is required');
    expect(() => new LiveQuery({ sdk: fakeSdk().sdk, queryOptions: {}, onMessage: undefined as never })).toThrow('onMessage callback is required');
  });

  it('passes the exact queryOptions object to sdk.query', () => {
    const fake = fakeSdk();
    const options = { model: 'claude-sonnet' };
    const query = new LiveQuery({ sdk: fake.sdk, queryOptions: options, onMessage: () => undefined });
    expect(fake.calls.options).toBe(options);
    query.close();
  });
});
