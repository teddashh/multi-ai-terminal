import type { NodeRun, WorkflowDef } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import {
  displayAuthAlertMessage,
  displayEffort,
  displayEventKind,
  displayGateAction,
  displayIntegrityMessage,
  displayNodeError,
  displayNodeLabel,
  displayNodeStatus,
  displayPermission,
  displayProviderDetail,
  displayRunStatus,
  displaySignInMessage,
  displaySlotLabel,
  displayStageName,
  displaySteerMode,
  displaySteerStatus,
  displayToolPhase,
  displayWorkflowDescription,
  displayWorkflowName,
} from './displayText.js';

const pipeline: WorkflowDef = {
  schemaVersion: 1,
  id: 'pipeline',
  name: 'Pipeline: Implement → Test → Review',
  description: 'Shortest production line: one implementer, one test writer, one reviewer, with verification and gates between handoffs.',
  builtin: true,
  orchestrator: { enabled: true, agent: { provider: 'claude', permission: 'auto' }, gateTimeoutSec: 300 },
  stages: [{
    id: 'implement', name: 'Implement', isolation: 'worktree', join: 'all', timeoutSec: 1800, stallSec: 240, gate: true, requireVerified: true,
    slots: [{ id: 'implementer', label: 'Implementer', agent: { provider: 'claude', permission: 'auto' }, count: 1, promptTemplate: '{{task}}' }],
  }],
  maxParallel: 4,
  maxRetriesPerStage: 2,
};

const node = (overrides: Partial<NodeRun> = {}): NodeRun => ({
  nodeRunId: 'implement.implementer.0', stageId: 'implement', slotId: 'implementer', instanceIndex: 0,
  agent: { provider: 'claude', permission: 'auto' }, label: 'Implementer · claude', status: 'running', attempt: 1, cwd: '/repo',
  ...overrides,
});

describe('localized display text', () => {
  it('localizes built-in workflow chrome without changing its source object', () => {
    expect(displayWorkflowName(pipeline, 'zh-TW')).toBe('流程：實作 → 測試 → 審查');
    expect(displayWorkflowDescription(pipeline, 'zh-TW')).toContain('最精簡的正式流程');
    expect(displayStageName(pipeline, pipeline.stages[0]!, 'zh-TW')).toBe('實作');
    expect(displaySlotLabel(pipeline, 'implementer', 'Implementer', 'zh-TW')).toBe('實作者');
    expect(pipeline).toMatchObject({ name: 'Pipeline: Implement → Test → Review', stages: [{ name: 'Implement', slots: [{ label: 'Implementer' }] }] });
  });

  it('never translates custom workflow, stage, or role names that happen to match a built-in', () => {
    const { builtin, ...custom } = pipeline;
    expect(builtin).toBe(true);
    expect(displayWorkflowName(custom, 'zh-TW')).toBe(custom.name);
    expect(displayWorkflowDescription(custom, 'zh-TW')).toBe(custom.description);
    expect(displayStageName(custom, custom.stages[0]!, 'zh-TW')).toBe('Implement');
    expect(displaySlotLabel(custom, 'implementer', 'Implementer', 'zh-TW')).toBe('Implementer');
    expect(displayNodeLabel(node(), [node()], custom, 'zh-TW')).toBe('Implementer · claude');
  });

  it('recognizes only the exact server-generated copy shape for existing built-in copies', () => {
    const { builtin: _builtin, ...source } = pipeline;
    const generatedCopy: WorkflowDef = { ...source, id: 'pipeline-copy-2', name: 'Pipeline: Implement → Test → Review Copy' };
    expect(displayWorkflowName(generatedCopy, 'zh-TW')).toBe('流程：實作 → 測試 → 審查副本');
    expect(displayStageName(generatedCopy, generatedCopy.stages[0]!, 'zh-TW')).toBe('實作');
    expect(displaySlotLabel(generatedCopy, 'implementer', 'Implementer', 'zh-TW')).toBe('實作者');

    expect(displayWorkflowName({ ...generatedCopy, id: 'my-pipeline' }, 'zh-TW')).toBe(generatedCopy.name);
    expect(displayWorkflowName({ ...generatedCopy, name: 'My Pipeline Copy' }, 'zh-TW')).toBe('My Pipeline Copy');
    expect(displayWorkflowDescription({ ...generatedCopy, description: 'My description' }, 'zh-TW')).toBe('My description');
    expect(displayStageName(generatedCopy, { id: 'implement', name: 'Deploy' }, 'zh-TW')).toBe('Deploy');
    expect(displaySlotLabel(generatedCopy, 'implementer', 'Deployer', 'zh-TW')).toBe('Deployer');
  });

  it('preserves API-authored display text even when a run-scoped override keeps builtin provenance', () => {
    const overridden: WorkflowDef = {
      ...pipeline,
      name: 'My pipeline',
      description: 'My description',
      stages: [{ ...pipeline.stages[0]!, name: 'Deploy', slots: [{ ...pipeline.stages[0]!.slots[0]!, label: 'Deployer' }] }],
    };
    expect(displayWorkflowName(overridden, 'zh-TW')).toBe('My pipeline');
    expect(displayWorkflowDescription(overridden, 'zh-TW')).toBe('My description');
    expect(displayStageName(overridden, overridden.stages[0]!, 'zh-TW')).toBe('Deploy');
    expect(displaySlotLabel(overridden, 'implementer', 'Deployer', 'zh-TW')).toBe('Deployer');
    expect(displayNodeLabel(node(), [node()], overridden, 'zh-TW')).toBe('Deployer · claude');
  });

  it('keeps providers intact while translating built-in and synthetic roles', () => {
    const first = node();
    const second = node({ nodeRunId: 'implement.implementer.1', instanceIndex: 1 });
    expect(displayNodeLabel(first, [first, second], pipeline, 'zh-TW')).toBe('實作者 · claude · #1');
    expect(displayNodeLabel(node({ nodeRunId: 'orchestrator', stageId: null, slotId: 'orchestrator', label: 'Orchestrator · claude' }), [], pipeline, 'zh-TW')).toBe('協調者 · claude');
    expect(displayNodeLabel(first, [first], pipeline, 'en')).toBe('Implementer · claude');
  });

  it('localizes enum metadata while preserving English and stored values', () => {
    expect(displayRunStatus('gating', 'zh-TW')).toBe('審查中');
    expect(displayNodeStatus('thinking', 'zh-TW')).toBe('思考中');
    expect(displayEventKind('tool_result', 'zh-TW')).toBe('工具結果');
    expect(displayEffort('xhigh', 'zh-TW')).toBe('極高');
    expect(displayPermission('safe', 'zh-TW')).toBe('安全');
    expect(displaySteerMode('interrupt', 'zh-TW')).toBe('立即插入');
    expect(displaySteerStatus('reviewed', 'zh-TW')).toBe('已審查');
    expect(displayGateAction('advance', true, 'zh-TW')).toBe('繼續 · 降級處理');
    expect(displayToolPhase('paired', 'zh-TW')).toBe('呼叫與結果');
    expect(displayEventKind('tool_result', 'en')).toBe('tool_result');
  });

  it('translates only the canonical missing-CLI detail and leaves arbitrary errors intact', () => {
    const detail = '`codex` CLI not found on PATH — install it or remove this agent from the workflow.';
    expect(displayProviderDetail('codex', detail, 'zh-TW')).toBe('`codex` CLI 不在 PATH 中。請先安裝它，或從工作流程移除此代理程式。');
    expect(displayProviderDetail('codex', 'upstream said something else', 'zh-TW')).toBe('upstream said something else');
    expect(displayProviderDetail('codex', detail, 'en')).toBe(detail);
  });

  it('translates the canonical probe-timeout and bare-exit details', () => {
    const timeout = 'Version check timed out after 15s. The CLI may be starting slowly; retry detection.';
    expect(displayProviderDetail('codex', timeout, 'zh-TW')).toBe('版本檢查在 15 秒後逾時。CLI 可能啟動較慢；請再重新偵測一次。');
    expect(displayProviderDetail('codex', 'Version check timed out after 7.5s. The CLI may be starting slowly; retry detection.', 'zh-TW')).toBe('版本檢查在 7.5 秒後逾時。CLI 可能啟動較慢；請再重新偵測一次。');
    expect(displayProviderDetail('grok', 'exit 127', 'zh-TW')).toBe('版本檢查以代碼 127 結束，且沒有任何輸出。');
    expect(displayProviderDetail('grok', 'exit null', 'zh-TW')).toBe('版本檢查以代碼 null 結束，且沒有任何輸出。');
    expect(displayProviderDetail('codex', 'exit 1 with extra text', 'zh-TW')).toBe('exit 1 with extra text');
    expect(displayProviderDetail('codex', timeout, 'en')).toBe(timeout);
  });

  it('translates auth-alert sentences line by line and keeps the Fix command verbatim', () => {
    const alert = 'codex sign-in expired.\nFix: codex login';
    expect(displayAuthAlertMessage(alert, 'zh-TW')).toBe('codex 登入已過期。\n修正：codex login');
    expect(displayAuthAlertMessage('claude is not signed in.\nFix: claude /login', 'zh-TW')).toBe('claude 尚未登入。\n修正：claude /login');
    expect(displayAuthAlertMessage(
      "openrouter authentication failed.\nFix: Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.",
      'zh-TW',
    )).toBe('openrouter 驗證失敗。\n修正：請在啟動 MAT 前設定 OPENROUTER_API_KEY 環境變數，然後重新啟動 MAT。');
    expect(displayAuthAlertMessage('arbitrary CLI output', 'zh-TW')).toBe('arbitrary CLI output');
    expect(displayAuthAlertMessage(alert, 'en')).toBe(alert);
  });

  it('translates the canonical refresh-token race guidance and keeps commands verbatim', () => {
    const race = 'codex sign-in expired — parallel codex sessions can race single-use refresh tokens. Sign out and back in with the codex CLI (e.g. `codex logout && codex login`), or switch to API-key auth to avoid the race.';
    expect(displayNodeError(race, 'zh-TW')).toBe('codex 登入已過期——平行執行的 codex 工作階段會互搶單次使用的 refresh token。請登出後重新登入 codex CLI（例如 `codex logout && codex login`），或改用 API 金鑰驗證以避免這個競爭。');
    const bareRace = 'grok sign-in expired — parallel grok sessions can race single-use refresh tokens. Sign out and back in with the grok CLI, or switch to API-key auth to avoid the race.';
    expect(displayNodeError(bareRace, 'zh-TW')).toContain('grok 登入已過期');
    expect(displayNodeError(bareRace, 'zh-TW')).not.toContain('例如');
    expect(displayNodeError('`codex` CLI not found on PATH — install it or remove this agent from the workflow.', 'zh-TW')).toBe('`codex` CLI 不在 PATH 中。請先安裝它，或從工作流程移除此代理程式。');
    expect(displayNodeError('codex sign-in expired.\nFix: codex login', 'zh-TW')).toBe('codex 登入已過期。\n修正：codex login');
    expect(displayNodeError(
      "openrouter authentication failed. Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.",
      'zh-TW',
    )).toBe('openrouter 驗證失敗。請在啟動 MAT 前設定 OPENROUTER_API_KEY 環境變數，然後重新啟動 MAT。');
    expect(displayNodeError('some raw CLI stderr', 'zh-TW')).toBe('some raw CLI stderr');
    expect(displayNodeError(race, 'en')).toBe(race);
  });

  it('translates the canonical evidence-integrity messages', () => {
    const sync = 'Evidence synchronization did not complete. Retry to catch up.';
    expect(displayIntegrityMessage(sync, 'zh-TW')).toBe('證據同步未完成。請重試以補齊。');
    expect(displayIntegrityMessage('Evidence recovery did not complete. Retry to recover missing events.', 'zh-TW')).toBe('證據修復未完成。請重試以復原缺少的事件。');
    expect(displayIntegrityMessage('Could not recover event 42 from persisted evidence.', 'zh-TW')).toBe('無法從持久化證據復原事件 42。');
    expect(displayIntegrityMessage('unexpected message', 'zh-TW')).toBe('unexpected message');
    expect(displayIntegrityMessage(sync, 'en')).toBe(sync);
  });

  it('translates the canonical sign-in strings and keeps CLI status text verbatim', () => {
    expect(displaySignInMessage('Another sign-in is already in progress.', 'zh-TW')).toBe('另一個登入程序正在進行中。');
    expect(displaySignInMessage('In-app sign-in is not available for this provider.', 'zh-TW')).toBe('此服務提供者不支援從 MAT 內登入。');
    expect(displaySignInMessage('The sign-in command did not produce a login URL.', 'zh-TW')).toBe('登入指令沒有輸出登入連結。');
    expect(displaySignInMessage('The sign-in was cancelled.', 'zh-TW')).toBe('已取消登入。');
    expect(displaySignInMessage('The CLI rejected the sign-in.', 'zh-TW')).toBe('CLI 拒絕了這次登入。');
    expect(displaySignInMessage('The sign-in timed out before completing.', 'zh-TW')).toBe('登入在完成前逾時。');
    expect(displaySignInMessage('The CLI still reports it is not signed in.', 'zh-TW')).toBe('CLI 仍回報尚未登入。');
    expect(displaySignInMessage('Signed in.', 'zh-TW')).toBe('已登入。');
    expect(displaySignInMessage('Unknown sign-in session.', 'zh-TW')).toBe('找不到這個登入工作階段。');
    expect(displaySignInMessage('The sign-in ended with exit 7 before completing.', 'zh-TW')).toBe('登入以代碼 7 結束，未能完成。');
    expect(displaySignInMessage('The sign-in ended with exit null before completing.', 'zh-TW')).toBe('登入以代碼 null 結束，未能完成。');
    expect(displaySignInMessage('Logged in using ChatGPT', 'zh-TW')).toBe('Logged in using ChatGPT');
    expect(displaySignInMessage('Signed in.', 'en')).toBe('Signed in.');
  });
});
