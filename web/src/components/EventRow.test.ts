import type { AgentEvent } from '@mat/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventRow, mergeConsecutiveEvents } from './EventRow.js';

const event = (seq: number, overrides: Partial<AgentEvent> = {}): AgentEvent => ({ id: `e${seq}`, seq, runId: 'r', stageId: 's', nodeRunId: 's.x.0', attempt: 1, role: 'agent', kind: 'message', text: `${seq}`, ts: seq, ...overrides });
describe('mergeConsecutiveEvents', () => {
  it('merges only consecutive equal node/attempt/kind runs', () => {
    const result = mergeConsecutiveEvents([event(1, { text: 'hel' }), event(2, { text: 'lo' }), event(3, { kind: 'thinking', role: 'thinking' }), event(4, { text: '!' })]);
    expect(result).toHaveLength(3); expect(result[0]?.text).toBe('hello'); expect(result[0]?.data).toMatchObject({ continued: true });
  });
  it('does not mutate source events', () => {
    const source = [event(1, { text: 'a' }), event(2, { text: 'b' })]; mergeConsecutiveEvents(source); expect(source[0]?.text).toBe('a');
  });
  it('merges three or more adjacent continuation chunks', () => {
    expect(mergeConsecutiveEvents([event(1), event(2), event(3)]).map((item) => item.text)).toEqual(['123']);
  });
  it('does not merge adjacent parallel tool calls with different identities', () => {
    const first = event(1, { role: 'tool', kind: 'tool_use', tool: { name: 'shell', toolCallId: 'call-1', input: 'one' } });
    const second = event(2, { role: 'tool', kind: 'tool_use', tool: { name: 'shell', toolCallId: 'call-2', input: 'two' } });
    expect(mergeConsecutiveEvents([first, second]).map((item) => item.tool?.toolCallId)).toEqual(['call-1', 'call-2']);
  });
  it('keeps verification failure text readable in the collapsed summary', () => {
    const failure = event(3, {
      role: 'system', kind: 'error', text: `Verification failed (exit 1): ${'x'.repeat(300)}`,
      data: { detail: 'verify-result', verification: { status: 'failed', exitCode: 1 } },
    });
    expect(renderToStaticMarkup(createElement(EventRow, { event: failure }))).toContain('Verification failed (exit 1)');
  });
});
