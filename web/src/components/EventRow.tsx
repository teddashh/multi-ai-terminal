import type { AgentEvent } from '@mat/shared';
import { Collapsible } from './Collapsible.js';
import { displayEventKind } from '../i18n/displayText.js';
import { useUiPreferences } from '../i18n/UiPreferences.js';

export function mergeConsecutiveEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  let previousSource: AgentEvent | undefined;
  for (const event of events) {
    const prior = merged.at(-1);
    const sameToolCall = Boolean(prior?.tool?.toolCallId && prior.tool.toolCallId === event.tool?.toolCallId);
    const mergeableKind = event.kind === 'message' || event.kind === 'thinking'
      || ((event.kind === 'tool_use' || event.kind === 'tool_result') && sameToolCall);
    const consecutive = previousSource !== undefined && event.seq === previousSource.seq + 1;
    if (prior && consecutive && mergeableKind && prior.nodeRunId === event.nodeRunId && prior.stageId === event.stageId && prior.attempt === event.attempt && prior.kind === event.kind && prior.role === event.role) {
      let tool: AgentEvent['tool'];
      if (prior.tool || event.tool) {
        tool = { ...(prior.tool ?? event.tool!), ...(event.tool ?? {}) };
        const input = `${prior.tool?.input ?? ''}${event.tool?.input ?? ''}`;
        const output = `${prior.tool?.output ?? ''}${event.tool?.output ?? ''}`;
        if (input) tool.input = input; else delete tool.input;
        if (output) tool.output = output; else delete tool.output;
      }
      merged[merged.length - 1] = { ...prior, text: prior.text + event.text, ...(tool ? { tool } : {}), data: { ...(prior.data ?? {}), ...(event.data ?? {}), continued: true } };
    } else merged.push({ ...event, ...(event.tool ? { tool: { ...event.tool } } : {}), ...(event.data ? { data: { ...event.data } } : {}) });
    previousSource = event;
  }
  return merged;
}

const roleStyle: Record<AgentEvent['role'], string> = {
  user: 'border-sky-400 bg-sky-950/20', agent: 'border-transparent bg-surface/60', thinking: 'border-accentBorder bg-accentSoft/30 italic text-accentForeground',
  tool: 'border-amber-500 bg-amber-950/20 font-mono text-amber-100', system: 'border-border text-muted', decision: 'border-emerald-500 bg-emerald-950/20 text-emerald-100',
};

export function EventRow({ event, duplicateCount }: { event: AgentEvent; duplicateCount?: number }) {
  const { locale } = useUiPreferences();
  const style = event.kind === 'error' ? 'border-red-500 bg-red-950/30 text-red-200' : roleStyle[event.role];
  const heading = event.nodeRunId ?? (locale === 'zh-TW' ? '執行' : 'run');
  return <article data-event-id={event.id} className={`border-l-2 px-3 py-2 text-sm ${style}`}>
    <header className="mb-1 flex items-center gap-2 text-[11px] not-italic text-muted"><span className="font-semibold text-ink">{heading}</span><span>{locale === 'zh-TW' ? `第 ${event.attempt} 次` : `a${event.attempt}`}</span><span>{displayEventKind(event.kind, locale)}</span>{event.data?.detail === 'steer' && <span className="rounded-full border border-accentBorder px-1.5 py-0.5 text-[10px] text-accentForeground">{locale === 'zh-TW' ? '追加指示' : 'steer'}</span>}{duplicateCount && duplicateCount > 1 ? <span className="rounded-full border border-sky-800 px-1.5 py-0.5 text-[10px] text-sky-300">×{duplicateCount} {locale === 'zh-TW' ? '個節點' : 'nodes'}</span> : null}<time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleTimeString(locale, { hour12: false })}</time></header>
    {event.kind === 'error' && event.text.length > 200 ? <Collapsible summary={<p className="break-words">{event.text.slice(0, 160)}…</p>}><p className="whitespace-pre-wrap break-words">{event.text}</p></Collapsible>
      : event.role === 'thinking' ? <Collapsible summary={<p className="line-clamp-2 whitespace-pre-wrap">{event.text}</p>}><p className="whitespace-pre-wrap">{event.text}</p></Collapsible>
      : event.role === 'tool' ? <Collapsible summary={<span>{event.tool?.name ?? displayEventKind(event.kind, locale)}{event.tool?.toolCallId ? ` · ${event.tool.toolCallId}` : ''}</span>}><pre className="overflow-auto whitespace-pre-wrap text-xs">{event.tool?.input ?? event.tool?.output ?? event.text}</pre></Collapsible>
      : <p className="whitespace-pre-wrap break-words">{event.text}</p>}
  </article>;
}
