import type { AgentBinding, ProviderId } from '@mat/shared';
import { displayEffort } from '../i18n/displayText.js';
import { useUiPreferences } from '../i18n/UiPreferences.js';
import { AiSisterAvatar } from './AiSisterTheme.js';

export const PROVIDER_COLORS: Record<ProviderId, string> = {
  claude: '#d97706', codex: '#10a37f', agy: '#4285f4', grok: '#e11d48', openrouter: '#6366f1', mock: '#71717a',
};

export interface AgentChipProps { agent: AgentBinding; label?: string; count?: number; className?: string }
export function AgentChip({ agent, label, count = 1, className = '' }: AgentChipProps) {
  const { locale } = useUiPreferences();
  const labelIncludesProvider = label?.split('·').some((part) => part.trim().toLowerCase() === agent.provider) ?? false;
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-ink ${className}`} title={`${agent.provider} ${agent.model ?? ''}`}>
      <AiSisterAvatar provider={agent.provider} />
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[agent.provider] }} aria-hidden="true" />
      {label && <span className="font-medium">{label}</span>}
      {!labelIncludesProvider && <span>{agent.provider}</span>}
      {agent.model && <span className="max-w-32 truncate text-muted">{agent.model}</span>}
      {agent.effort && <span className="text-accentForeground">{displayEffort(agent.effort, locale)}</span>}
      {count > 1 && <span className="font-semibold">×{count}</span>}
    </span>
  );
}
