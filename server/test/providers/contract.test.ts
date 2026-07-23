import { describe, expect, it } from 'vitest';
import { ProviderSessionMetaSchema, type AdapterContentEvent } from '@mat/shared';
import type { ResolvedNodeSpec } from '../../src/adapters/base.js';
import {
  ProviderTurnBridge,
  buildProviderSessionMeta,
  canonicalToolName,
  type ProviderTechnicalEvidence,
} from '../../src/providers/contract.js';

const spec: ResolvedNodeSpec = {
  binding: {
    provider: 'codex',
    model: 'gpt-test',
    effort: 'high',
    permission: 'auto',
  },
  promptText: 'hello',
  cwd: '/repo',
};

function setup(now = 100) {
  const content: AdapterContentEvent[] = [];
  const technical: ProviderTechnicalEvidence[] = [];
  const bridge = new ProviderTurnBridge({
    provider: 'codex',
    sessionId: 'session-1',
    spec,
    sink: {
      onContent: (event) => content.push(event),
      onTechnical: (event) => technical.push(event),
    },
    now: () => now,
  });
  return { bridge, content, technical };
}

describe('canonical provider contract', () => {
  it('builds the full BAT status shape from explicit defaults', () => {
    const meta = buildProviderSessionMeta({ model: 'gpt-test', isStreaming: true });
    expect(ProviderSessionMetaSchema.parse(meta)).toEqual(meta);
    expect(Object.keys(meta)).toHaveLength(24);
    expect(meta).toMatchObject({
      permissionMode: 'default',
      model: 'gpt-test',
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
      isStreaming: true,
      runtimeStatus: null,
    });
  });

  it('normalizes tool names at one provider-neutral boundary', () => {
    expect(canonicalToolName('shell')).toBe('Bash');
    expect(canonicalToolName('command_execution')).toBe('Bash');
    expect(canonicalToolName('fileChange')).toBe('Edit');
    expect(canonicalToolName('web_search')).toBe('WebSearch');
    expect(canonicalToolName('todoList')).toBe('TodoWrite');
    expect(canonicalToolName('ProviderSpecificTool')).toBe('ProviderSpecificTool');
  });

  it('projects content in source order and carries canonical provenance', () => {
    const { bridge, content, technical } = setup();
    bridge.start();
    bridge.acceptContent({ role: 'agent', kind: 'message', text: 'before' });
    bridge.acceptContent({
      role: 'tool',
      kind: 'tool_use',
      text: 'command',
      tool: { toolCallId: 'tool-1', name: 'command_execution', input: '{"command":"pwd"}' },
    });
    bridge.acceptContent({
      role: 'tool',
      kind: 'tool_result',
      text: '/repo',
      tool: { toolCallId: 'tool-1', name: 'ignored', output: '/repo', isError: false },
    });
    bridge.acceptContent({ role: 'thinking', kind: 'thinking', text: 'after' });

    expect(content.map((event) => event.kind)).toEqual(['message', 'tool_use', 'tool_result', 'thinking']);
    expect(content[1]?.tool).toMatchObject({ toolCallId: 'tool-1', name: 'Bash' });
    expect(content[2]?.tool).toMatchObject({ toolCallId: 'tool-1', name: 'Bash', output: '/repo' });
    expect(content.every((event) => typeof event.data?.providerEvent === 'string')).toBe(true);
    expect(technical.map((event) => event.data.providerEvent)).toEqual([
      'claude:status',
      'claude:status',
    ]);
    expect(technical.every((event) => ProviderSessionMetaSchema.safeParse(event.data.providerStatus).success)).toBe(true);
  });

  it('pairs id-less tool results with pending tool uses deterministically', () => {
    const { bridge, content } = setup();
    bridge.acceptContent({
      role: 'tool',
      kind: 'tool_use',
      text: 'command',
      tool: { name: 'shell', input: '{"command":"pwd"}' },
    });
    bridge.acceptContent({
      role: 'tool',
      kind: 'tool_result',
      text: '/repo',
      tool: { name: 'shell', output: '/repo', isError: false },
    });

    expect(content).toHaveLength(2);
    expect(content[0]?.tool).toMatchObject({ toolCallId: 'provider-tool-1', name: 'Bash' });
    expect(content[1]?.tool).toMatchObject({ toolCallId: 'provider-tool-1', name: 'Bash' });
  });

  it('maps technical events but never re-appends provider history', () => {
    const { bridge, content, technical } = setup();
    bridge.emit({
      type: 'claude:history',
      sessionId: 'session-1',
      items: [{
        id: 'old-message',
        sessionId: 'session-1',
        role: 'assistant',
        content: 'persisted already',
        timestamp: 1,
      }],
    });
    bridge.emit({
      type: 'claude:resume-loading',
      sessionId: 'session-1',
      loading: true,
    });
    bridge.emit({
      type: 'claude:modeChange',
      sessionId: 'session-1',
      mode: 'plan',
    });

    expect(content).toEqual([]);
    expect(technical.map((event) => event.data.providerEvent)).toEqual([
      'claude:resume-loading',
      'claude:modeChange',
    ]);
  });

  it('records exactly one canonical turn end in the existing terminal outcome', () => {
    const { bridge, technical } = setup(250);
    bridge.start();
    const outcome = bridge.finish({
      exitCode: 0,
      sessionRef: 'thread-1',
      usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
      resultText: 'done',
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      providerTurn: {
        event: 'claude:turn-end',
        sessionId: 'session-1',
        reason: 'completed',
        status: {
          sdkSessionId: 'thread-1',
          inputTokens: 8,
          outputTokens: 3,
          totalCost: 0.02,
          numTurns: 1,
          isStreaming: false,
        },
      },
    });
    expect(technical.at(-1)?.data).toMatchObject({
      providerEvent: 'claude:status',
      providerStatus: { isStreaming: false, runtimeStatus: null },
    });
    expect(() => bridge.finish({ exitCode: 0 })).toThrow(/finished more than once/);
  });

  it('rejects duplicate turn-end events and preserves interrupted outcomes', () => {
    const { bridge } = setup();
    bridge.emit({
      type: 'claude:turn-end',
      sessionId: 'session-1',
      payload: { reason: 'interrupted', turnId: 'turn-1' },
    });
    expect(() => bridge.emit({
      type: 'claude:turn-end',
      sessionId: 'session-1',
      payload: { reason: 'interrupted', turnId: 'turn-1' },
    })).toThrow(/more than one turn-end/);
    expect(bridge.finish({ exitCode: null, signal: 'SIGTERM' })).toMatchObject({
      providerTurn: { reason: 'interrupted' },
    });
  });

  it('drops invalid usage fields and lets the engine override timeout semantics', () => {
    const { bridge } = setup();
    bridge.start();
    const outcome = bridge.finish({
      exitCode: null,
      signal: 'SIGTERM',
      usage: {
        inputTokens: -1,
        outputTokens: 3,
        costUsd: Number.POSITIVE_INFINITY,
      },
    }, 'error');

    expect(outcome).toMatchObject({
      usage: { outputTokens: 3 },
      providerTurn: {
        reason: 'error',
        status: {
          inputTokens: 0,
          outputTokens: 3,
          totalCost: 0,
          isStreaming: false,
        },
      },
    });
  });
});
