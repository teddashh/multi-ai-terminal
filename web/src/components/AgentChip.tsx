import type { AgentBinding, ProviderId } from '@mat/shared';

export const PROVIDER_COLORS: Record<ProviderId, string> = {
  claude: '#d97706', codex: '#10a37f', agy: '#4285f4', grok: '#e11d48', mock: '#71717a',
};

export interface AgentChipProps { agent: AgentBinding; label?: string; count?: number; className?: string }
export function AgentChip({ agent, label, count = 1, className = '' }: AgentChipProps) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-zinc-900 px-2.5 py-1 text-xs text-ink ${className}`} title={`${agent.provider} ${agent.model ?? ''}`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[agent.provider] }} aria-hidden="true" />
      {label && <span className="font-medium">{label}</span>}
      <span>{agent.provider}</span>
      {agent.model && <span className="max-w-32 truncate text-muted">{agent.model}</span>}
      {agent.effort && <span className="text-violet-300">{agent.effort}</span>}
      {count > 1 && <span className="font-semibold">×{count}</span>}
    </span>
  );
}
