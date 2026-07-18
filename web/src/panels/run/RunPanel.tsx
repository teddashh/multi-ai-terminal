import { AgentChip } from '../../components/AgentChip.js';
import { StatusDot } from '../../components/StatusDot.js';
import { useMatStore } from '../../app/store.js';

export function RunPanel() {
  const run = useMatStore((state) => state.activeRunId ? state.runs[state.activeRunId] : undefined); const focus = useMatStore((state) => state.focusNode);
  return <section className="h-full overflow-auto p-3"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Run</h2>{run ? <><div className="mb-3 text-sm">{run.task}</div><div className="grid gap-2">{run.nodes.map((node) => <button key={node.nodeRunId} onClick={() => focus(node.nodeRunId)} className="rounded border border-border bg-zinc-900/40 p-2 text-left"><div className="mb-2 flex items-center justify-between"><AgentChip agent={node.agent} label={node.label} /><StatusDot status={node.status} /></div><span className="text-xs text-muted">attempt {node.attempt}</span></button>)}</div></> : <p className="text-xs text-muted">No active run.</p>}</section>;
}
