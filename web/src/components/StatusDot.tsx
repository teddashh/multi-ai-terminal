import type { NodeRunStatus } from '@mat/shared';

const colors: Record<NodeRunStatus, string> = { queued: 'bg-zinc-500', running: 'bg-sky-400', stalled: 'bg-amber-400', done: 'bg-emerald-400', failed: 'bg-red-500', killed: 'bg-zinc-600' };
export function StatusDot({ status, label = true }: { status: NodeRunStatus; label?: boolean }) {
  return <span className="inline-flex items-center gap-1.5 text-xs text-muted"><span className={`h-2 w-2 rounded-full ${colors[status]} ${status === 'running' ? 'animate-pulse' : ''}`} aria-hidden="true" />{label && <span>{status}</span>}<span className="sr-only">Status: {status}</span></span>;
}
