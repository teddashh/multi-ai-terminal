import type { AdapterContentEvent } from '@mat/shared';
import { describe, expect, it } from 'vitest';
import { mockAdapter } from '../src/adapters/mock.js';

describe('mock adapter', () => {
  it('emits the deterministic ok content sequence and outcome', async () => {
    const events: AdapterContentEvent[] = [];
    const raw: string[] = [];
    const spawned = mockAdapter.spawn({ binding: { provider: 'mock', model: 'ok', permission: 'safe' }, promptText: 'go', cwd: '/' }, { onEvent: (event) => events.push(event), onRaw: (line) => raw.push(line) });
    await expect(spawned.completion).resolves.toMatchObject({ exitCode: 0, resultText: 'Mock task completed.' });
    expect(events.map((event) => event.kind)).toEqual(['thinking', 'tool_use', 'tool_result', 'message']);
    expect(raw).toHaveLength(4);
  });
  it('returns an error outcome for fail', async () => {
    const spawned = mockAdapter.spawn({ binding: { provider: 'mock', model: 'fail', permission: 'safe' }, promptText: 'go', cwd: '/' }, { onEvent: () => undefined, onRaw: () => undefined });
    await expect(spawned.completion).resolves.toMatchObject({ exitCode: 1, error: 'mock failure' });
  });
});
