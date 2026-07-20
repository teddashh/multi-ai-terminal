import { describe, expect, it } from 'vitest';
import { clearProviderSpawnSlots, humanizeError, IncrementalLineBuffer, providerSpawnSlot } from '../src/adapters/base.js';

describe('IncrementalLineBuffer', () => {
  it('handles partial lines and flushes the tail', () => {
    const lines: string[] = [];
    const buffer = new IncrementalLineBuffer((line) => lines.push(line));
    buffer.push('hel'); buffer.push('lo\nwor'); buffer.end();
    expect(lines).toEqual(['hello', 'wor']);
  });
  it('handles multiline chunks, blank lines, and CRLF', () => {
    const lines: string[] = [];
    const buffer = new IncrementalLineBuffer((line) => lines.push(line));
    buffer.push('one\r\ntwo\n\nthree\r\n'); buffer.end();
    expect(lines).toEqual(['one', 'two', '', 'three']);
  });
});

describe('humanizeError', () => {
  it('turns missing CLI spawn errors into an actionable instruction', () => {
    expect(humanizeError('spawn grok ENOENT')).toBe('`grok` CLI not found on PATH — install it or remove this agent from the workflow.');
  });

  it('unwraps double-encoded Codex API failures', () => {
    const nested = JSON.stringify({ message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Unsupported input.' } }) });
    expect(humanizeError(nested, 'codex')).toBe('codex: 400 invalid_request_error — Unsupported input.');
  });

  it('passes plain text through unchanged', () => {
    expect(humanizeError('plain failure')).toBe('plain failure');
  });

  it('humanizes revoked Codex refresh tokens with a verified relogin command', () => {
    const expected = 'codex sign-in expired — parallel codex sessions can race single-use refresh tokens. Sign out and back in with the codex CLI (e.g. `codex logout && codex login`), or switch to API-key auth to avoid the race.';
    expect(humanizeError('Your access token could not be refreshed because your refresh token was revoked.', 'codex')).toBe(expected);
    expect(humanizeError(expected, 'codex')).toBe(expected);
  });

  it('humanizes unauthorized failures generically for other real providers', () => {
    expect(humanizeError('401 Unauthorized', 'claude')).toBe('claude sign-in expired — parallel claude sessions can race single-use refresh tokens. Sign out and back in with the claude CLI, or switch to API-key auth to avoid the race.');
  });
});

describe('providerSpawnSlot', () => {
  it('queues one provider at monotonically spaced launch times', async () => {
    clearProviderSpawnSlots();
    let now = 0;
    const times: number[] = [];
    const options = { now: () => now, sleep: async (ms: number) => { now += ms; } };
    await Promise.all([
      providerSpawnSlot('fake', options).then(() => times.push(now)),
      providerSpawnSlot('fake', options).then(() => times.push(now)),
      providerSpawnSlot('fake', options).then(() => times.push(now)),
    ]);
    expect(times).toEqual([0, 1500, 3000]);
  });

  it('does not delay mock launches', async () => {
    clearProviderSpawnSlots();
    let sleeps = 0;
    await Promise.all([
      providerSpawnSlot('mock', { sleep: async () => { sleeps += 1; } }),
      providerSpawnSlot('mock', { sleep: async () => { sleeps += 1; } }),
    ]);
    expect(sleeps).toBe(0);
  });
});
