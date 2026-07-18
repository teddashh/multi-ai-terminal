import { AgentChip } from '../../components/AgentChip.js';
import { useMatStore } from '../../app/store.js';

export function WorkflowPanel() {
  const workflows = useMatStore((state) => state.workflows); const providers = useMatStore((state) => state.providers);
  return <section className="h-full overflow-auto p-3"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Workflow</h2>{workflows.map((workflow) => <div key={workflow.id} className="mb-3 rounded border border-border bg-zinc-900/40 p-2"><h3 className="text-sm font-medium">{workflow.builtin && '★ '}{workflow.name}</h3><p className="mt-1 text-xs text-muted">{workflow.stages.length} stages</p></div>)}<h3 className="mb-2 mt-4 text-xs font-semibold text-muted">Providers</h3><div className="flex flex-wrap gap-2">{providers.map((provider) => <AgentChip key={provider.id} agent={{ provider: provider.id, model: provider.defaultModel, permission: 'auto' }} className={provider.ok ? '' : 'opacity-50'} />)}</div>{providers.length === 0 && <p className="text-xs text-muted">Provider discovery pending.</p>}</section>;
}
