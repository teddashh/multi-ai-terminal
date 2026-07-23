import type { ProviderInfo, RunSnapshot, Workspace } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { findingsByScope, healthFindings, healthIssueCount, providerFinding, type HealthInput } from './healthLogic.js';

const workspace: Workspace = { id: 'w1', name: 'Example', path: 'test-workspace', isGit: false };
const provider = (value: Partial<ProviderInfo> & Pick<ProviderInfo, 'id'>): ProviderInfo => ({
  tier: 'rich', ok: true, installable: true, models: [], defaultModel: '', ...value,
});
const run: RunSnapshot = {
  runId: 'r1', workspaceId: 'w1', task: 'Inspect evidence', status: 'failed', createdAt: 1,
  workspaceSnapshot: { name: 'Historical workspace', path: 'test-workspace', isGit: false },
  workflow: {
    schemaVersion: 1, id: 'wf', name: 'Review', description: '', maxParallel: 2, maxRetriesPerStage: 1,
    orchestrator: { enabled: true, agent: { provider: 'codex', permission: 'safe' }, gateTimeoutSec: 30 },
    stages: [{ id: 'review', name: 'Review stage', slots: [], isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: true }],
  },
  nodes: [
    { nodeRunId: 'review.a.0', stageId: 'review', slotId: 'a', instanceIndex: 0, agent: { provider: 'codex', permission: 'safe' }, label: 'Reviewer · codex', status: 'failed', attempt: 1, cwd: 'test-workspace', verification: { status: 'failed', command: 'npm test', exitCode: 1 } },
    { nodeRunId: 'review.b.0', stageId: 'review', slotId: 'b', instanceIndex: 0, agent: { provider: 'claude', permission: 'safe' }, label: 'Reviewer · claude', status: 'stalled', attempt: 1, cwd: 'test-workspace' },
  ],
  gateDecisions: [{ stageId: 'review', gateAttempt: 1, action: 'advance', rationale: 'Fallback', degraded: true, ts: 2 }],
};

const healthyInput = (overrides: Partial<HealthInput> = {}): HealthInput => ({
  server: { status: 'ok', version: '0.1.9' }, wsConnection: 'open',
  providers: [provider({ id: 'codex', version: 'codex 1.0' }), provider({ id: 'mock', ok: false })],
  workspace, ...overrides,
});

describe('health logic', () => {
  it('describes provider discovery honestly without claiming authentication', () => {
    const detected = providerFinding(provider({ id: 'codex', version: 'codex 1.0' }));
    expect(detected.title).toBe('codex: latest CLI check detected it');
    expect(detected.detail).toContain('do not confirm');
    expect(detected.detail).toContain('cached for up to 10 minutes');
    expect(`${detected.title} ${detected.detail}`.toLowerCase()).not.toContain('is signed in');
    expect(detected.issue).toBe(false);

    const observedFailure = providerFinding(provider({
      id: 'claude', authAlert: { message: 'Claude sign-in expired.\nFix: claude, then /login', at: 10, runId: 'r1' },
    }));
    expect(observedFailure.title).toBe('claude: recorded sign-in failure');
    expect(observedFailure.detail).toContain('1970-01-01T00:00:00.010Z');
    expect(observedFailure.detail).toContain('not a live authentication probe');
    expect(observedFailure.issue).toBe(true);
  });

  it('reports the OpenRouter environment key without inventing a separate CLI or sign-in state', () => {
    const missing = providerFinding(provider({
      id: 'openrouter',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: false },
    }));
    expect(missing).toMatchObject({
      title: 'openrouter: OPENROUTER_API_KEY is not configured',
      severity: 'warning',
      issue: true,
    });
    expect(missing.detail).toContain('codex runtime detected');
    expect(missing.detail).toContain('OPENROUTER_API_KEY: configured=false');
    expect(missing.detail).toContain('API reports presence only and never exposes the credential value');
    expect(`${missing.title} ${missing.detail}`).not.toMatch(/openrouter CLI|sign[- ]?in/i);

    const configured = providerFinding(provider({
      id: 'openrouter',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: true },
    }));
    expect(configured).toMatchObject({
      title: 'openrouter: codex runtime detected',
      severity: 'ok',
      issue: false,
    });
    expect(configured.detail).toContain('OPENROUTER_API_KEY: configured=true');

    const localizedMissing = providerFinding(provider({
      id: 'openrouter',
      runtimeFamily: 'codex',
      environmentCredential: { name: 'OPENROUTER_API_KEY', configured: false },
      authAlert: {
        message: "openrouter authentication failed.\nFix: Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.",
        at: 10,
        runId: 'run-openrouter',
      },
    }), 'zh-TW');
    expect(localizedMissing.title).toBe('openrouter：尚未設定 OPENROUTER_API_KEY');
    expect(localizedMissing.detail).toContain('openrouter 驗證失敗。');
    expect(localizedMissing.detail).not.toContain('authentication failed');
  });

  it('keeps an optional unavailable provider out of the issue count and does not hide recorded auth evidence', () => {
    const unavailable = providerFinding(provider({ id: 'grok', ok: false, detail: 'binary missing' }));
    expect(unavailable).toMatchObject({
      title: 'grok: latest CLI check did not detect it', severity: 'warning', issue: false,
    });
    expect(unavailable.detail).toContain('only cached briefly');
    expect(unavailable.detail).toContain('retry detection');

    const unavailableAfterAuth = providerFinding(provider({
      id: 'grok', ok: false, detail: 'binary missing',
      authAlert: { message: 'grok sign-in expired', at: 20, runId: 'run-auth' },
    }));
    expect(unavailableAfterAuth).toMatchObject({
      title: 'grok: latest CLI check did not detect it', issue: true,
    });
    expect(unavailableAfterAuth.detail).toContain('sign-in failure was recorded');
    expect(unavailableAfterAuth.detail).toContain('run-auth');
  });

  it('always treats mock as a deterministic non-issue', () => {
    expect(providerFinding(provider({
      id: 'mock', ok: false, authAlert: { message: 'ignored', at: 1, runId: 'r1' },
    }))).toMatchObject({ severity: 'ok', issue: false, title: 'mock: deterministic test provider' });
  });

  it('keeps non-Git and missing verification setup as notes, not failures', () => {
    const findings = findingsByScope(healthFindings(healthyInput()), 'workspace');
    expect(findings.map((finding) => finding.title)).toEqual(['Not a Git workspace', 'No verification command configured']);
    expect(findings.every((finding) => finding.issue === false && finding.severity === 'info')).toBe(true);
    expect(findings.map((finding) => finding.detail).join(' ')).not.toContain('are available');

    const configured = findingsByScope(healthFindings(healthyInput({
      workspace: { ...workspace, isGit: true, verifyCommand: 'npm test' },
    })), 'workspace');
    expect(configured.map((finding) => finding.title)).toEqual(['Git workspace recorded', 'Verification command configured']);
    expect(configured[0]?.detail).toContain('eligible');
    expect(configured[1]?.detail).toContain('only for a successful worktree-isolated candidate with a non-empty patch');
    expect(configured[1]?.detail).not.toContain('will run');
  });

  it('surfaces run, node, verification, degraded-gate, and evidence continuity problems', () => {
    const findings = findingsByScope(healthFindings(healthyInput({
      run,
      evidenceIntegrity: { status: 'incomplete', expectedSeq: 4, receivedSeq: 6, message: 'Backfill unavailable.' },
    })), 'run');
    expect(findings.map((finding) => finding.title)).toEqual(expect.arrayContaining([
      'Viewed run: failed',
      'Evidence continuity is incomplete',
      'Reviewer · codex: failed',
      'Reviewer · codex: verification failed',
      'Reviewer · claude: stalled',
      'Review stage: degraded gate decision',
    ]));
    expect(findings.find((finding) => finding.id === 'evidence-integrity')?.detail).toContain('Expected event 4 before event 6');
    expect(findings.filter((finding) => finding.nodeRunId).map((finding) => finding.nodeRunId)).toEqual(expect.arrayContaining(['review.a.0', 'review.b.0']));
  });

  it('counts actionable problems while excluding checking, setup notes, and mock', () => {
    expect(healthIssueCount(healthyInput())).toBe(0);
    expect(healthIssueCount(healthyInput({
      server: { status: 'error', message: 'offline' }, wsConnection: 'closed', run,
      providers: [provider({ id: 'codex', ok: false }), provider({ id: 'mock', ok: false })],
      evidenceIntegrity: { status: 'recovering', expectedSeq: 2, receivedSeq: 3 },
      providerRefreshError: 'probe timed out',
    }))).toBe(8);
  });

  it('renders diagnostic guidance in Traditional Chinese without changing issue semantics', () => {
    const findings = healthFindings(healthyInput({ locale: 'zh-TW', run }));
    expect(findings.find((finding) => finding.id === 'server')?.title).toBe('本機伺服器可連線');
    expect(findings.find((finding) => finding.id === 'server')?.detail).toBe('MAT 本機伺服器 0.1.9');
    expect(findings.find((finding) => finding.id === 'provider-codex')?.title).toBe('codex：最新 CLI 檢查已偵測到');
    expect(findings.find((finding) => finding.id === 'run-status')?.title).toBe('目前執行：失敗');
    expect(findings.filter((finding) => finding.issue)).toHaveLength(5);
  });

  it('uses natural Traditional Chinese for health concepts and canonical CLI guidance', () => {
    const unavailable = providerFinding(provider({
      id: 'codex', ok: false,
      detail: '`codex` CLI not found on PATH — install it or remove this agent from the workflow.',
    }), 'zh-TW');
    expect(unavailable.detail).toContain('`codex` CLI 不在 PATH 中');
    expect(unavailable.detail).toContain('從工作流程移除此代理程式');
    expect(unavailable.detail).toContain('略過所有服務提供者的偵測快取');

    const gitWorkspace = findingsByScope(healthFindings(healthyInput({
      locale: 'zh-TW',
      workspace: { ...workspace, isGit: true, verifyCommand: 'npm test' },
    })), 'workspace');
    const workspaceCopy = gitWorkspace.map((finding) => `${finding.title} ${finding.detail}`).join(' ');
    expect(workspaceCopy).toContain('Git 工作樹隔離');
    expect(workspaceCopy).toContain('Git 儲存庫');
    expect(workspaceCopy).toContain('候選節點');
    expect(workspaceCopy).toContain('修補內容');
    expect(workspaceCopy).not.toMatch(/\b(?:worktree|repository|candidate|patch)\b/i);

    const builtinRun: RunSnapshot = {
      ...run,
      workflow: {
        ...run.workflow,
        id: 'pipeline',
        name: 'Pipeline: Implement → Test → Review',
        description: 'Shortest production line: one implementer, one test writer, one reviewer, with verification and gates between handoffs.',
        builtin: true,
        stages: [{
          ...run.workflow.stages[0]!, id: 'review', name: 'Review',
          slots: [{
            id: 'reviewer', label: 'Reviewer', count: 2,
            agent: { provider: 'codex', permission: 'safe' }, promptTemplate: '{{task}}',
          }],
        }],
      },
      nodes: run.nodes.map((node) => ({ ...node, slotId: 'reviewer', label: `Reviewer · ${node.agent.provider}` })),
    };
    const runCopy = findingsByScope(healthFindings(healthyInput({ locale: 'zh-TW', run: builtinRun })), 'run')
      .map((finding) => `${finding.title} ${finding.detail}`).join(' ');
    expect(runCopy).toContain('審查者 · codex · #1：驗證失敗');
    expect(runCopy).toContain('審查：關卡決策已降級');
    expect(runCopy).toContain('協調者在較低的決策信心下繼續執行');
    expect(runCopy).not.toMatch(/\b(?:Reviewer|gate|Orchestrator)\b/);
  });
});
