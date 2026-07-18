import type { AgentEvent } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { mergeConsecutiveEvents } from './EventRow.js';

const event = (seq: number, overrides: Partial<AgentEvent> = {}): AgentEvent => ({ id: `e${seq}`, seq, runId: 'r', stageId: 's', nodeRunId: 's.x.0', attempt: 1, role: 'agent', kind: 'message', text: `${seq}`, ts: seq, ...overrides });
describe('mergeConsecutiveEvents', () => {
  it('merges only consecutive equal node/attempt/kind runs', () => {
    const result = mergeConsecutiveEvents([event(1, { text: 'hel' }), event(2, { text: 'lo' }), event(3, { kind: 'thinking', role: 'thinking' }), event(4, { text: '!' })]);
    expect(result).toHaveLength(3); expect(result[0]?.text).toBe('hello'); expect(result[0]?.data).toMatchObject({ continued: true });
  });
  it('does not mutate source events', () => {
    const source = [event(1, { text: 'a' }), event(2, { text: 'b' })]; mergeConsecutiveEvents(source); expect(source[0]?.text).toBe('a');
  });
});
