import { describe, expect, it } from 'vitest';
import { clearProviderSpawnSlots, detectAuthFailure, humanizeError, IncrementalLineBuffer, providerSpawnSlot } from '../src/adapters/base.js';

describe('detectAuthFailure', () => {
  it.each([
    'Your session has ended',
    'app_session_terminated',
    'Access token could not be refreshed',
    'Failed to refresh token',
  ])('matches BAT codex auth phrase: %s', (phrase) => {
    expect(detectAuthFailure('codex', phrase)).toContain('Fix: codex logout && codex login');
  });
  it('detects revoked Codex refresh tokens', () => {
    expect(detectAuthFailure('codex', 'Your refresh token was already used. Please log out and sign in again.')).toBe('codex sign-in expired.\nFix: codex logout && codex login');
  });

  it('preserves the most useful Grok CLI instruction line', () => {
    const text = 'Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.';
    expect(detectAuthFailure('grok', text)).toBe('grok is not signed in.\nFix: grok login   (browser) · grok login --device-code (headless) · or set XAI_API_KEY\ngrok login --device-code');
  });

  it('never copies a possible API key or token value into the auth reason', () => {
    const sentinel = 'sk-ENV-SECRET-123';
    const prior = process.env.MAT_TEST_API_TOKEN;
    process.env.MAT_TEST_API_TOKEN = sentinel;
    try {
      const reason = detectAuthFailure('grok', `Authentication required\nUse API key ${sentinel}`);
      expect(reason).toBe('grok is not signed in.\nFix: grok login   (browser) · grok login --device-code (headless) · or set XAI_API_KEY');
      expect(reason).not.toContain(sentinel);
    } finally {
      if (prior === undefined) delete process.env.MAT_TEST_API_TOKEN;
      else process.env.MAT_TEST_API_TOKEN = prior;
    }
  });

  it('rejects extra values appended to an otherwise safe login instruction', () => {
    expect(detectAuthFailure('grok', 'Authentication required\nRun: grok login --device-code pairing-code-482719')).toBe(
      'grok is not signed in.\nFix: grok login   (browser) · grok login --device-code (headless) · or set XAI_API_KEY',
    );
  });

  it('uses expired wording for a bare 401', () => {
    expect(detectAuthFailure('claude', 'request failed: 401 Unauthorized')).toBe('claude sign-in expired.\nFix: claude   (then /login inside the session)');
  });

  it('reports OpenRouter key remediation without advertising a sign-in command', () => {
    expect(detectAuthFailure('openrouter', 'OPENROUTER_API_KEY is missing')).toBe(
      "openrouter authentication failed.\nFix: Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.",
    );
  });

  it('ignores non-auth output and the mock provider', () => {
    expect(detectAuthFailure('codex', 'request timed out')).toBeUndefined();
    expect(detectAuthFailure('mock', 'Not signed in')).toBeUndefined();
  });
});

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

  it('humanizes OpenRouter authentication without Codex account guidance', () => {
    expect(humanizeError('401 Unauthorized', 'openrouter')).toBe(
      "openrouter authentication failed. Set OPENROUTER_API_KEY in MAT's environment, then restart MAT.",
    );
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
