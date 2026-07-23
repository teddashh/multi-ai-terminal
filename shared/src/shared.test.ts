import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentEventSchema, ClaudeAccountIndexResponseSchema, CodexAccountIndexSchema, CodexApiKeySetRequestSchema, CodexApiKeyStatusResponseSchema, CodexAccountIdRequestSchema, NodeRunSchema, OpenRouterModelCatalogSchema, OpenRouterModelGroupSchema, OpenRouterModelVersionSchema, ProviderEventSchema, ProviderEventTypeSchema, ProviderIdSchema, ProviderInfoSchema, ProviderSessionMetaSchema, ProviderSignInCancelRequestSchema, ProviderSignInCodeRequestSchema, RunSnapshotSchema, StageSchema, SteerMessageSchema, SteerRequestSchema, WorkflowDefSchema, WorkspacePatchRequestSchema, WorkspaceSchema, applyWorkflowDefaults } from './index.js';

describe('shared schemas', () => {
  it('round-trips an event', () => {
    const event = { id: 'e1', seq: 1, runId: 'r1', stageId: null, nodeRunId: null, attempt: 0, role: 'system', kind: 'status', text: 'ready', ts: 1 };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('round-trips a run snapshot', () => {
    const workflow = preset('planning');
    const run = {
      runId: 'run', workspaceId: 'ws',
      workspaceSnapshot: { name: 'Workspace', path: '/tmp/workspace', isGit: true, verifyCommand: 'npm test', verifyTimeoutSec: 60 },
      workflow, task: 'task', status: 'created', nodes: [], gateDecisions: [], createdAt: 1,
    };
    expect(RunSnapshotSchema.parse(run)).toEqual(run);
  });

  it('keeps workspace provenance additive for legacy run snapshots', () => {
    const legacy = { runId: 'run', workspaceId: 'ws', workflow: preset('planning'), task: 'task', status: 'done', nodes: [], gateDecisions: [], createdAt: 1 };
    expect(RunSnapshotSchema.parse(legacy)).toEqual(legacy);
  });

  it('accepts an additive immutable verification summary on gate decisions', () => {
    const run = {
      runId: 'run', workspaceId: 'ws', workflow: preset('planning'), task: 'task', status: 'done', nodes: [],
      gateDecisions: [{ stageId: 'round-table', gateAttempt: 1, action: 'retry', rationale: 'checks failed', verificationSummary: { passed: 0, failed: 2, skipped: 1 }, ts: 2 }],
      createdAt: 1,
    };
    expect(RunSnapshotSchema.parse(run)).toEqual(run);
  });

  it('applies workflow defaults', () => {
    const value = preset('planning') as Record<string, unknown>;
    delete value.maxParallel;
    delete value.maxRetriesPerStage;
    expect(applyWorkflowDefaults(value)).toMatchObject({ maxParallel: 4, maxRetriesPerStage: 2 });
  });

  it('round-trips evidence-plane fields', () => {
    const node = NodeRunSchema.parse({
      nodeRunId: 's.a.0', stageId: 's', slotId: 'a', instanceIndex: 0,
      agent: { provider: 'mock', permission: 'safe' }, label: 'A', status: 'done', attempt: 1, cwd: '/tmp',
      verification: { status: 'failed', command: 'npm test', exitCode: 1, durationMs: 25, outputTail: 'failed', reason: 'check failed', logFile: '/tmp/check.log' },
      handoff: { priorNodeRunIds: ['prior.a.0'], orchestratorContext: true, retryAddendum: false }, errorReason: 'mock is not signed in.',
    });
    expect(node.verification?.status).toBe('failed');
    expect(node.handoff?.priorNodeRunIds).toEqual(['prior.a.0']);
    expect(node.errorReason).toBe('mock is not signed in.');
    expect(RunSnapshotSchema.parse({ runId: 'r', workspaceId: 'w', workflow: preset('pipeline'), task: 't', status: 'done', nodes: [node], gateDecisions: [], providerVersions: { mock: 'mock/0' }, createdAt: 1, endedAt: 2 }).providerVersions).toEqual({ mock: 'mock/0' });
    expect(WorkspaceSchema.parse({ id: 'w', name: 'W', path: '/tmp', isGit: true, verifyCommand: 'npm test', verifyTimeoutSec: 60 })).toMatchObject({ verifyCommand: 'npm test', verifyTimeoutSec: 60 });
    expect(WorkspaceSchema.parse({ id: 'w', name: 'W', path: '/tmp', isGit: true, lastRun: { runId: 'r', workflowId: 'pipeline', workflowName: 'Pipeline: Implement → Test → Review', workflowBuiltin: true, status: 'done', at: 2 } }).lastRun)
      .toMatchObject({ workflowId: 'pipeline', workflowBuiltin: true });
    expect(WorkspacePatchRequestSchema.parse({ verifyCommand: null, verifyTimeoutSec: null })).toEqual({ verifyCommand: null, verifyTimeoutSec: null });
    expect(StageSchema.parse({ id: 's', name: 'S', slots: [{ id: 'a', label: 'A', agent: { provider: 'mock', permission: 'safe' }, count: 1, promptTemplate: '' }] }).requireVerified).toBe(false);
  });

  it('keeps provider auth additions optional and strict', () => {
    const provider = { id: 'codex', tier: 'rich', ok: true, installable: true, models: ['gpt'], defaultModel: 'gpt', authAlert: { message: 'sign in', at: 1, runId: 'run' }, signInCommand: 'codex login' };
    expect(ProviderInfoSchema.parse(provider)).toEqual(provider);
    expect(ProviderInfoSchema.safeParse({ ...provider, extra: true }).success).toBe(false);
    const { authAlert: _alert, signInCommand: _command, ...legacy } = provider;
    expect(ProviderInfoSchema.parse(legacy)).toEqual(legacy);
  });

  it('keeps in-app sign-in and update additions optional and strict', () => {
    const base = { id: 'codex', tier: 'rich', ok: true, installable: true, models: ['gpt'], defaultModel: 'gpt' };
    const withSignIn = { ...base, signIn: { mode: 'device', replacesExistingLogin: true }, updatable: true };
    expect(ProviderInfoSchema.parse(withSignIn)).toEqual(withSignIn);
    expect(ProviderInfoSchema.parse({ ...base, signIn: { mode: 'paste-code' } }).signIn).toEqual({ mode: 'paste-code' });
    expect(ProviderInfoSchema.parse(base)).toEqual(base);
    expect(ProviderInfoSchema.safeParse({ ...base, signIn: { mode: 'telepathy' } }).success).toBe(false);
    expect(ProviderInfoSchema.safeParse({ ...base, signIn: { mode: 'device', extra: true } }).success).toBe(false);

    expect(ProviderSignInCodeRequestSchema.parse({ loginId: 'L1', code: 'AUTH-1234' })).toEqual({ loginId: 'L1', code: 'AUTH-1234' });
    expect(ProviderSignInCodeRequestSchema.safeParse({ loginId: 'L1', code: '' }).success).toBe(false);
    expect(ProviderSignInCodeRequestSchema.safeParse({ loginId: 'L1', code: 'x'.repeat(513) }).success).toBe(false);
    expect(ProviderSignInCodeRequestSchema.safeParse({ loginId: 'L1', code: 'x', shell: 'rm' }).success).toBe(false);
    expect(ProviderSignInCancelRequestSchema.parse({ loginId: 'L1' })).toEqual({ loginId: 'L1' });
    expect(ProviderSignInCancelRequestSchema.safeParse({}).success).toBe(false);
    expect(ClaudeAccountIndexResponseSchema.parse({
      accounts: [{ id: 'account-1', email: 'one@example.test', isDefault: true }],
      activeAccountId: 'account-1',
    })).toEqual({
      accounts: [{ id: 'account-1', email: 'one@example.test', isDefault: true }],
      activeAccountId: 'account-1',
    });
    expect(CodexAccountIndexSchema.parse({
      schemaVersion: 1, migrated: false, activeAccountId: 'acct',
      accounts: [{ id: 'acct', label: 'Account', createdAt: '2026-01-01T00:00:00.000Z', needsLogin: false }],
    }).activeAccountId).toBe('acct');
    expect(CodexAccountIdRequestSchema.safeParse({ accountId: 'acct', extra: true }).success).toBe(false);
    expect(CodexAccountIdRequestSchema.safeParse({ accountId: '../escape' }).success).toBe(false);
    expect(CodexAccountIdRequestSchema.safeParse({ accountId: 'a/b' }).success).toBe(false);
    expect(CodexApiKeySetRequestSchema.safeParse({ key: '   ' }).success).toBe(false);
    expect(CodexApiKeySetRequestSchema.parse({ key: ' padded-key ' })).toEqual({ key: 'padded-key' });
    expect(CodexApiKeyStatusResponseSchema.parse({ configured: true, source: 'file' })).toEqual({ configured: true, source: 'file' });
  });

  it('accepts OpenRouter before mock and keeps runtime metadata additive and strict', () => {
    expect(ProviderIdSchema.options).toEqual(['claude', 'codex', 'grok', 'agy', 'openrouter', 'mock']);
    expect(ProviderIdSchema.parse('openrouter')).toBe('openrouter');

    const legacy = { id: 'openrouter', tier: 'rich', ok: true, installable: false, models: ['openai/gpt-test'], defaultModel: 'openai/gpt-test' };
    expect(ProviderInfoSchema.parse(legacy)).toEqual(legacy);

    const provider = {
      ...legacy,
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: false },
    };
    expect(ProviderInfoSchema.parse(provider)).toEqual(provider);
    expect(ProviderInfoSchema.safeParse({ ...provider, runtimeFamily: 'openrouter' }).success).toBe(false);
    expect(ProviderInfoSchema.safeParse({
      ...provider,
      environmentCredential: { ...provider.environmentCredential, value: 'must-not-cross-the-contract' },
    }).success).toBe(false);
  });

  it('strictly validates OpenRouter model-family catalogs', () => {
    const latest = {
      id: '~openai/gpt-latest',
      label: 'Latest',
      kind: 'latest',
      supportsTools: true,
    } as const;
    const pinned = {
      id: 'openai/gpt-5.2-20251211',
      label: 'GPT-5.2 (2025-12-11)',
      kind: 'pinned',
      supportsTools: true,
      created: 1_765_411_200,
    } as const;
    const group = {
      id: 'openai/gpt',
      label: 'OpenAI GPT',
      versions: [latest, pinned],
      defaultVersion: latest.id,
    };
    const catalog = { groups: [group], source: 'live' } as const;

    expect(OpenRouterModelVersionSchema.parse(latest)).toEqual(latest);
    expect(OpenRouterModelGroupSchema.parse(group)).toEqual(group);
    expect(OpenRouterModelCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(OpenRouterModelVersionSchema.safeParse({ ...latest, runtimeSlug: 'changed' }).success).toBe(false);
    expect(OpenRouterModelGroupSchema.safeParse({ ...group, defaultVersion: 'missing' }).success).toBe(false);
    expect(OpenRouterModelGroupSchema.safeParse({ ...group, versions: [] }).success).toBe(false);
    expect(OpenRouterModelCatalogSchema.safeParse({ ...catalog, source: 'cache' }).success).toBe(false);
    expect(OpenRouterModelCatalogSchema.safeParse({ ...catalog, extra: true }).success).toBe(false);
  });

  it('accepts the exact BAT provider-event surface with a nonempty session id', () => {
    const meta = providerSessionMeta();
    const events: Array<Record<string, unknown>> = [
      {
        type: 'claude:message', sessionId: 'session-1',
        message: { id: 'message-1', sessionId: 'session-1', role: 'assistant', content: 'Done', thinking: 'Checked', parentToolUseId: null, timestamp: 1 },
      },
      {
        type: 'claude:tool-use', sessionId: 'session-1',
        toolCall: { id: 'tool-1', sessionId: 'session-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running', parentToolUseId: null, timestamp: 2 },
      },
      {
        type: 'claude:tool-result', sessionId: 'session-1',
        result: { id: 'tool-1', status: 'completed', result: { output: 'ok' } },
      },
      { type: 'claude:stream', sessionId: 'session-1', data: { text: 'partial', parentToolUseId: null } },
      { type: 'claude:status', sessionId: 'session-1', meta },
      {
        type: 'claude:result', sessionId: 'session-1',
        result: { subtype: 'success', usage: { input_tokens: 2 }, providerField: ['preserved'] },
      },
      {
        type: 'claude:turn-end', sessionId: 'session-1',
        payload: { reason: 'completed', result: 'Done', sdkSessionId: 'sdk-1', turnId: 'turn-1', usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 } },
      },
      { type: 'claude:error', sessionId: 'session-1', error: 'provider failed' },
      {
        type: 'claude:rate-limit', sessionId: 'session-1',
        info: { rateLimitType: 'five_hour', resetsAt: 10, utilization: 0.5, isUsingOverage: false },
      },
      {
        type: 'claude:task', sessionId: 'session-1',
        task: {
          id: 'task-1', toolUseId: 'tool-1', type: 'workflow', status: 'running',
          isWorkflow: true, workflowName: 'Review', subagentType: null, description: 'Review changes', startedAt: 3,
        },
      },
      {
        type: 'claude:permission-request', sessionId: 'session-1',
        data: { toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [{ type: 'allow' }], decisionReason: 'Run checks' },
      },
      { type: 'claude:permission-resolved', sessionId: 'session-1', toolUseId: 'tool-1' },
      {
        type: 'claude:ask-user', sessionId: 'session-1',
        data: { toolUseId: 'ask-1', questions: [{ question: 'Continue?', header: 'Choice' }] },
      },
      { type: 'claude:ask-user-resolved', sessionId: 'session-1', toolUseId: 'ask-1' },
      { type: 'claude:modeChange', sessionId: 'session-1', mode: 'acceptEdits' },
      {
        type: 'claude:history', sessionId: 'session-1',
        items: [
          { id: 'history-1', sessionId: 'session-1', role: 'user', content: 'Prior prompt', timestamp: 0 },
          { id: 'history-tool-1', sessionId: 'session-1', toolName: 'Read', input: { file: 'a.ts' }, status: 'completed', result: 'ok', timestamp: 1 },
        ],
      },
      { type: 'claude:resume-loading', sessionId: 'session-1', loading: true },
      { type: 'claude:session-reset', sessionId: 'session-1' },
      {
        type: 'claude:worktree-info', sessionId: 'session-1',
        payload: { branchName: 'bat/worktree-1', worktreePath: '/repo/wt', sourceBranch: 'main', gitRoot: '/repo' },
      },
    ];

    expect(events.map((event) => event.type)).toEqual(ProviderEventTypeSchema.options);
    for (const event of events) {
      expect(ProviderEventSchema.parse(event)).toEqual(event);
      const { sessionId: _sessionId, ...withoutSession } = event;
      expect(ProviderEventSchema.safeParse(withoutSession).success).toBe(false);
      expect(ProviderEventSchema.safeParse({ ...event, sessionId: '' }).success).toBe(false);
    }
    const batMessage = events[0] as {
      type: 'claude:message';
      sessionId: string;
      message: Record<string, unknown>;
    };
    const { sessionId: _messageSessionId, ...messageWithoutSession } = batMessage.message;
    expect(ProviderEventSchema.safeParse({
      ...batMessage,
      message: messageWithoutSession,
    }).success).toBe(false);

    const batToolUse = events[1] as {
      type: 'claude:tool-use';
      sessionId: string;
      toolCall: Record<string, unknown>;
    };
    const { sessionId: _toolSessionId, ...toolWithoutSession } = batToolUse.toolCall;
    expect(ProviderEventSchema.safeParse({
      ...batToolUse,
      toolCall: toolWithoutSession,
    }).success).toBe(false);

    const batHistory = events[15] as {
      type: 'claude:history';
      sessionId: string;
      items: Array<Record<string, unknown>>;
    };
    const historyWithoutNestedSessions = batHistory.items.map(
      ({ sessionId: _historySessionId, ...item }) => item,
    );
    expect(ProviderEventSchema.safeParse({
      ...batHistory,
      items: historyWithoutNestedSessions,
    }).success).toBe(false);
    expect(ProviderEventSchema.parse({ type: 'claude:worktree-info', sessionId: 'session-1', payload: null }).payload).toBeNull();
  });

  it('requires full strict provider status snapshots and bounded terminal metadata', () => {
    const meta = providerSessionMeta();
    expect(ProviderSessionMetaSchema.parse(meta)).toEqual(meta);
    const { runtimeMessage: _runtimeMessage, ...partial } = meta;
    expect(ProviderSessionMetaSchema.safeParse(partial).success).toBe(false);
    expect(ProviderSessionMetaSchema.safeParse({ ...meta, extra: true }).success).toBe(false);
    expect(ProviderSessionMetaSchema.safeParse({ ...meta, inputTokens: -1 }).success).toBe(false);
    expect(ProviderSessionMetaSchema.safeParse({ ...meta, totalCost: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(ProviderSessionMetaSchema.safeParse({ ...meta, numTurns: 1.5 }).success).toBe(false);

    expect(ProviderEventSchema.safeParse({
      type: 'claude:status', sessionId: 'session-1', meta: { model: null },
    }).success).toBe(false);
    expect(ProviderEventSchema.safeParse({
      type: 'claude:message', sessionId: 'session-1',
      message: { id: 'message-1', sessionId: 'session-1', role: 'assistant', content: 'Done', timestamp: 1, extra: true },
    }).success).toBe(false);
    expect(ProviderEventSchema.safeParse({
      type: 'claude:turn-end', sessionId: 'session-1', payload: { reason: 'paused' },
    }).success).toBe(false);
    expect(ProviderEventSchema.safeParse({
      type: 'claude:turn-end', sessionId: 'session-1',
      payload: { reason: 'error', error: 'failed', usage: { inputTokens: -1 } },
    }).success).toBe(false);
    expect(ProviderEventSchema.safeParse({
      type: 'claude:stream', sessionId: 'session-1', data: {},
    }).success).toBe(false);
  });

  it('enforces the per-stage fan-out cap', () => {
    const value = preset('planning');
    value.stages[0]!.slots[0]!.count = 8;
    value.stages[0]!.slots[1]!.count = 8;
    expect(WorkflowDefSchema.safeParse(value).success).toBe(false);
  });

  it('validates steer messages and defaults steer requests to interrupt', () => {
    const steer = { steerId: 's_1', text: 'change direction', mode: 'interrupt', status: 'pending', createdAt: 1 };
    expect(SteerMessageSchema.parse(steer)).toEqual(steer);
    expect(SteerRequestSchema.parse({ text: 'change direction' })).toEqual({ text: 'change direction', mode: 'interrupt' });
    expect(SteerRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(SteerRequestSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(SteerMessageSchema.safeParse({ ...steer, extra: true }).success).toBe(false);
  });

  it.each([
    ['workflow id', (value: any) => { value.id = '../escape'; }],
    ['stage id', (value: any) => { value.stages[0].id = '../../escape'; }],
    ['slot id', (value: any) => { value.stages[0].slots[0].id = 'a/b'; }],
  ])('rejects traversal in %s', (_label, mutate) => {
    const value = preset('planning');
    mutate(value);
    expect(WorkflowDefSchema.safeParse(value).success).toBe(false);
  });
});

function providerSessionMeta() {
  return {
    permissionMode: 'default',
    model: null,
    effort: null,
    ultracode: false,
    autoCompactWindow: null,
    sdkSessionId: null,
    cwd: null,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    numTurns: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    contextTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    callCacheRead: 0,
    callCacheWrite: 0,
    lastQueryCalls: 0,
    isStreaming: false,
    runtimeStatus: null,
    runtimeMessage: null,
    runtimeStatusStartedAt: null,
  };
}

describe('builtin presets', () => {
  for (const name of ['planning', 'build', 'review', 'pipeline']) {
    it(`${name} parses as WorkflowDef`, () => expect(WorkflowDefSchema.parse(preset(name))).toBeTruthy());
  }
});

function preset(name: string): any {
  const path = fileURLToPath(new URL(`./presets/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}
