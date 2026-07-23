import { randomUUID } from 'node:crypto';
import type { ProviderId, ProviderSignInCodeResponse, ProviderSignInMode, ProviderSignInStartResponse, ProviderSignInStatusResponse } from '@mat/shared';
import { diag } from '../diag.js';
import { redactEnvironmentValues } from '../redact.js';
import { resolveRuntimeBinary, runtimeBinaryForSpawn } from '../runtime/resolve.js';
import { spawnManaged, type ManagedProcess } from '../spawn.js';
import { getDataDir } from '../store/dataDir.js';
import { clearAuthAlert } from './auth.js';
import { captureCurrent, markActiveValid } from './codex/accounts.js';
import { codexSessionRuntime } from './codex/runtime.js';

// In-app sign-in drives each CLI's own login flow over piped stdio — the BAT
// (better-agent-terminal) pattern. MAT spawns a fixed recipe, surfaces the
// sign-in URL (and device code) the CLI prints, and either forwards the pasted
// callback code to the CLI's stdin (paste-code mode) or waits for the CLI's own
// polling to finish (device mode). The CLI performs the OAuth exchange and owns
// its OAuth exchange. MAT snapshots only Codex auth.json at the documented
// account-store hooks and never logs the URL, code, CLI output, or credentials.

export interface SignInRecipe {
  mode: ProviderSignInMode;
  command: string;
  family?: 'claude' | 'codex';
  args: string[];
  trustedHosts: string[];
  unsetEnv?: string[];
  /** The CLI discards any existing login as soon as this flow starts. */
  replacesExistingLogin?: boolean;
  statusProbe?: { command: string; args: string[]; loggedInPattern?: RegExp };
}

// Grounded against the real CLIs: `claude auth login` prints an OAuth URL over
// piped stdio (hosted redirect) and then waits for the pasted callback code;
// `codex login --device-auth` prints auth.openai.com/codex/device plus a
// one-time code and polls by itself — and it clears the existing login the
// moment it starts. `grok login --device-code` is xAI's documented headless
// flow with the same device shape.
const recipes: Partial<Record<ProviderId, SignInRecipe>> = {
  claude: {
    mode: 'paste-code',
    command: 'claude', args: ['auth', 'login'],
    family: 'claude',
    trustedHosts: ['claude.ai', 'claude.com', 'anthropic.com'],
    statusProbe: { command: 'claude', args: ['auth', 'status'], loggedInPattern: /"loggedIn"\s*:\s*true/ },
  },
  codex: {
    mode: 'device',
    command: 'codex', args: ['login', '--device-auth'],
    family: 'codex',
    trustedHosts: ['openai.com', 'chatgpt.com'],
    unsetEnv: ['OPENAI_API_KEY'],
    replacesExistingLogin: true,
    statusProbe: { command: 'codex', args: ['login', 'status'] },
  },
  grok: {
    mode: 'device',
    command: 'grok', args: ['login', '--device-code'],
    trustedHosts: ['x.ai', 'grok.com'],
  },
};

export const SIGNIN_BUSY = 'Another sign-in is already in progress.';
export const SIGNIN_RUNTIME_BUSY = 'Cannot sign in to codex while a turn is running.';
export const SIGNIN_NOT_SUPPORTED = 'In-app sign-in is not available for this provider.';
export const SIGNIN_NO_URL = 'The sign-in command did not produce a login URL.';
export const SIGNIN_CANCELLED = 'The sign-in was cancelled.';
export const SIGNIN_REJECTED = 'The CLI rejected the sign-in.';
export const SIGNIN_TIMEOUT = 'The sign-in timed out before completing.';
export const SIGNIN_NOT_VERIFIED = 'The CLI still reports it is not signed in.';
export const SIGNIN_VERIFIED = 'Signed in.';
export const SIGNIN_UNKNOWN_SESSION = 'Unknown sign-in session.';
export function signInExitError(code: number | null): string {
  return `The sign-in ended with exit ${code === null ? 'null' : String(code)} before completing.`;
}

const URL_WAIT_MS = 60_000;
// codex device codes expire after 15 minutes; cap the whole ceremony below that.
const SESSION_TIMEOUT_MS = 10 * 60_000;
let urlWaitMs = URL_WAIT_MS;
let sessionTimeoutMs = SESSION_TIMEOUT_MS;
const STATUS_PROBE_TIMEOUT_MS = 10_000;
const TERMINAL_RETENTION_MS = 10 * 60_000;
const OUTPUT_TAIL_MAX = 8192;
const EXCERPT_MAX = 800;
// Output phrases that mean the login failed even on a clean exit (BAT's list).
const FAILURE_RE = /\b(error|invalid|disabled|does not have access|denied|failed|not authorized|unauthorized)\b/i;
const USER_CODE_RE = /\b([A-Z0-9]{4,10}-[A-Z0-9]{4,10})\b/;

interface SignInSession {
  loginId: string;
  providerId: ProviderId;
  mode: ProviderSignInMode;
  managed?: ManagedProcess;
  output: string;
  url?: string;
  userCode?: string;
  finished: boolean;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  codeSubmitted: boolean;
  /** Set once the exit result and any status probe have both settled. */
  terminal?: { ok: boolean; statusDetail?: string; error?: string };
  urlWaiters: Array<() => void>;
  settleWaiters: Array<() => void>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
}

let activeSession: SignInSession | undefined;
const sessions = new Map<string, SignInSession>();
const testRecipes = new Map<ProviderId, SignInRecipe>();

function recipeFor(providerId: ProviderId): SignInRecipe | undefined {
  return testRecipes.get(providerId) ?? recipes[providerId];
}

function stripAnsi(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function isTrustedUrl(value: string, trustedHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    return trustedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function scanOutput(session: SignInSession, recipe: SignInRecipe): void {
  if (!session.url) {
    for (const match of session.output.matchAll(/https?:\/\/[^\s'"()[\]]+/g)) {
      const candidate = match[0].replace(/[.,;]+$/, '');
      if (isTrustedUrl(candidate, recipe.trustedHosts)) {
        session.url = candidate;
        break;
      }
    }
    if (session.url) for (const waiter of session.urlWaiters.splice(0)) waiter();
  }
  if (!session.userCode && session.mode === 'device') {
    const withoutUrls = session.output.replace(/https?:\/\/\S+/g, ' ');
    const code = USER_CODE_RE.exec(withoutUrls)?.[1];
    if (code) session.userCode = code;
  }
}

function outputExcerpt(session: SignInSession): string {
  return redactEnvironmentValues(session.output.slice(-EXCERPT_MAX).trim());
}

function sanitizeFailureExcerpt(text: string): string {
  return redactEnvironmentValues(text)
    .replace(/\b[A-Z0-9]{4,10}-[A-Z0-9]{4,10}\b/g, '<redacted-code>')
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(-600);
}

async function commandForRecipe(recipe: SignInRecipe, command: string): Promise<string> {
  if (!recipe.family) return command;
  return (await resolveRuntimeBinary(getDataDir(), recipe.family))
    ?? runtimeBinaryForSpawn(getDataDir(), recipe.family);
}

function retireLater(session: SignInSession): void {
  session.retentionTimer = setTimeout(() => {
    sessions.delete(session.loginId);
  }, TERMINAL_RETENTION_MS);
  session.retentionTimer.unref();
}

async function runStatusProbe(recipe: SignInRecipe): Promise<{ verified: boolean; statusDetail?: string }> {
  const probe = recipe.statusProbe;
  if (!probe) return { verified: true };
  let command: string;
  try {
    command = await commandForRecipe(recipe, probe.command);
  } catch {
    return { verified: false };
  }
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (verified: boolean): void => {
      if (settled) return;
      settled = true;
      const stripped = stripAnsi(output);
      const firstLine = stripped.split(/\r?\n/, 1)[0]?.trim().slice(0, 120);
      // claude's status output is a JSON document; a raw brace line is not a
      // human status, so fall back to the canonical verified sentence.
      const detail = verified ? (firstLine && !firstLine.startsWith('{') ? firstLine : SIGNIN_VERIFIED) : undefined;
      resolve({ verified, ...(detail ? { statusDetail: detail } : {}) });
    };
    let managed: ManagedProcess;
    try {
      managed = spawnManaged({
        command, args: probe.args, cwd: process.cwd(),
        env: { TERM: 'dumb' }, timeoutMs: STATUS_PROBE_TIMEOUT_MS,
        ...(recipe.unsetEnv ? { unsetEnv: recipe.unsetEnv } : {}),
        onTimeout: () => finish(false),
      });
    } catch {
      finish(false);
      return;
    }
    managed.child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    managed.child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    managed.child.once('error', () => finish(false));
    managed.child.once('exit', (code) => {
      const ok = code === 0 && (probe.loggedInPattern ? probe.loggedInPattern.test(stripAnsi(output)) : true);
      // Give the last output chunk one tick to arrive before reading it.
      setTimeout(() => finish(ok), 50);
    });
  });
}

async function settleSession(session: SignInSession, recipe: SignInRecipe): Promise<void> {
  let result: { ok: boolean; statusDetail?: string; error?: string };
  const failureInOutput = FAILURE_RE.test(session.output);
  if (session.cancelled) result = { ok: false, error: SIGNIN_CANCELLED };
  else if (session.timedOut) result = { ok: false, error: SIGNIN_TIMEOUT };
  else if (session.exitCode === 0 && !failureInOutput) {
    const status = await runStatusProbe(recipe);
    result = status.verified
      ? { ok: true, ...(status.statusDetail ? { statusDetail: status.statusDetail } : {}) }
      : { ok: false, error: SIGNIN_NOT_VERIFIED };
  } else if (session.exitCode === 0) result = { ok: false, error: SIGNIN_REJECTED };
  else result = { ok: false, error: failureInOutput ? SIGNIN_REJECTED : signInExitError(session.exitCode) };

  if (result.ok) {
    clearAuthAlert(session.providerId);
    if (session.providerId === 'codex') {
      try { captureCurrent(); markActiveValid(); } catch { /* best effort */ }
      void codexSessionRuntime().recycleForAccountChange().catch(() => undefined);
    }
  }
  session.terminal = result;
  if (activeSession === session) activeSession = undefined;
  diag(null, 'signin', {
    providerId: session.providerId, ok: result.ok, exitCode: session.exitCode,
    cancelled: session.cancelled, timedOut: session.timedOut,
    durationMs: Math.max(0, Date.now() - session.startedAt),
  });
  retireLater(session);
  for (const waiter of session.settleWaiters.splice(0)) waiter();
}

export function providerSignInDescriptor(providerId: ProviderId): { mode: ProviderSignInMode; replacesExistingLogin?: boolean } | undefined {
  const recipe = recipeFor(providerId);
  if (!recipe) return undefined;
  return { mode: recipe.mode, ...(recipe.replacesExistingLogin ? { replacesExistingLogin: true } : {}) };
}

export async function startSignIn(providerId: ProviderId): Promise<ProviderSignInStartResponse> {
  const recipe = recipeFor(providerId);
  if (!recipe) return { ok: false, error: SIGNIN_NOT_SUPPORTED };
  // Credential stores are host-global; never let a second sign-in silently
  // supersede one that is mid-ceremony.
  if (activeSession) return { ok: false, error: SIGNIN_BUSY };
  // `codex login --device-auth` discards the live login at flow start and the
  // completion recycle would drop the app-server mid-turn — refuse like BAT.
  if (providerId === 'codex' && codexSessionRuntime().busy()) return { ok: false, error: SIGNIN_RUNTIME_BUSY };

  const session: SignInSession = {
    loginId: randomUUID(), providerId, mode: recipe.mode,
    output: '', finished: false, exitCode: null,
    cancelled: false, timedOut: false, codeSubmitted: false,
    urlWaiters: [], settleWaiters: [], startedAt: Date.now(),
  };
  // Reserve the ceremony synchronously: the awaits below (runtime resolution)
  // must not open a window where a second sign-in or a concurrent account
  // mutation observes no active session.
  activeSession = session;
  sessions.set(session.loginId, session);
  if (providerId === 'codex') {
    try { captureCurrent(); } catch { /* a missing outgoing auth.json is expected */ }
  }
  try {
    const command = await commandForRecipe(recipe, recipe.command);
    session.managed = spawnManaged({
      command, args: recipe.args, cwd: process.cwd(),
      stdinOpen: recipe.mode === 'paste-code',
      env: { TERM: 'dumb' },
      ...(recipe.unsetEnv ? { unsetEnv: recipe.unsetEnv } : {}),
      timeoutMs: sessionTimeoutMs,
      onTimeout: () => { session.timedOut = true; },
    });
  } catch (error) {
    if (activeSession === session) activeSession = undefined;
    sessions.delete(session.loginId);
    return { ok: false, error: redactEnvironmentValues(error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }

  const child = session.managed.child;
  const onChunk = (chunk: Buffer): void => {
    session.output = (session.output + stripAnsi(chunk.toString('utf8'))).slice(-OUTPUT_TAIL_MAX);
    scanOutput(session, recipe);
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.once('error', () => {
    session.finished = true;
    for (const waiter of session.urlWaiters.splice(0)) waiter();
    void settleSession(session, recipe);
  });
  child.once('exit', (code) => {
    session.finished = true;
    session.exitCode = typeof code === 'number' ? code : null;
    for (const waiter of session.urlWaiters.splice(0)) waiter();
    // Give trailing output one tick to arrive before judging failure phrases.
    setTimeout(() => { void settleSession(session, recipe); }, 50).unref();
  });

  await new Promise<void>((resolve) => {
    if (session.url || session.finished) { resolve(); return; }
    const timer = setTimeout(resolve, urlWaitMs);
    timer.unref();
    session.urlWaiters.push(() => { clearTimeout(timer); resolve(); });
  });

  if (!session.url) {
    if (!session.finished) {
      session.cancelled = true;
      session.managed.killGroup();
    }
    const error = session.terminal?.error ?? SIGNIN_NO_URL;
    return { ok: false, loginId: session.loginId, error, outputExcerpt: sanitizeFailureExcerpt(session.output) };
  }
  return {
    ok: true, loginId: session.loginId, mode: session.mode, url: session.url,
    ...(session.userCode ? { userCode: session.userCode } : {}),
    outputExcerpt: outputExcerpt(session),
  };
}

export function isSignInActive(): boolean {
  return activeSession !== undefined;
}

export function activeSignInProvider(): ProviderId | undefined {
  return activeSession?.providerId;
}

export function signInStatus(loginId: string): ProviderSignInStatusResponse {
  const session = sessions.get(loginId);
  if (!session) return { phase: 'failed', error: SIGNIN_UNKNOWN_SESSION };
  const base = {
    ...(session.url ? { url: session.url } : {}),
    ...(session.userCode ? { userCode: session.userCode } : {}),
  };
  if (!session.terminal) return { phase: 'pending', ...base, outputExcerpt: outputExcerpt(session) };
  return session.terminal.ok
    ? { phase: 'succeeded', ...base, outputExcerpt: outputExcerpt(session), ...(session.terminal.statusDetail ? { statusDetail: session.terminal.statusDetail } : {}) }
    : { phase: 'failed', ...base, outputExcerpt: sanitizeFailureExcerpt(session.output), ...(session.terminal.error ? { error: session.terminal.error } : {}) };
}

export async function submitSignInCode(loginId: string, code: string): Promise<ProviderSignInCodeResponse> {
  const session = sessions.get(loginId);
  if (!session) return { ok: false, error: SIGNIN_UNKNOWN_SESSION };
  if (session.mode !== 'paste-code') return { ok: false, error: SIGNIN_NOT_SUPPORTED };
  if (!session.terminal && !session.finished && !session.codeSubmitted) {
    session.codeSubmitted = true;
    try {
      session.managed?.child.stdin?.write(`${code.trim()}\n`);
    } catch {
      // The exit handler reports the definitive failure.
    }
  }
  await new Promise<void>((resolve) => {
    if (session.terminal) { resolve(); return; }
    const timer = setTimeout(resolve, sessionTimeoutMs);
    timer.unref();
    session.settleWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
  const terminal = session.terminal ?? { ok: false, error: SIGNIN_TIMEOUT };
  return terminal.ok
    ? { ok: true, ...(terminal.statusDetail ? { statusDetail: terminal.statusDetail } : {}), outputExcerpt: outputExcerpt(session) }
    : { ok: false, ...(terminal.error ? { error: terminal.error } : {}), outputExcerpt: sanitizeFailureExcerpt(session.output) };
}

export function cancelSignIn(loginId: string): { ok: boolean; error?: string } {
  const session = sessions.get(loginId);
  if (!session) return { ok: false, error: SIGNIN_UNKNOWN_SESSION };
  if (!session.terminal && !session.finished) {
    session.cancelled = true;
    session.managed?.killGroup();
  }
  return { ok: true };
}

export function setSignInRecipeForTests(providerId: ProviderId, recipe?: SignInRecipe): void {
  if (recipe) testRecipes.set(providerId, recipe);
  else testRecipes.delete(providerId);
}

export function setSignInTimingForTests(overrides?: { urlWaitMs?: number; sessionTimeoutMs?: number }): void {
  urlWaitMs = overrides?.urlWaitMs ?? URL_WAIT_MS;
  sessionTimeoutMs = overrides?.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
}

export function resetSignInForTests(): void {
  for (const session of sessions.values()) {
    if (session.retentionTimer) clearTimeout(session.retentionTimer);
    if (!session.finished) {
      session.cancelled = true;
      session.managed?.killGroup('SIGKILL');
    }
  }
  sessions.clear();
  activeSession = undefined;
  testRecipes.clear();
  urlWaitMs = URL_WAIT_MS;
  sessionTimeoutMs = SESSION_TIMEOUT_MS;
}
