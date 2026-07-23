import type {
  AgentBinding,
  EventKind,
  GateDecision,
  NodeRun,
  NodeRunStatus,
  ProviderId,
  RunStatus,
  Stage,
  SteerMessage,
  WorkflowDef,
} from '@mat/shared';
import type { UiLocale } from './UiPreferences.js';

interface BuiltinWorkflowCopy {
  name: string;
  description: string;
  stages: Readonly<Record<string, string>>;
  slots: Readonly<Record<string, string>>;
}

/**
 * Display-only copy for the immutable built-in presets. Persisted workflows,
 * prompts, transcripts, reports, and user-authored names remain untouched.
 */
const BUILTIN_ZH_TW: Readonly<Record<string, BuiltinWorkflowCopy>> = {
  planning: {
    name: '規劃模式',
    description: '由多個代理程式獨立提出計畫，再彙整成最終審查結果。',
    stages: { 'round-table': '圓桌討論', 'final-review': '最終審查' },
    slots: { r1: 'R1', r2: 'R2', r3: 'R3', final: '最終審查者' },
  },
  review: {
    name: '審查模式',
    description: '由多個服務提供者安全地獨立審查，再彙整成單一結論。',
    stages: { review: '審查', synthesize: '彙整結論' },
    slots: { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'Agy', synthesizer: '結論彙整者' },
  },
  build: {
    name: '建置模式',
    description: '在隔離工作樹中平行實作，再審查各份修補內容。',
    stages: { implement: '實作', review: '審查' },
    slots: { builder: '實作者', 'grok-review': 'Grok 審查者', 'claude-review': 'Claude 審查者' },
  },
  pipeline: {
    name: '流程：實作 → 測試 → 審查',
    description: '最精簡的正式流程：實作、測試與審查各一位，交接之間都有驗證與關卡。',
    stages: { implement: '實作', test: '測試', review: '審查' },
    slots: { implementer: '實作者', tester: '測試者', reviewer: '審查者' },
  },
};

const BUILTIN_ENGLISH: Readonly<Record<string, BuiltinWorkflowCopy>> = {
  planning: {
    name: 'Planning Mode',
    description: 'Independent plans followed by a consolidated final review.',
    stages: { 'round-table': 'Round Table', 'final-review': 'Final Review' },
    slots: { r1: 'R1', r2: 'R2', r3: 'R3', final: 'Final Reviewer' },
  },
  review: {
    name: 'Review Mode',
    description: 'A safe multi-provider review followed by verdict synthesis.',
    stages: { review: 'Review', synthesize: 'Synthesize' },
    slots: { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'Agy', synthesizer: 'Synthesizer' },
  },
  build: {
    name: 'Build Mode',
    description: 'Parallel isolated implementations followed by patch review.',
    stages: { implement: 'Implement', review: 'Review' },
    slots: { builder: 'Builder', 'grok-review': 'Grok Reviewer', 'claude-review': 'Claude Reviewer' },
  },
  pipeline: {
    name: 'Pipeline: Implement → Test → Review',
    description: 'Shortest production line: one implementer, one test writer, one reviewer, with verification and gates between handoffs.',
    stages: { implement: 'Implement', test: 'Test', review: 'Review' },
    slots: { implementer: 'Implementer', tester: 'Tester', reviewer: 'Reviewer' },
  },
};

const RUN_STATUS_ZH_TW: Record<RunStatus, string> = {
  created: '已建立', running: '執行中', gating: '審查中', done: '完成', failed: '失敗', aborted: '已中止',
};

const NODE_STATUS_ZH_TW: Record<NodeRunStatus | 'thinking', string> = {
  queued: '排隊中', running: '執行中', thinking: '思考中', stalled: '停滯', done: '完成', failed: '失敗', killed: '已終止',
};

const EVENT_KIND_ZH_TW: Record<EventKind, string> = {
  message: '訊息', thinking: '思考', tool_use: '工具呼叫', tool_result: '工具結果', status: '狀態', decision: '決策', error: '錯誤', result: '結果',
};

const EFFORT_ZH_TW: Record<NonNullable<AgentBinding['effort']>, string> = {
  low: '低', medium: '中', high: '高', xhigh: '極高',
};

const PERMISSION_ZH_TW: Record<AgentBinding['permission'], string> = {
  safe: '安全', auto: '自動', full: '完整',
};

const STEER_MODE_ZH_TW: Record<SteerMessage['mode'], string> = {
  interrupt: '立即插入', queue: '排隊',
};

const STEER_STATUS_ZH_TW: Record<SteerMessage['status'], string> = {
  pending: '等待中', active: '處理中', reviewed: '已審查', superseded: '已取代', expired: '已過期',
};

const GATE_ACTION_ZH_TW: Record<GateDecision['action'], string> = {
  advance: '繼續', retry: '重試', abort: '中止',
};

export function displayWorkflowName(workflow: WorkflowDef, locale: UiLocale): string {
  const copy = builtinCopy(workflow, locale);
  if (!copy || (workflow.builtin === true && workflow.name !== copy.english.name)) return workflow.name;
  return workflow.builtin === true ? copy.translated.name : `${copy.translated.name}副本`;
}

export function displayWorkflowDescription(workflow: WorkflowDef, locale: UiLocale): string {
  const copy = builtinCopy(workflow, locale);
  return copy && workflow.description === copy.english.description ? copy.translated.description : workflow.description;
}

export function displayStageName(workflow: WorkflowDef, stage: Pick<Stage, 'id' | 'name'>, locale: UiLocale): string {
  const copy = builtinCopy(workflow, locale);
  return copy && copy.english.stages[stage.id] === stage.name ? copy.translated.stages[stage.id] ?? stage.name : stage.name;
}

export function displaySlotLabel(workflow: WorkflowDef, slotId: string, label: string, locale: UiLocale): string {
  const copy = builtinCopy(workflow, locale);
  return copy && copy.english.slots[slotId] === label ? copy.translated.slots[slotId] ?? label : label;
}

export function displayNodeLabel(
  node: NodeRun,
  nodes: readonly NodeRun[],
  workflow: WorkflowDef,
  locale: UiLocale,
): string {
  let label = node.label;
  if (locale === 'zh-TW' && node.nodeRunId === 'orchestrator') label = `協調者 · ${node.agent.provider}`;
  else if (locale === 'zh-TW' && node.stageId?.startsWith('steer-')) label = `追加指示 · ${node.agent.provider}`;
  else {
    const slot = workflow.stages.find((stage) => stage.id === node.stageId)?.slots.find((candidate) => candidate.id === node.slotId);
    if (slot) label = `${displaySlotLabel(workflow, slot.id, slot.label, locale)} · ${node.agent.provider}`;
  }
  const siblingCount = nodes.filter((candidate) => candidate.stageId === node.stageId && candidate.slotId === node.slotId).length;
  return siblingCount > 1 ? `${label} · #${node.instanceIndex + 1}` : label;
}

export function displayRunStatus(status: RunStatus, locale: UiLocale): string {
  return locale === 'zh-TW' ? RUN_STATUS_ZH_TW[status] : status;
}

export function displayNodeStatus(status: NodeRunStatus | 'thinking', locale: UiLocale): string {
  return locale === 'zh-TW' ? NODE_STATUS_ZH_TW[status] : status;
}

export function displayEventKind(kind: EventKind, locale: UiLocale): string {
  return locale === 'zh-TW' ? EVENT_KIND_ZH_TW[kind] : kind;
}

export function displayEffort(effort: NonNullable<AgentBinding['effort']>, locale: UiLocale): string {
  return locale === 'zh-TW' ? EFFORT_ZH_TW[effort] : effort;
}

export function displayPermission(permission: AgentBinding['permission'], locale: UiLocale): string {
  return locale === 'zh-TW' ? PERMISSION_ZH_TW[permission] : permission;
}

const NOT_FOUND_DETAIL = /^`([^`]+)` CLI not found on PATH — install it or remove this agent from the workflow\.$/;
const PROBE_TIMEOUT_DETAIL = /^Version check timed out after (\d+(?:\.\d+)?)s\. The CLI may be starting slowly; retry detection\.$/;
const BARE_EXIT_DETAIL = /^exit (-?\d+|null)$/;
const AUTH_EXPIRED_LINE = /^(\S+) sign-in expired\.$/;
const AUTH_NOT_SIGNED_IN_LINE = /^(\S+) is not signed in\.$/;
const AUTH_RACE_ERROR = /^(\S+) sign-in expired — parallel \1 sessions can race single-use refresh tokens\. Sign out and back in with the \1 CLI(?: \(e\.g\. `([^`]+)`\))?, or switch to API-key auth to avoid the race\.$/;
const OPENROUTER_AUTH_LINE = 'openrouter authentication failed.';
const OPENROUTER_AUTH_FIX = "Fix: Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.";
const OPENROUTER_AUTH_ERROR = "openrouter authentication failed. Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.";

/** Translate only the server's canonical discovery errors; arbitrary error and
 * evidence text stays verbatim. */
export function displayProviderDetail(provider: ProviderId, detail: string, locale: UiLocale): string {
  if (locale !== 'zh-TW') return detail;
  const notFound = NOT_FOUND_DETAIL.exec(detail);
  if (notFound) return `\`${notFound[1]}\` CLI 不在 PATH 中。請先安裝它，或從工作流程移除此代理程式。`;
  const timeout = PROBE_TIMEOUT_DETAIL.exec(detail);
  if (timeout) return `版本檢查在 ${timeout[1]} 秒後逾時。CLI 可能啟動較慢；請再重新偵測一次。`;
  const exit = BARE_EXIT_DETAIL.exec(detail);
  if (exit) return `版本檢查以代碼 ${exit[1]} 結束，且沒有任何輸出。`;
  return detail;
}

/** Translate the server's canonical auth-alert sentences line by line; the
 * Fix command and any CLI-canonical instruction line stay verbatim. */
export function displayAuthAlertMessage(message: string, locale: UiLocale): string {
  if (locale !== 'zh-TW') return message;
  return message.split('\n').map((line) => {
    if (line === OPENROUTER_AUTH_LINE) return 'openrouter 驗證失敗。';
    if (line === OPENROUTER_AUTH_FIX) return '修正：請在啟動 MAT 前設定 OPENROUTER_API_KEY 環境變數，然後重新啟動 MAT。';
    const expired = AUTH_EXPIRED_LINE.exec(line);
    if (expired) return `${expired[1]} 登入已過期。`;
    const notSignedIn = AUTH_NOT_SIGNED_IN_LINE.exec(line);
    if (notSignedIn) return `${notSignedIn[1]} 尚未登入。`;
    if (line.startsWith('Fix: ')) return `修正：${line.slice('Fix: '.length)}`;
    return line;
  }).join('\n');
}

/** Translate the canonical node failure guidance (auth alerts, the
 * refresh-token race, missing CLIs); CLI-reported text stays verbatim. */
export function displayNodeError(text: string, locale: UiLocale): string {
  if (locale !== 'zh-TW') return text;
  if (text === OPENROUTER_AUTH_ERROR) {
    return 'openrouter 驗證失敗。請在啟動 MAT 前設定 OPENROUTER_API_KEY 環境變數，然後重新啟動 MAT。';
  }
  const race = AUTH_RACE_ERROR.exec(text);
  if (race) {
    const example = race[2] ? `（例如 \`${race[2]}\`）` : '';
    return `${race[1]} 登入已過期——平行執行的 ${race[1]} 工作階段會互搶單次使用的 refresh token。請登出後重新登入 ${race[1]} CLI${example}，或改用 API 金鑰驗證以避免這個競爭。`;
  }
  const notFound = NOT_FOUND_DETAIL.exec(text);
  if (notFound) return `\`${notFound[1]}\` CLI 不在 PATH 中。請先安裝它，或從工作流程移除此代理程式。`;
  return displayAuthAlertMessage(text, locale);
}

const SIGNIN_ZH_TW: Readonly<Record<string, string>> = {
  'Another sign-in is already in progress.': '另一個登入程序正在進行中。',
  'In-app sign-in is not available for this provider.': '此服務提供者不支援從 MAT 內登入。',
  'The sign-in command did not produce a login URL.': '登入指令沒有輸出登入連結。',
  'The sign-in was cancelled.': '已取消登入。',
  'The CLI rejected the sign-in.': 'CLI 拒絕了這次登入。',
  'The sign-in timed out before completing.': '登入在完成前逾時。',
  'The CLI still reports it is not signed in.': 'CLI 仍回報尚未登入。',
  'Signed in.': '已登入。',
  'Unknown sign-in session.': '找不到這個登入工作階段。',
};
const SIGNIN_EXIT_ERROR = /^The sign-in ended with exit (-?\d+|null) before completing\.$/;

/** Translate the server's canonical sign-in strings; CLI-reported status text
 * (e.g. a status probe's own words) stays verbatim. */
export function displaySignInMessage(message: string, locale: UiLocale): string {
  if (locale !== 'zh-TW') return message;
  const canonical = SIGNIN_ZH_TW[message];
  if (canonical) return canonical;
  const exit = SIGNIN_EXIT_ERROR.exec(message);
  if (exit) return `登入以代碼 ${exit[1]} 結束，未能完成。`;
  return message;
}

const INTEGRITY_SYNC_MESSAGE = 'Evidence synchronization did not complete. Retry to catch up.';
const INTEGRITY_RECOVERY_MESSAGE = 'Evidence recovery did not complete. Retry to recover missing events.';
const INTEGRITY_EVENT_MESSAGE = /^Could not recover event (\d+) from persisted evidence\.$/;

/** Translate the client's own canonical evidence-integrity messages. */
export function displayIntegrityMessage(message: string, locale: UiLocale): string {
  if (locale !== 'zh-TW') return message;
  if (message === INTEGRITY_SYNC_MESSAGE) return '證據同步未完成。請重試以補齊。';
  if (message === INTEGRITY_RECOVERY_MESSAGE) return '證據修復未完成。請重試以復原缺少的事件。';
  const event = INTEGRITY_EVENT_MESSAGE.exec(message);
  if (event) return `無法從持久化證據復原事件 ${event[1]}。`;
  return message;
}

export function displaySteerMode(mode: SteerMessage['mode'], locale: UiLocale): string {
  return locale === 'zh-TW' ? STEER_MODE_ZH_TW[mode] : mode;
}

export function displaySteerStatus(status: SteerMessage['status'], locale: UiLocale): string {
  return locale === 'zh-TW' ? STEER_STATUS_ZH_TW[status] : status;
}

export function displayGateAction(action: GateDecision['action'], degraded: boolean, locale: UiLocale): string {
  if (locale !== 'zh-TW') return degraded ? `${action} · degraded` : action;
  return degraded ? `${GATE_ACTION_ZH_TW[action]} · 降級處理` : GATE_ACTION_ZH_TW[action];
}

export function displayToolPhase(phase: 'use' | 'result' | 'paired', locale: UiLocale): string {
  if (locale !== 'zh-TW') return phase;
  return phase === 'use' ? '呼叫' : phase === 'result' ? '結果' : '呼叫與結果';
}

function builtinCopy(workflow: WorkflowDef, locale: UiLocale): { english: BuiltinWorkflowCopy; translated: BuiltinWorkflowCopy } | undefined {
  if (locale !== 'zh-TW') return undefined;
  if (workflow.builtin === true) {
    const english = BUILTIN_ENGLISH[workflow.id];
    const translated = BUILTIN_ZH_TW[workflow.id];
    return english && translated ? { english, translated } : undefined;
  }
  for (const [sourceId, english] of Object.entries(BUILTIN_ENGLISH)) {
    if (workflow.name !== `${english.name} Copy`) continue;
    const translated = BUILTIN_ZH_TW[sourceId];
    if (translated && new RegExp(`^${sourceId}-copy(?:-\\d+)?$`).test(workflow.id)) return { english, translated };
  }
  return undefined;
}
