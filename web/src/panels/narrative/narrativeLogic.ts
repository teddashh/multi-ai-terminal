import type { AgentEvent, NodeRun, RunSnapshot } from '@mat/shared';
import { displayNodeLabel, displayStageName } from '../../i18n/displayText.js';
import type { UiLocale } from '../../i18n/UiPreferences.js';

export type NarrativeKind = 'prompt' | 'message' | 'thinking' | 'tool' | 'decision' | 'verification' | 'error' | 'lifecycle' | 'gap';

export interface NarrativeActor {
  nodeRunId: string | null;
  label: string;
  provider?: NodeRun['agent']['provider'];
  model?: string;
  stageId: string | null;
  stageName?: string;
}

export interface NarrativeItem {
  key: string;
  kind: NarrativeKind;
  sources: readonly AgentEvent[];
  seqStart: number;
  seqEnd: number;
  tsStart: number;
  tsEnd: number;
  actors: readonly NarrativeActor[];
  attempt: number;
  text?: string;
  detail?: string;
  tool?: {
    phase: 'use' | 'result' | 'paired';
    toolCallId?: string;
    name: string;
    input?: string;
    output?: string;
    isError?: boolean;
  };
  gap?: { fromSeq: number; toSeq: number };
}

export interface NarrativeFilterOptions {
  nodeRunIds?: readonly string[];
  focusedNodeRunId?: string;
  search?: string;
  showTechnical?: boolean;
}

export function buildNarrativeItems(run: RunSnapshot, events: readonly AgentEvent[], locale: UiLocale = 'en'): NarrativeItem[] {
  const items: NarrativeItem[] = [];
  let priorSeq: number | undefined;
  for (const event of events) {
    if (priorSeq !== undefined && event.seq > priorSeq + 1) {
      items.push(gapItem(priorSeq + 1, event.seq - 1, event));
    }
    priorSeq = Math.max(priorSeq ?? 0, event.seq);

    const kind = narrativeKind(event);
    const prior = items.at(-1);
    if (prior && canMergeText(prior, event, kind)) {
      (prior.sources as AgentEvent[]).push(event);
      prior.seqEnd = event.seq;
      prior.tsEnd = event.ts;
      prior.text = `${prior.text ?? ''}${event.text}`;
      continue;
    }
    if (prior && canPairTool(prior, event)) {
      (prior.sources as AgentEvent[]).push(event);
      const tool = event.tool!;
      prior.seqEnd = event.seq;
      prior.tsEnd = event.ts;
      prior.text = [prior.text, event.text].filter(Boolean).join('\n');
      prior.tool = {
        ...prior.tool!,
        phase: 'paired',
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
      };
      continue;
    }
    items.push(eventItem(run, event, kind, locale));
  }
  return items;
}

export function filterNarrativeItems(items: readonly NarrativeItem[], options: NarrativeFilterOptions = {}): NarrativeItem[] {
  const selectedNodes = options.focusedNodeRunId ? [options.focusedNodeRunId] : (options.nodeRunIds ?? []);
  const query = options.search?.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (item.kind === 'gap') return true;
    if (!options.showTechnical && (item.kind === 'prompt' || item.kind === 'thinking' || item.kind === 'tool' || item.kind === 'lifecycle')) return false;
    if (selectedNodes.length > 0 && !item.actors.some((actor) => actor.nodeRunId !== null && selectedNodes.includes(actor.nodeRunId))) return false;
    return !query || narrativeSearchText(item).toLocaleLowerCase().includes(query);
  });
}

export function flattenNarrativeSources(items: readonly NarrativeItem[]): AgentEvent[] {
  return items.flatMap((item) => item.sources);
}

export function narrativeSearchText(item: NarrativeItem): string {
  return [
    item.text,
    item.detail,
    item.tool?.name,
    item.tool?.input,
    item.tool?.output,
    ...item.actors.flatMap((actor) => [actor.label, actor.provider, actor.model, actor.stageName, actor.nodeRunId]),
  ].filter((value): value is string => typeof value === 'string').join('\n');
}

export function resolveNarrativeActor(run: RunSnapshot, event: AgentEvent, locale: UiLocale = 'en'): NarrativeActor {
  const node = event.nodeRunId ? run.nodes.find((candidate) => candidate.nodeRunId === event.nodeRunId) : undefined;
  const stageId = event.stageId ?? node?.stageId ?? null;
  const stage = stageId ? run.workflow.stages.find((candidate) => candidate.id === stageId) : undefined;
  const stageName = stage ? displayStageName(run.workflow, stage, locale) : undefined;
  if (!node) {
    return {
      nodeRunId: event.nodeRunId,
      label: event.nodeRunId ?? (event.role === 'decision' ? (locale === 'zh-TW' ? '協調者決策' : 'Orchestrator decision') : (locale === 'zh-TW' ? '執行' : 'Run')),
      stageId,
      ...(stageName ? { stageName } : {}),
    };
  }
  return {
    nodeRunId: node.nodeRunId,
    label: displayNodeLabel(node, run.nodes, run.workflow, locale),
    provider: node.agent.provider,
    ...(node.agent.model ? { model: node.agent.model } : {}),
    stageId,
    ...(stageName ? { stageName } : {}),
  };
}

function narrativeKind(event: AgentEvent): NarrativeKind {
  const detail = typeof event.data?.detail === 'string' ? event.data.detail : undefined;
  if (detail === 'verify-result') return 'verification';
  if (event.kind === 'error' || event.tool?.isError) return 'error';
  if (event.kind === 'decision' || event.role === 'decision') return 'decision';
  if (event.kind === 'tool_use' || event.kind === 'tool_result' || event.role === 'tool') return 'tool';
  if (event.role === 'thinking' || event.kind === 'thinking') return 'thinking';
  if (event.role === 'user') return 'prompt';
  if (event.role === 'agent' && event.kind === 'message') return 'message';
  return 'lifecycle';
}

function eventItem(run: RunSnapshot, event: AgentEvent, kind: NarrativeKind, locale: UiLocale): NarrativeItem {
  const actor = resolveNarrativeActor(run, event, locale);
  const detail = typeof event.data?.detail === 'string' ? event.data.detail : undefined;
  const tool = kind === 'tool' && event.tool ? {
    phase: event.kind === 'tool_result' ? 'result' as const : 'use' as const,
    ...(event.tool.toolCallId ? { toolCallId: event.tool.toolCallId } : {}),
    name: event.tool.name,
    ...(event.tool.input !== undefined ? { input: event.tool.input } : {}),
    ...(event.tool.output !== undefined ? { output: event.tool.output } : {}),
    ...(event.tool.isError !== undefined ? { isError: event.tool.isError } : {}),
  } : undefined;
  return {
    key: event.id,
    kind,
    sources: [event],
    seqStart: event.seq,
    seqEnd: event.seq,
    tsStart: event.ts,
    tsEnd: event.ts,
    actors: [actor],
    attempt: event.attempt,
    text: event.text,
    ...(detail ? { detail } : {}),
    ...(tool ? { tool } : {}),
  };
}

function canMergeText(prior: NarrativeItem, event: AgentEvent, kind: NarrativeKind): boolean {
  if (kind !== 'message' && kind !== 'thinking') return false;
  const previous = prior.sources.at(-1);
  return prior.kind === kind && previous !== undefined && event.seq === previous.seq + 1
    && previous.nodeRunId === event.nodeRunId && previous.stageId === event.stageId
    && previous.attempt === event.attempt && previous.role === event.role && previous.kind === event.kind;
}

function canPairTool(prior: NarrativeItem, event: AgentEvent): boolean {
  const previous = prior.sources.at(-1);
  return prior.kind === 'tool' && prior.tool?.phase === 'use' && event.kind === 'tool_result'
    && previous !== undefined && event.seq === previous.seq + 1
    && previous.nodeRunId === event.nodeRunId && previous.stageId === event.stageId && previous.attempt === event.attempt
    && Boolean(previous.tool?.toolCallId && previous.tool.toolCallId === event.tool?.toolCallId);
}

function gapItem(fromSeq: number, toSeq: number, next: AgentEvent): NarrativeItem {
  return {
    key: `gap-${fromSeq}-${toSeq}`,
    kind: 'gap',
    sources: [],
    seqStart: fromSeq,
    seqEnd: toSeq,
    tsStart: next.ts,
    tsEnd: next.ts,
    actors: [],
    attempt: 0,
    gap: { fromSeq, toSeq },
  };
}
