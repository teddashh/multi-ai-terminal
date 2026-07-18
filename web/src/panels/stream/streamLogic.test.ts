import type { AgentEvent, EventRole } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { filterStreamEvents, groupToolEvents, isScrolledToBottom, reduceFollowState } from './streamLogic.js';

const event = (seq: number, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${seq}`, seq, runId: 'r1', stageId: 's1', nodeRunId: 's1.a.0', attempt: 1,
  role: 'agent', kind: 'message', text: `event ${seq}`, ts: seq, ...overrides,
});
const allRoles: EventRole[] = ['user', 'agent', 'tool', 'thinking', 'system', 'decision'];

describe('stream pipeline', () => {
  it('merges consecutive chunks before applying focus, role, and node filters', () => {
    const result = filterStreamEvents([
      event(1, { role: 'thinking', kind: 'thinking', text: 'plan ' }),
      event(2, { role: 'thinking', kind: 'thinking', text: 'carefully' }),
      event(3, { nodeRunId: 's1.b.0', text: 'other' }),
      event(4, { role: 'system', kind: 'status', text: 'done' }),
    ], { nodeRunIds: ['s1.a.0'], focusedNodeRunId: 's1.a.0', roles: allRoles.filter((role) => role !== 'system') });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('plan carefully');
  });

  it('searches text and tool payloads while retaining both halves of a matched tool call', () => {
    const toolUse = event(1, { role: 'tool', kind: 'tool_use', text: 'shell', tool: { name: 'shell', toolCallId: 'call-1', input: 'npm test' } });
    const toolResult = event(2, { role: 'tool', kind: 'tool_result', text: 'finished', tool: { name: 'shell', toolCallId: 'call-1', output: 'PASS unique-output' } });
    const result = filterStreamEvents([toolUse, toolResult, event(3)], { nodeRunIds: [], roles: allRoles, search: 'unique-output' });
    expect(result.map((item) => item.id)).toEqual(['e1', 'e2']);
    const grouped = groupToolEvents(result);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.events).toEqual([toolUse, toolResult]);
  });

  it('makes focus an additional filter instead of replacing role toggles', () => {
    const result = filterStreamEvents([
      event(1, { nodeRunId: 's1.a.0', role: 'agent' }),
      event(2, { nodeRunId: 's1.a.0', role: 'thinking', kind: 'thinking' }),
      event(3, { nodeRunId: 's1.b.0', role: 'agent' }),
    ], { nodeRunIds: [], roles: ['agent'], focusedNodeRunId: 's1.a.0' });
    expect(result.map((item) => item.id)).toEqual(['e1']);
  });
});

describe('follow state', () => {
  it('pauses away from the bottom, remains paused for new items, and resumes explicitly', () => {
    expect(reduceFollowState({ following: true }, { type: 'scroll', atBottom: false })).toEqual({ following: false });
    expect(reduceFollowState({ following: false }, { type: 'new-items' })).toEqual({ following: false });
    expect(reduceFollowState({ following: false }, { type: 'jump-to-live' })).toEqual({ following: true });
    expect(reduceFollowState({ following: false }, { type: 'scroll', atBottom: true })).toEqual({ following: true });
  });

  it('uses a small bottom threshold', () => {
    expect(isScrolledToBottom(460, 500, 990)).toBe(true);
    expect(isScrolledToBottom(400, 500, 990)).toBe(false);
  });
});

