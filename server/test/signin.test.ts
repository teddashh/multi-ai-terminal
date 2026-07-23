import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SIGNIN_BUSY, SIGNIN_CANCELLED, SIGNIN_NO_URL, SIGNIN_NOT_SUPPORTED, SIGNIN_NOT_VERIFIED,
  SIGNIN_REJECTED, SIGNIN_TIMEOUT, SIGNIN_UNKNOWN_SESSION, SIGNIN_VERIFIED,
  cancelSignIn, isSignInActive, providerSignInDescriptor, resetSignInForTests, setSignInRecipeForTests,
  setSignInTimingForTests, signInExitError, signInStatus, startSignIn, submitSignInCode,
} from '../src/providers/signin.js';
import { configureDataDir } from '../src/store/dataDir.js';
import { createFakeExecutable } from './helpers/fakeExecutable.js';

// The fakes speak each CLI's real dialect so the production recipes (command,
// args, trusted hosts, status probes) are exercised verbatim, not synthetic
// stand-ins. Their output deliberately avoids FAILURE_RE words on happy paths.
const FAKE_CLAUDE = `
const args = process.argv.slice(2).join(' ');
if (args === 'auth status') {
  if (process.env.FAKE_CLAUDE_STATUS === 'signed-out') { console.log('{"loggedIn": false}'); process.exit(0); }
  console.log('{"loggedIn": true}');
  process.exit(0);
}
if (args !== 'auth login') { console.log('unexpected args: ' + args); process.exit(9); }
const behavior = process.env.FAKE_CLAUDE_BEHAVIOR ?? 'happy';
if (behavior === 'exit-early') { console.log('nothing to see'); process.exit(2); }
console.log('Open the following URL to authorize: https://claude.ai/oauth/authorize?flow=cli&state=abc123');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (!buffer.includes('\\n')) return;
  if (behavior === 'reject-code') { console.log('Error: invalid authorization code ABCD-EFGH'); process.exit(1); }
  console.log('Login complete. Welcome back!');
  process.exit(0);
});
`;

const FAKE_CODEX = `
const args = process.argv.slice(2).join(' ');
const keyPresent = process.env.OPENAI_API_KEY === undefined ? 'no' : 'yes';
if (args === 'login status') { console.log('key-present:' + keyPresent); if (keyPresent === 'yes') process.exit(8); console.log('Logged in using ChatGPT'); process.exit(0); }
if (args !== 'login --device-auth') { console.log('unexpected args: ' + args); process.exit(9); }
console.log('key-present:' + keyPresent);
if (keyPresent === 'yes') process.exit(8);
console.log('To sign in, open https://auth.openai.com/codex/device and enter the code JKB2-U3B4T');
setTimeout(() => { console.log('Sign-in complete.'); process.exit(0); }, 250);
`;

const root = mkdtempSync(join(tmpdir(), 'mat-signin-tests-'));
const binDir = join(root, 'bin');
const originalPath = process.env.PATH;
const originalCodexHome = process.env.CODEX_HOME;

beforeAll(() => {
  mkdirSync(binDir, { recursive: true });
  process.env.CODEX_HOME = join(root, 'codex-home');
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  configureDataDir(join(root, 'data'));
  createFakeExecutable(binDir, 'claude', FAKE_CLAUDE);
  createFakeExecutable(binDir, 'codex', FAKE_CODEX);
  process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);
});
afterEach(() => {
  resetSignInForTests();
  delete process.env.FAKE_CLAUDE_BEHAVIOR;
  delete process.env.FAKE_CLAUDE_STATUS;
  delete process.env.MAT_TEST_LEAK_MARKER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MAT_CLAUDE_BIN;
  delete process.env.MAT_CODEX_BIN;
});
afterAll(() => {
  process.env.PATH = originalPath;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const settled = (loginId: string, timeout = 10_000) =>
  vi.waitFor(() => {
    const status = signInStatus(loginId);
    expect(status.phase).not.toBe('pending');
    return status;
  }, { timeout, interval: 50 });

describe('providerSignInDescriptor', () => {
  it('describes the fixed recipes and warns about the codex clobber', () => {
    expect(providerSignInDescriptor('claude')).toEqual({ mode: 'paste-code' });
    expect(providerSignInDescriptor('codex')).toEqual({ mode: 'device', replacesExistingLogin: true });
    expect(providerSignInDescriptor('grok')).toEqual({ mode: 'device' });
    expect(providerSignInDescriptor('agy')).toBeUndefined();
    expect(providerSignInDescriptor('mock')).toBeUndefined();
  });
});

describe('paste-code ceremony (claude recipe)', () => {
  it('surfaces the trusted URL, forwards the pasted code, and verifies via the status probe', async () => {
    process.env.MAT_CLAUDE_BIN = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    const started = await startSignIn('claude');
    expect(started).toMatchObject({ ok: true, mode: 'paste-code', url: 'https://claude.ai/oauth/authorize?flow=cli&state=abc123' });
    expect(started.loginId).toBeTruthy();
    expect(started.outputExcerpt).toContain('https://claude.ai/oauth/authorize');
    expect(signInStatus(started.loginId!).phase).toBe('pending');

    const submitted = await submitSignInCode(started.loginId!, 'AUTH-CODE-1234');
    expect(submitted).toMatchObject({ ok: true, statusDetail: SIGNIN_VERIFIED });
    expect(signInStatus(started.loginId!)).toMatchObject({ phase: 'succeeded', statusDetail: SIGNIN_VERIFIED });
  }, 30_000);

  it('reports a rejected code when the CLI refuses it', async () => {
    process.env.FAKE_CLAUDE_BEHAVIOR = 'reject-code';
    const started = await startSignIn('claude');
    expect(started.ok).toBe(true);
    const submitted = await submitSignInCode(started.loginId!, 'BAD-CODE');
    expect(submitted).toMatchObject({ ok: false, error: SIGNIN_REJECTED });
    expect(submitted.outputExcerpt).toContain('<redacted-url>');
    expect(submitted.outputExcerpt).toContain('<redacted-code>');
    expect(submitted.outputExcerpt).not.toContain('ABCD-EFGH');
    expect(signInStatus(started.loginId!)).toMatchObject({
      phase: 'failed',
      outputExcerpt: expect.stringContaining('<redacted-url>'),
    });
  }, 30_000);

  it('fails a clean exit that the status probe cannot verify', async () => {
    process.env.FAKE_CLAUDE_STATUS = 'signed-out';
    const started = await startSignIn('claude');
    const submitted = await submitSignInCode(started.loginId!, 'AUTH-CODE-1234');
    expect(submitted).toMatchObject({ ok: false, error: SIGNIN_NOT_VERIFIED });
  }, 30_000);

  it('reports the exit and keeps the excerpt when the CLI dies before printing a URL', async () => {
    process.env.FAKE_CLAUDE_BEHAVIOR = 'exit-early';
    const started = await startSignIn('claude');
    expect(started.ok).toBe(false);
    expect(started.error).toBe(SIGNIN_NO_URL);
    expect(started.outputExcerpt).toContain('nothing to see');
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'failed', error: signInExitError(2) });
  }, 30_000);

  it('holds a single active ceremony, and cancel releases it for the next one', async () => {
    const started = await startSignIn('claude');
    expect(started.ok).toBe(true);
    await expect(startSignIn('codex')).resolves.toMatchObject({ ok: false, error: SIGNIN_BUSY });

    expect(cancelSignIn(started.loginId!)).toEqual({ ok: true });
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'failed', error: SIGNIN_CANCELLED });

    const next = await startSignIn('claude');
    expect(next.ok).toBe(true);
  }, 30_000);
});

describe('device ceremony (codex recipe)', () => {
  it('surfaces URL and one-time code, then succeeds on the CLI’s own completion', async () => {
    process.env.MAT_CODEX_BIN = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    process.env.OPENAI_API_KEY = 'fixture-secret';
    const started = await startSignIn('codex');
    expect(started).toMatchObject({
      ok: true, mode: 'device',
      url: 'https://auth.openai.com/codex/device', userCode: 'JKB2-U3B4T',
    });
    expect(started.outputExcerpt).toContain('https://auth.openai.com/codex/device');
    expect(started.outputExcerpt).toContain('JKB2-U3B4T');
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'succeeded', statusDetail: 'key-present:no' });
    expect(started.outputExcerpt).toContain('key-present:no');
  }, 30_000);

  it('rejects pasted codes for device-mode sessions', async () => {
    const started = await startSignIn('codex');
    await expect(submitSignInCode(started.loginId!, 'ABCD-1234')).resolves.toMatchObject({ ok: false, error: SIGNIN_NOT_SUPPORTED });
  }, 30_000);
});

describe('session bookkeeping', () => {
  it('rejects providers without a recipe and unknown sessions', async () => {
    await expect(startSignIn('agy')).resolves.toEqual({ ok: false, error: SIGNIN_NOT_SUPPORTED });
    await expect(startSignIn('mock')).resolves.toEqual({ ok: false, error: SIGNIN_NOT_SUPPORTED });
    expect(signInStatus('nope')).toEqual({ phase: 'failed', error: SIGNIN_UNKNOWN_SESSION });
    await expect(submitSignInCode('nope', 'x')).resolves.toEqual({ ok: false, error: SIGNIN_UNKNOWN_SESSION });
    expect(cancelSignIn('nope')).toEqual({ ok: false, error: SIGNIN_UNKNOWN_SESSION });
  });
});

describe('recipe safety rails', () => {
  it('never surfaces an untrusted URL and kills the CLI when none arrives in time', async () => {
    const command = createFakeExecutable(binDir, 'device-untrusted', `
console.log('Open https://evil.attacker.example/device and enter the code ABCD-EFGH');
setInterval(() => undefined, 1000);
`);
    setSignInRecipeForTests('grok', { mode: 'device', command, args: [], trustedHosts: ['grok.com', 'x.ai'] });
    setSignInTimingForTests({ urlWaitMs: 400 });

    const started = await startSignIn('grok');
    expect(started.ok).toBe(false);
    expect(started.error).toBe(SIGNIN_NO_URL);
    expect(started.url).toBeUndefined();
    expect(started.outputExcerpt).toContain('<redacted-url>');
    expect(started.outputExcerpt).toContain('<redacted-code>');
    expect(started.outputExcerpt).not.toContain('evil.attacker.example');
    expect(started.outputExcerpt).not.toContain('ABCD-EFGH');
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'failed', error: SIGNIN_CANCELLED });
    expect(status.outputExcerpt).toContain('<redacted-url>');
    expect(status.url).toBeUndefined();
  }, 30_000);

  it('rejects plain-http URLs on a trusted host', async () => {
    const command = createFakeExecutable(binDir, 'device-http', `
console.log('Open http://grok.com/activate to continue');
setTimeout(() => process.exit(4), 150);
`);
    setSignInRecipeForTests('grok', { mode: 'device', command, args: [], trustedHosts: ['grok.com'] });
    const started = await startSignIn('grok');
    expect(started).toMatchObject({ ok: false, error: SIGNIN_NO_URL });
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'failed', error: signInExitError(4) });
  }, 30_000);

  it('accepts a subdomain of a trusted host and cancels a pending device ceremony', async () => {
    const command = createFakeExecutable(binDir, 'device-subdomain', `
console.log('Open https://login.grok.com/activate and enter the code WXYZ-1234');
setInterval(() => undefined, 1000);
`);
    setSignInRecipeForTests('grok', { mode: 'device', command, args: [], trustedHosts: ['grok.com'] });
    const started = await startSignIn('grok');
    expect(started).toMatchObject({ ok: true, url: 'https://login.grok.com/activate', userCode: 'WXYZ-1234' });

    expect(cancelSignIn(started.loginId!)).toEqual({ ok: true });
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'failed', error: SIGNIN_CANCELLED });
  }, 30_000);

  it('times the whole ceremony out below the device-code expiry', async () => {
    const command = createFakeExecutable(binDir, 'device-hang', `
console.log('Open https://grok.com/activate and enter the code HANG-CODE');
setInterval(() => undefined, 1000);
`);
    setSignInRecipeForTests('grok', { mode: 'device', command, args: [], trustedHosts: ['grok.com'] });
    setSignInTimingForTests({ sessionTimeoutMs: 500 });
    const started = await startSignIn('grok');
    expect(started.ok).toBe(true);
    const status = await settled(started.loginId!);
    expect(status).toMatchObject({ phase: 'failed', error: SIGNIN_TIMEOUT });
  }, 30_000);

  it('reports a spawn failure as a settled exit instead of hanging', async () => {
    setSignInRecipeForTests('grok', { mode: 'device', command: join(root, 'missing', 'no-such-cli'), args: [], trustedHosts: ['grok.com'] });
    const started = await startSignIn('grok');
    expect(started.ok).toBe(false);
    expect(started.loginId).toBeTruthy();
    const status = await settled(started.loginId!);
    expect(status.phase).toBe('failed');
  }, 30_000);

  it('releases the ceremony reservation when runtime resolution fails', async () => {
    process.env.MAT_CODEX_BIN = 'relative/codex';
    setSignInRecipeForTests('codex', { mode: 'device', family: 'codex', command: 'ignored', args: [], trustedHosts: ['openai.com'] });
    const failed = await startSignIn('codex');
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('absolute path');
    expect(isSignInActive()).toBe(false);
    delete process.env.MAT_CODEX_BIN;
    setSignInRecipeForTests('codex', {
      mode: 'device', command: process.execPath, args: ['-e', 'process.exit(0)'], trustedHosts: ['openai.com'],
    });
    const retry = await startSignIn('codex');
    expect(retry.ok).toBe(false);
    expect(retry.error).not.toBe(SIGNIN_BUSY);
    setSignInRecipeForTests('codex', undefined);
  }, 30_000);

  it('redacts environment values from the output excerpt', async () => {
    process.env.MAT_TEST_LEAK_MARKER = 'leak-canary-0123456789';
    const command = createFakeExecutable(binDir, 'device-leak', `
console.log('marker leak-canary-0123456789 at https://login.grok.com/activate');
setInterval(() => undefined, 1000);
`);
    setSignInRecipeForTests('grok', { mode: 'device', command, args: [], trustedHosts: ['grok.com'] });
    const started = await startSignIn('grok');
    expect(started.ok).toBe(true);
    expect(started.outputExcerpt).toContain('[REDACTED_ENV]');
    expect(started.outputExcerpt).not.toContain('leak-canary-0123456789');
    cancelSignIn(started.loginId!);
    await settled(started.loginId!);
  }, 30_000);
});
