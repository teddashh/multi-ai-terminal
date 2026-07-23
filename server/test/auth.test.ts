import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllAuthAlerts, clearAuthAlert, getAuthAlert, setAuthAlert, signInCommand } from '../src/providers/auth.js';

afterEach(() => { clearAllAuthAlerts(); vi.useRealTimers(); });

describe('provider auth alerts', () => {
  it('sets, gets, and clears alerts with a registration timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);
    expect(setAuthAlert('grok', 'sign in', 'run-1', 'node-1')).toEqual({ message: 'sign in', at: 1234, runId: 'run-1', nodeRunId: 'node-1' });
    expect(getAuthAlert('grok')).toEqual({ message: 'sign in', at: 1234, runId: 'run-1', nodeRunId: 'node-1' });
    clearAuthAlert('grok');
    expect(getAuthAlert('grok')).toBeUndefined();
  });

  it('never registers mock alerts and exposes the verified command table', () => {
    expect(setAuthAlert('mock', 'Not signed in', 'run-1', 'node-1')).toBeUndefined();
    expect(getAuthAlert('mock')).toBeUndefined();
    expect(signInCommand('codex')).toBe('codex logout && codex login');
    expect(signInCommand('claude')).toBe('claude   (then /login inside the session)');
    expect(signInCommand('grok')).toBe('grok login   (browser) · grok login --device-code (headless) · or set XAI_API_KEY');
    expect(signInCommand('agy')).toBe('agy   (sign-in starts automatically; /logout to clear)');
    expect(signInCommand('openrouter')).toBeUndefined();
    expect(signInCommand('mock')).toBeUndefined();
  });
});
