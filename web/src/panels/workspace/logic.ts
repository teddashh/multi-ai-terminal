import type { RunStatus } from '@mat/shared';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
}

export function lastRunBadge(lastRun: { workflowName: string; status: RunStatus; at: number }, now = Date.now()): string {
  return `${lastRun.workflowName} · ${lastRun.status} · ${relativeTime(lastRun.at, now)}`;
}

export function shortPath(path: string, maxSegments = 2): string {
  const normalized = path.replace(/\/+$/, '') || '/';
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= maxSegments) return normalized;
  return `…/${segments.slice(-maxSegments).join('/')}`;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/');
}
