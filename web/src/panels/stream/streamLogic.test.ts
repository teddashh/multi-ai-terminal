import type { AgentEvent, EventRole } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { filterStreamEvents, groupToolEvents, isScrolledToBottom, reduceFollowState } from './streamLogic.js';

const event = (seq: number, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${seq}`, seq, runId: 'r1', stageId: 's1', nodeRunId: 's1.a.0', attempt: 1,
  role: 'agent', kind: 'message', text: `event ${seq}`, ts: seq, ...overrides,
});
const allRoles: EventRole[] = ['user', 'agent', 'tool', 'thinking', 'system', 'decision'];

describe('stream pipeline', () => {
  it('preserves raw consecutive chunks while applying focus, role, and node filters', () => {
    const result = filterStreamEvents([
      event(1, { role: 'thinking', kind: 'thinking', text: 'plan ' }),
      event(2, { role: 'thinking', kind: 'thinking', text: 'carefully' }),
      event(3, { nodeRunId: 's1.b.0', text: 'other' }),
      event(4, { role: 'system', kind: 'status', text: 'done' }),
    ], { nodeRunIds: ['s1.a.0'], focusedNodeRunId: 's1.a.0', roles: allRoles.filter((role) => role !== 'system') });
    expect(result.map((item) => item.text)).toEqual(['plan ', 'carefully']);
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

  it('collapses identical user seed prompts across nodes but not other roles or attempts', () => {
    const grouped = groupToolEvents([
      event(1, { role: 'user', text: 'same task', nodeRunId: 's1.a.0' }),
      event(2, { role: 'user', text: 'same task', nodeRunId: 's1.b.0' }),
      event(3, { role: 'agent', text: 'same task', nodeRunId: 's1.c.0' }),
      event(4, { role: 'user', text: 'same task', nodeRunId: 's1.d.0', attempt: 2 }),
    ]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ duplicateCount: 2, events: [expect.objectContaining({ id: 'e1' })] });
    expect(grouped[0]?.sourceEvents?.map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(grouped[1]?.duplicateCount).toBeUndefined();
    expect(grouped[2]?.duplicateCount).toBeUndefined();
  });

  it('does not move a delayed tool result ahead of intervening evidence', () => {
    const toolUse = event(1, { role: 'tool', kind: 'tool_use', tool: { name: 'shell', toolCallId: 'call-1', input: 'npm test' } });
    const intervening = event(2, { text: 'another agent spoke', nodeRunId: 's1.b.0' });
    const toolResult = event(3, { role: 'tool', kind: 'tool_result', tool: { name: 'shell', toolCallId: 'call-1', output: 'PASS' } });
    const grouped = groupToolEvents([toolUse, intervening, toolResult]);
    expect(grouped.flatMap((item) => item.events).map((item) => item.id)).toEqual(['e1', 'e2', 'e3']);
    expect(grouped).toHaveLength(3);
  });
});

describe('follow state', () => {
  it('pauses only for intent-backed upward scrolling and resumes near the bottom or explicitly', () => {
    expect(reduceFollowState({ following: true }, { type: 'scroll', gap: 200, deltaY: -10, intentActive: false })).toEqual({ following: true });
    expect(reduceFollowState({ following: true }, { type: 'scroll', gap: 200, deltaY: -10, intentActive: true })).toEqual({ following: false });
    expect(reduceFollowState({ following: true }, { type: 'scroll', gap: 200, deltaY: 10, intentActive: true })).toEqual({ following: true });
    expect(reduceFollowState({ following: false }, { type: 'new-items' })).toEqual({ following: false });
    expect(reduceFollowState({ following: false }, { type: 'jump-to-live' })).toEqual({ following: true });
    expect(reduceFollowState({ following: false }, { type: 'scroll', gap: 95, deltaY: 10, intentActive: false })).toEqual({ following: true });
  });

  it('uses the 96px near-bottom threshold', () => {
    expect(isScrolledToBottom(394, 500, 990)).toBe(true);
    expect(isScrolledToBottom(393, 500, 990)).toBe(false);
  });
});
