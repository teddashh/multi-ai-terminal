import type { AgentEvent } from '@mat/shared';
import { Collapsible } from './Collapsible.js';

export function mergeConsecutiveEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  for (const event of events) {
    const prior = merged.at(-1);
    if (prior && prior.nodeRunId === event.nodeRunId && prior.attempt === event.attempt && prior.kind === event.kind) {
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
  }
  return merged;
}

const roleStyle: Record<AgentEvent['role'], string> = {
  user: 'border-sky-400 bg-sky-950/20', agent: 'border-transparent bg-zinc-900/50', thinking: 'border-violet-500 bg-violet-950/20 italic text-violet-200',
  tool: 'border-amber-500 bg-amber-950/20 font-mono text-amber-100', system: 'border-zinc-700 text-muted', decision: 'border-emerald-500 bg-emerald-950/20 text-emerald-100',
};

export function EventRow({ event, duplicateCount }: { event: AgentEvent; duplicateCount?: number }) {
  const style = event.kind === 'error' ? 'border-red-500 bg-red-950/30 text-red-200' : roleStyle[event.role];
  const heading = event.nodeRunId ?? 'run';
  return <article data-event-id={event.id} className={`border-l-2 px-3 py-2 text-sm ${style}`}>
    <header className="mb-1 flex items-center gap-2 text-[11px] not-italic text-muted"><span className="font-semibold">{heading}</span><span>a{event.attempt}</span><span>{event.kind}</span>{event.data?.detail === 'steer' && <span className="rounded-full border border-violet-700 px-1.5 py-0.5 text-[10px] text-violet-200">steer</span>}{duplicateCount && duplicateCount > 1 ? <span className="rounded-full border border-sky-800 px-1.5 py-0.5 text-[10px] text-sky-300">×{duplicateCount} nodes</span> : null}<time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleTimeString(undefined, { hour12: false })}</time></header>
    {event.kind === 'error' && event.text.length > 200 ? <Collapsible summary={<p className="break-words">{event.text.slice(0, 160)}…</p>}><p className="whitespace-pre-wrap break-words">{event.text}</p></Collapsible>
      : event.role === 'thinking' ? <Collapsible summary={<p className="line-clamp-2 whitespace-pre-wrap">{event.text}</p>}><p className="whitespace-pre-wrap">{event.text}</p></Collapsible>
      : event.role === 'tool' ? <Collapsible summary={<span>{event.tool?.name ?? event.kind}{event.tool?.toolCallId ? ` · ${event.tool.toolCallId}` : ''}</span>}><pre className="overflow-auto whitespace-pre-wrap text-xs">{event.tool?.input ?? event.tool?.output ?? event.text}</pre></Collapsible>
      : <p className="whitespace-pre-wrap break-words">{event.text}</p>}
  </article>;
}
