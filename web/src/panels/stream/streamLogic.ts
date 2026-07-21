import type { AgentEvent, EventRole } from '@mat/shared';

export interface StreamFilterOptions {
  nodeRunIds: readonly string[];
  roles: readonly EventRole[];
  focusedNodeRunId?: string | undefined;
  search?: string | undefined;
}

export function filterStreamEvents(events: readonly AgentEvent[], options: StreamFilterOptions): AgentEvent[] {
  // Timeline is the raw evidence view. Narrative owns readable continuation
  // grouping; retaining each event here preserves exact id/seq provenance.
  const filtered = events.filter((event) => {
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
  sourceEvents?: AgentEvent[];
  toolCallId?: string;
  duplicateCount?: number;
}

export function groupToolEvents(events: readonly AgentEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const toolUses = new Map<string, number>();
  let adjacentDuplicateUsers: { key: string; index: number; nodeRunIds: Set<string>; lastSeq: number } | undefined;
  for (const event of events) {
    if (event.role === 'user' && event.nodeRunId) {
      const duplicateKey = `${event.stageId ?? ''}\0${event.attempt}\0${event.text}`;
      const prior = adjacentDuplicateUsers;
      if (prior && prior.key === duplicateKey && event.seq === prior.lastSeq + 1 && !prior.nodeRunIds.has(event.nodeRunId)) {
        prior.nodeRunIds.add(event.nodeRunId);
        prior.lastSeq = event.seq;
        const item = items[prior.index]!;
        item.sourceEvents = [...(item.sourceEvents ?? item.events), event];
        item.duplicateCount = prior.nodeRunIds.size;
        continue;
      }
      adjacentDuplicateUsers = { key: duplicateKey, index: items.length, nodeRunIds: new Set([event.nodeRunId]), lastSeq: event.seq };
    } else {
      adjacentDuplicateUsers = undefined;
    }
    const matchKey = toolMatchKey(event);
    if (event.kind === 'tool_result' && matchKey) {
      const useIndex = toolUses.get(matchKey);
      toolUses.delete(matchKey);
      // Keep the evidence timeline monotonic. Pulling a later result back across
      // intervening events makes those events appear after evidence that actually
      // occurred later; only adjacent halves may render as one card.
      if (useIndex !== undefined && useIndex === items.length - 1) {
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
export type FollowAction = { type: 'scroll'; gap: number; deltaY: number; intentActive: boolean } | { type: 'jump-to-live' } | { type: 'new-items' };

export function reduceFollowState(state: FollowState, action: FollowAction): FollowState {
  if (action.type === 'jump-to-live') return { following: true };
  if (action.type === 'scroll') {
    if (action.gap < 96) return { following: true };
    if (action.intentActive && action.deltaY < -1) return { following: false };
  }
  return state;
}

export function isScrolledToBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 96): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
