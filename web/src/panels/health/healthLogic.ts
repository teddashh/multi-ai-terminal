import type { ProviderInfo, RunSnapshot, Workspace } from '@mat/shared';
import type { EvidenceIntegrity, WsConnectionState } from '../../app/store.js';
import { displayAuthAlertMessage, displayIntegrityMessage, displayNodeLabel, displayNodeStatus, displayProviderDetail, displayRunStatus, displayStageName } from '../../i18n/displayText.js';

export type HealthSeverity = 'ok' | 'info' | 'working' | 'warning' | 'error';
export type HealthScope = 'system' | 'workspace' | 'provider' | 'run';
type HealthLocale = 'en' | 'zh-TW';

export interface HealthFinding {
  id: string;
  scope: HealthScope;
  severity: HealthSeverity;
  title: string;
  detail: string;
  issue: boolean;
  nodeRunId?: string;
  providerId?: ProviderInfo['id'];
}

export interface ServerHealthState {
  status: 'checking' | 'ok' | 'error';
  version?: string;
  message?: string;
}

export interface HealthInput {
  server: ServerHealthState;
  wsConnection: WsConnectionState;
  providers: readonly ProviderInfo[];
  workspace?: Workspace;
  run?: RunSnapshot;
  evidenceIntegrity?: EvidenceIntegrity;
  providerRefreshError?: string;
  locale?: 'en' | 'zh-TW';
}

export function healthFindings(input: HealthInput): HealthFinding[] {
  return [
    ...serverFindings(input.server, input.wsConnection, input.providerRefreshError, input.locale),
    ...workspaceFindings(input.workspace, input.run, input.locale),
    ...(input.providers.length > 0 ? input.providers.map((provider) => providerFinding(provider, input.locale)) : [{
      id: 'provider-none', scope: 'provider' as const, severity: 'info' as const, issue: false,
      title: copy(input.locale, 'No provider status loaded', '尚未載入服務提供者狀態'),
      detail: copy(input.locale, 'Open Health while the local server is available to load the latest CLI checks.', '請在本機伺服器可用時開啟健康狀態，以載入最新的 CLI 檢查。'),
    }]),
    ...runFindings(input.run, input.evidenceIntegrity, input.locale),
  ];
}

export function healthIssueCount(input: HealthInput): number {
  return healthFindings(input).filter((finding) => finding.issue).length;
}

export function findingsByScope(findings: readonly HealthFinding[], scope: HealthScope): HealthFinding[] {
  return findings.filter((finding) => finding.scope === scope);
}

export function providerFinding(provider: ProviderInfo, locale: HealthLocale = 'en'): HealthFinding {
  if (provider.id === 'mock') {
    return {
      id: 'provider-mock', scope: 'provider', severity: 'ok', issue: false, providerId: provider.id,
      title: copy(locale, 'mock: deterministic test provider', 'mock：固定結果的測試服務'),
      detail: copy(locale, 'Built-in and intentionally exempt from CLI discovery and authentication checks.', '此服務內建於 MAT，刻意不進行 CLI 偵測與登入檢查。'),
    };
  }
  if (!provider.ok) {
    const recordedAuthFailure = provider.authAlert
      ? copy(locale,
        `\nA sign-in failure was recorded at ${formatTimestamp(provider.authAlert.at)} during run ${provider.authAlert.runId}. This is historical evidence, not a live authentication probe.`,
        `\n執行 ${provider.authAlert.runId} 於 ${formatTimestamp(provider.authAlert.at)} 記錄過登入失敗。這是歷史證據，不是即時登入探測。`)
      : '';
    return {
      id: `provider-${provider.id}`, scope: 'provider', severity: 'warning', issue: provider.authAlert !== undefined, providerId: provider.id,
      title: copy(locale, `${provider.id}: latest CLI check did not detect it`, `${provider.id}：最新 CLI 檢查未偵測到`),
      detail: `${provider.detail ? displayProviderDetail(provider.id, provider.detail, locale) : copy(locale, 'MAT could not find this provider executable on its augmented PATH.', 'MAT 在擴充後的 PATH 中找不到此服務提供者的執行檔。')}${recordedAuthFailure}\n${copy(locale, 'Transient failures are only cached briefly; use retry detection to bypass all provider caches.', '暫時性失敗只會短暫快取；可用「重新偵測」略過所有服務提供者的偵測快取。')}`,
    };
  }
  if (provider.authAlert) {
    return {
      id: `provider-${provider.id}`, scope: 'provider', severity: 'warning', issue: true, providerId: provider.id,
      title: copy(locale, `${provider.id}: recorded sign-in failure`, `${provider.id}：曾記錄登入失敗`),
      detail: `${displayAuthAlertMessage(provider.authAlert.message, locale ?? 'en')}\n${copy(locale, `Recorded at ${formatTimestamp(provider.authAlert.at)} during run ${provider.authAlert.runId}. This is historical evidence, not a live authentication probe.`, `執行 ${provider.authAlert.runId} 於 ${formatTimestamp(provider.authAlert.at)} 記錄。這是歷史證據，不是即時登入探測。`)}`,
    };
  }
  return {
    id: `provider-${provider.id}`, scope: 'provider', severity: 'ok', issue: false, providerId: provider.id,
    title: copy(locale, `${provider.id}: latest CLI check detected it`, `${provider.id}：最新 CLI 檢查已偵測到`),
    detail: provider.version
      ? copy(locale, `${provider.version}. Successful version checks may be cached for up to 10 minutes and do not confirm that the provider is currently signed in.`, `${provider.version}。成功的版本檢查最多快取 10 分鐘，且不代表目前仍處於登入狀態。`)
      : copy(locale, 'Successful version checks may be cached for up to 10 minutes and do not confirm that the provider is currently signed in.', '成功的版本檢查最多快取 10 分鐘，且不代表目前仍處於登入狀態。'),
  };
}

function serverFindings(server: ServerHealthState, wsConnection: WsConnectionState, providerRefreshError?: string, locale: HealthLocale = 'en'): HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (server.status === 'checking') {
    findings.push({ id: 'server', scope: 'system', severity: 'working', issue: false, title: copy(locale, 'Checking local server', '正在檢查本機伺服器'), detail: copy(locale, 'Running a read-only health request.', '正在執行唯讀的健康狀態請求。') });
  } else if (server.status === 'error') {
    findings.push({ id: 'server', scope: 'system', severity: 'error', issue: true, title: copy(locale, 'Local server unavailable', '本機伺服器無法使用'), detail: server.message ?? copy(locale, 'The health request failed.', '健康狀態請求失敗。') });
  } else {
    findings.push({ id: 'server', scope: 'system', severity: 'ok', issue: false, title: copy(locale, 'Local server reachable', '本機伺服器可連線'), detail: server.version ? copy(locale, `MAT server ${server.version}`, `MAT 本機伺服器 ${server.version}`) : copy(locale, 'The health request succeeded.', '健康狀態請求成功。') });
  }

  if (wsConnection === 'open') {
    findings.push({ id: 'websocket', scope: 'system', severity: 'ok', issue: false, title: copy(locale, 'Live updates connected', '即時更新已連線'), detail: copy(locale, 'Run and evidence updates can arrive in real time.', '執行與證據更新可即時送達。') });
  } else if (wsConnection === 'connecting') {
    findings.push({ id: 'websocket', scope: 'system', severity: 'working', issue: false, title: copy(locale, 'Connecting live updates', '正在連接即時更新'), detail: copy(locale, 'The app is reconnecting to the local server.', '應用程式正在重新連接本機伺服器。') });
  } else {
    findings.push({ id: 'websocket', scope: 'system', severity: 'warning', issue: true, title: copy(locale, 'Live updates disconnected', '即時更新已中斷'), detail: copy(locale, 'Existing evidence remains readable, but new events may be delayed.', '既有證據仍可閱讀，但新事件可能延遲。') });
  }

  if (providerRefreshError) {
    findings.push({ id: 'provider-refresh', scope: 'system', severity: 'warning', issue: true, title: copy(locale, 'Provider check could not refresh', '無法重新整理服務提供者檢查'), detail: providerRefreshError });
  }
  return findings;
}

function workspaceFindings(workspace: Workspace | undefined, run: RunSnapshot | undefined, locale: HealthLocale = 'en'): HealthFinding[] {
  if (!workspace && !run?.workspaceSnapshot) {
    return [{ id: 'workspace-none', scope: 'workspace', severity: 'info', issue: false, title: copy(locale, 'No workspace selected', '尚未選擇工作區'), detail: copy(locale, 'Select a project to inspect its Git and verification setup.', '請選擇專案，以檢查 Git 與驗證設定。') }];
  }

  const provenance = run?.workspaceSnapshot;
  const name = provenance?.name ?? workspace?.name ?? copy(locale, 'Workspace', '工作區');
  const isGit = provenance?.isGit ?? workspace?.isGit ?? false;
  const verifyCommand = provenance?.verifyCommand ?? workspace?.verifyCommand;
  const source = provenance ? copy(locale, 'Viewed run snapshot', '目前執行的快照') : copy(locale, 'Selected workspace', '所選工作區');
  return [
    {
      id: 'workspace-git', scope: 'workspace', severity: isGit ? 'ok' : 'info', issue: false,
      title: isGit ? copy(locale, 'Git workspace recorded', '已記錄 Git 工作區') : copy(locale, 'Not a Git workspace', '不是 Git 工作區'),
      detail: `${source}: ${name}. ${isGit
        ? copy(locale, 'This makes worktree isolation eligible; MAT checks the repository again when a stage runs, and patch evidence exists only when a candidate creates it.', '可使用 Git 工作樹隔離；MAT 會在階段執行時再次檢查 Git 儲存庫，且只有候選節點真的產生修補內容時，才會建立對應的修補證據。')
        : copy(locale, 'This is supported; worktree stages fall back to the workspace and do not produce worktree patch evidence.', '此狀態受支援；採 Git 工作樹隔離的階段會改用原工作區，且不會產生工作樹修補證據。')}`,
    },
    {
      id: 'workspace-verify', scope: 'workspace', severity: verifyCommand ? 'ok' : 'info', issue: false,
      title: verifyCommand ? copy(locale, 'Verification command configured', '已設定驗證指令') : copy(locale, 'No verification command configured', '尚未設定驗證指令'),
      detail: verifyCommand
        ? `${source}${copy(locale, ' has a verification command. MAT runs it only for a successful worktree-isolated candidate with a non-empty patch.', '已設定驗證指令。MAT 只會對成功、採 Git 工作樹隔離且修補內容非空的候選節點執行。')}`
        : copy(locale, 'This is a setup note, not a failure. MAT will not attempt command-based verification.', '這是設定提醒，不是失敗。MAT 不會嘗試以指令驗證。'),
    },
  ];
}

function runFindings(run: RunSnapshot | undefined, integrity: EvidenceIntegrity | undefined, locale: HealthLocale = 'en'): HealthFinding[] {
  if (!run) {
    return [{ id: 'run-none', scope: 'run', severity: 'info', issue: false, title: copy(locale, 'No viewed run', '尚未檢視任何執行'), detail: copy(locale, 'Start or select a run to inspect node and evidence health.', '請啟動或選擇執行，以檢查節點與證據狀態。') }];
  }

  const runSeverity: HealthSeverity = run.status === 'failed'
    ? 'error'
    : ['running', 'gating', 'created'].includes(run.status)
      ? 'working'
      : run.status === 'aborted' ? 'info' : 'ok';
  const findings: HealthFinding[] = [{
    id: 'run-status', scope: 'run',
    severity: runSeverity,
    issue: run.status === 'failed',
    title: copy(locale, `Viewed run: ${run.status}`, `目前執行：${displayRunStatus(run.status, locale)}`),
    detail: run.status === 'failed' ? copy(locale, 'The run ended unsuccessfully. Inspect the affected nodes below.', '此次執行以失敗結束。請查看下方受影響的節點。') : copy(locale, `Evidence source: ${run.runId}.`, `證據來源：${run.runId}。`),
  }];

  if (integrity?.status === 'recovering') {
    findings.push({
      id: 'evidence-integrity', scope: 'run', severity: 'working', issue: false,
      title: copy(locale, 'Recovering an evidence gap', '正在修復證據缺口'),
      detail: sequenceDetail(integrity, copy(locale, 'MAT is backfilling missing persisted events before treating the live view as complete.', 'MAT 正在補回缺少的持久化事件；完成前不會把即時畫面視為完整。'), locale),
    });
  } else if (integrity?.status === 'incomplete') {
    findings.push({
      id: 'evidence-integrity', scope: 'run', severity: 'error', issue: true,
      title: copy(locale, 'Evidence continuity is incomplete', '證據連續性不完整'),
      detail: sequenceDetail(integrity, integrity.message ? displayIntegrityMessage(integrity.message, locale ?? 'en') : copy(locale, 'One or more persisted events could not be recovered.', '有一個或多個持久化事件無法復原。'), locale),
    });
  } else if (integrity?.status === 'live') {
    findings.push({ id: 'evidence-integrity', scope: 'run', severity: 'ok', issue: false, title: copy(locale, 'Evidence continuity intact', '證據連續性完整'), detail: copy(locale, 'No live sequence gap is currently known.', '目前沒有已知的即時序列缺口。') });
  }

  for (const node of run.nodes) {
    const label = displayNodeLabel(node, run.nodes, run.workflow, locale);
    if (node.status === 'failed' || node.status === 'stalled') {
      findings.push({
        id: `node-${node.nodeRunId}`, scope: 'run', severity: node.status === 'failed' ? 'error' : 'warning', issue: true,
        title: copy(locale, `${label}: ${displayNodeStatus(node.status, locale)}`, `${label}：${displayNodeStatus(node.status, locale)}`),
        detail: node.status === 'failed'
          ? copy(locale, 'The node ended unsuccessfully. Inspect its evidence and failure guidance.', '此節點以失敗結束。請查看其證據與失敗處理建議。')
          : copy(locale, 'The node has stopped producing progress. Inspect its latest evidence.', '此節點已停止產生進度。請查看最新證據。'),
        nodeRunId: node.nodeRunId,
      });
    }
    if (node.verification?.status === 'failed' || node.verification?.status === 'error') {
      findings.push({
        id: `verification-${node.nodeRunId}`, scope: 'run', severity: 'error', issue: true,
        title: copy(locale, `${label}: verification ${node.verification.status}`, `${label}：驗證${node.verification.status === 'failed' ? '失敗' : '錯誤'}`),
        detail: copy(locale, 'The configured verification contract did not pass. Inspect the node evidence for the recorded result.', '設定的驗證契約未通過。請查看節點證據中的記錄結果。'),
        nodeRunId: node.nodeRunId,
      });
    }
  }

  for (const decision of run.gateDecisions.filter((candidate) => candidate.degraded)) {
    const stage = run.workflow.stages.find((candidate) => candidate.id === decision.stageId);
    const stageName = stage ? displayStageName(run.workflow, stage, locale) : decision.stageId;
    findings.push({
      id: `gate-${decision.stageId}-${decision.gateAttempt}`, scope: 'run', severity: 'warning', issue: true,
      title: copy(locale, `${stageName}: degraded gate decision`, `${stageName}：關卡決策已降級`),
      detail: copy(locale, 'The orchestrator continued with reduced decision confidence. Review the gate rationale in the run evidence.', '協調者在較低的決策信心下繼續執行。請查看執行證據中的關卡判斷理由。'),
    });
  }
  return findings;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `timestamp ${String(value)}` : date.toISOString();
}

function sequenceDetail(integrity: EvidenceIntegrity, fallback: string, locale: HealthLocale = 'en'): string {
  if (integrity.expectedSeq === undefined) return fallback;
  const range = integrity.receivedSeq === undefined
    ? copy(locale, `Expected event ${String(integrity.expectedSeq)}.`, `預期收到事件 ${String(integrity.expectedSeq)}。`)
    : copy(locale, `Expected event ${String(integrity.expectedSeq)} before event ${String(integrity.receivedSeq)}.`, `在事件 ${String(integrity.receivedSeq)} 前，預期先收到事件 ${String(integrity.expectedSeq)}。`);
  return `${range} ${fallback}`;
}

function copy(locale: HealthLocale | undefined, english: string, traditionalChinese: string): string {
  return locale === 'zh-TW' ? traditionalChinese : english;
}
