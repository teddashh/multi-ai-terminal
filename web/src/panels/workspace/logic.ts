import type { RunStatus, Workspace } from '@mat/shared';

type WorkspaceLocale = 'en' | 'zh-TW';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(timestamp: number, now = Date.now(), locale: WorkspaceLocale = 'en'): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return locale === 'zh-TW' ? '剛剛' : 'just now';
  if (elapsed < HOUR) return locale === 'zh-TW' ? `${Math.floor(elapsed / MINUTE)} 分鐘前` : `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return locale === 'zh-TW' ? `${Math.floor(elapsed / HOUR)} 小時前` : `${Math.floor(elapsed / HOUR)}h ago`;
  return locale === 'zh-TW' ? `${Math.floor(elapsed / DAY)} 天前` : `${Math.floor(elapsed / DAY)}d ago`;
}

export function lastRunBadge(lastRun: NonNullable<Workspace['lastRun']>, now = Date.now(), locale: WorkspaceLocale = 'en'): string {
  return `${localizedWorkflowName(lastRun, locale)} · ${localizedRunStatus(lastRun.status, locale)} · ${relativeTime(lastRun.at, now, locale)}`;
}

export function shortPath(path: string, maxSegments = 2): string {
  const normalized = path.replace(/[\\/]+$/, '') || '/';
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  if (segments.length <= maxSegments) return normalized;
  return `…/${segments.slice(-maxSegments).join('/')}`;
}

export function isAbsolutePath(path: string): boolean {
  // POSIX root, Windows drive (C:\ or C:/), or UNC (\\server\share).
  return /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path);
}

const BUILTIN_WORKFLOW_NAMES: Readonly<Record<string, { en: string; zh: string }>> = {
  planning: { en: 'Planning Mode', zh: '規劃模式' },
  review: { en: 'Review Mode', zh: '審查模式' },
  build: { en: 'Build Mode', zh: '建置模式' },
  pipeline: { en: 'Pipeline: Implement → Test → Review', zh: '流程：實作 → 測試 → 審查' },
};

function localizedWorkflowName(lastRun: NonNullable<Workspace['lastRun']>, locale: WorkspaceLocale): string {
  if (locale !== 'zh-TW' || lastRun.workflowBuiltin !== true || !lastRun.workflowId) return lastRun.workflowName;
  const builtin = BUILTIN_WORKFLOW_NAMES[lastRun.workflowId];
  return builtin && lastRun.workflowName === builtin.en ? builtin.zh : lastRun.workflowName;
}

function localizedRunStatus(status: RunStatus, locale: WorkspaceLocale): string {
  if (locale !== 'zh-TW') return status;
  return ({
    created: '已建立', running: '執行中', gating: '審查中', done: '完成', failed: '失敗', aborted: '已中止',
  } satisfies Readonly<Record<RunStatus, string>>)[status];
}
