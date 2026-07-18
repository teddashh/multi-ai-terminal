import type { AgentEvent, EventRole } from '@mat/shared';
import { mergeConsecutiveEvents } from '../../components/EventRow.js';

export interface StreamFilterOptions {
  nodeRunIds: readonly string[];
  roles: readonly EventRole[];
  focusedNodeRunId?: string | undefined;
  search?: string | undefined;
}

export function filterStreamEvents(events: readonly AgentEvent[], options: StreamFilterOptions): AgentEvent[] {
  const filtered = mergeConsecutiveEvents(events).filter((event) => {
    if (!options.roles.includes(event.role)) return false;
    if (options.focusedNodeRunId && event.nodeRunId !== options.focusedNodeRunId) return false;
    if (options.nodeRunIds.length > 0 && (!event.nodeRunId || !options.nodeRunIds.includes(event.nodeRunId))) return false;
    return true;
  });
  const query = options.search?.trim().toLocaleLowerCase();
  if (!query) return filtered;

  const matchedToolCalls = new Set<string>();
  for (const event of filtered) {
    if (matchesSearch(event, query)) {
      const key = toolMatchKey(event);
      if (key) matchedToolCalls.add(key);
    }
  }
  return filtered.filter((event) => matchesSearch(event, query) || (toolMatchKey(event) ? matchedToolCalls.has(toolMatchKey(event)!) : false));
}

function matchesSearch(event: AgentEvent, query: string): boolean {
  return [event.text, event.nodeRunId, event.kind, event.role, event.tool?.name, event.tool?.input, event.tool?.output, event.tool?.toolCallId]
    .some((value) => value?.toLocaleLowerCase().includes(query));
}

function toolMatchKey(event: AgentEvent): string | undefined {
  if (!event.tool?.toolCallId || (event.kind !== 'tool_use' && event.kind !== 'tool_result')) return undefined;
  return `${event.nodeRunId ?? 'run'}:${event.attempt}:${event.tool.toolCallId}`;
}

export interface FeedItem {
  key: string;
  events: AgentEvent[];
  toolCallId?: string;
}

export function groupToolEvents(events: readonly AgentEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const toolUses = new Map<string, number>();
  for (const event of events) {
    const matchKey = toolMatchKey(event);
    if (event.kind === 'tool_result' && matchKey) {
      const useIndex = toolUses.get(matchKey);
      if (useIndex !== undefined) {
        items[useIndex]!.events.push(event);
        continue;
      }
    }
    const item: FeedItem = { key: event.id, events: [event], ...(event.tool?.toolCallId ? { toolCallId: event.tool.toolCallId } : {}) };
    items.push(item);
    if (event.kind === 'tool_use' && matchKey) toolUses.set(matchKey, items.length - 1);
  }
  return items;
}

export interface FollowState { following: boolean }
export type FollowAction = { type: 'scroll'; atBottom: boolean } | { type: 'jump-to-live' } | { type: 'new-items' };

export function reduceFollowState(state: FollowState, action: FollowAction): FollowState {
  if (action.type === 'jump-to-live') return { following: true };
  if (action.type === 'scroll') return { following: action.atBottom };
  return state;
}

export function isScrolledToBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 32): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
