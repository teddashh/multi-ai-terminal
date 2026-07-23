#!/usr/bin/env node
// v0.1.8 provider-onboarding instrument (independent of repo tests).
// F: augmented PATH end-to-end — a fake HOME carries ~/.local/bin/agy; the
//    server must discover it (ok + stub version) without it being on PATH.
//    Providers contract: installable flags, manualCommand, failure detail.
//    Install endpoint guards: 409 for ok providers, 4xx for unknown ids —
//    never runs a real recipe.
// G: mock stays exempt from the same-provider spawn stagger (2-node stage
//    spawns < 1s apart) and a 0.1.8 run completes end-to-end.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const CURRENT_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.MAT_PORT ?? 0);
const REQUEST_TIMEOUT_MS = 10_000;
const failures = [];
let baseUrl;
const check = (name, ok, detail = '') => {
  failures.push(...(ok ? [] : [name + (detail ? ` — ${detail}` : '')]));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const api = async (path, init) => {
  if (!baseUrl) throw new Error(`cannot call ${path} before this server reports READY`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init?.headers ?? {}),
      },
    });
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await response.json() : await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

const waitFor = async (predicate, label, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
};

const closedChildren = new WeakSet();
const trackChild = (child) => {
  child.once('close', () => closedChildren.add(child));
  return child;
};
const signalProcessTree = (child, signal) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};
const waitForClose = (child, timeoutMs) => {
  if (closedChildren.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
};
const stopProcess = async (child, timeoutMs = 5_000) => {
  if (!child || closedChildren.has(child)) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForClose(child, timeoutMs)) return;
  signalProcessTree(child, 'SIGKILL');
  if (!await waitForClose(child, 2_000)) {
    throw new Error(`server process tree ${String(child.pid)} did not close after SIGKILL`);
  }
};

// A deliberately sparse PATH makes provider discovery independent of whichever
// real CLIs happen to be installed on the verifier machine. Git remains
// available for the worktree scenario; agy is discoverable only after MAT adds
// fake HOME/.local/bin, while grok deterministically fails its version probe.
const fakeHome = mkdtempSync(join(tmpdir(), 'mat-v018-home-'));
const isolatedBin = join(fakeHome, 'isolated-bin');
mkdirSync(isolatedBin, { recursive: true });
const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
symlinkSync(gitPath, join(isolatedBin, 'git'));
writeFileSync(join(isolatedBin, 'grok'), '#!/bin/sh\necho deterministic-grok-probe-failure >&2\nexit 7\n');
chmodSync(join(isolatedBin, 'grok'), 0o755);
const unavailableRuntime = join(isolatedBin, 'provider-unavailable');
writeFileSync(unavailableRuntime, '#!/bin/sh\necho deterministic-provider-unavailable >&2\nexit 7\n');
chmodSync(unavailableRuntime, 0o755);
mkdirSync(join(fakeHome, '.local', 'bin'), { recursive: true });
writeFileSync(join(fakeHome, '.local', 'bin', 'agy'), '#!/bin/sh\necho agy-stub/9.9.9\n');
chmodSync(join(fakeHome, '.local', 'bin', 'agy'), 0o755);
writeFileSync(join(fakeHome, '.gitconfig'), '[user]\n\tname = Evidence\n\temail = evidence@example.test\n');

const gitWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mat-v018-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'evidence@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Evidence'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
  return dir;
};

const dataDir = mkdtempSync(join(tmpdir(), 'mat-v018-data-'));
const ws = gitWorkspace();
const childEnv = {
  HOME: fakeHome,
  CODEX_HOME: join(fakeHome, 'codex-home'),
  PATH: isolatedBin,
  MAT_PORT: String(PORT),
  MAT_DATA_DIR: dataDir,
  MAT_HOST: '127.0.0.1',
  MAT_SELF_PROVISION: '0',
  MAT_CLAUDE_BIN: unavailableRuntime,
  MAT_CODEX_BIN: unavailableRuntime,
  MAT_NODE_BIN: process.execPath,
};
// This allowlist keeps provider evidence deterministic even when the verifier
// shell has real credentials, runtime overrides, proxies, or NODE_OPTIONS.
let child;
let serverLog = '';
const startServer = async () => {
  baseUrl = undefined;
  child = trackChild(spawn(process.execPath, [join(ROOT, 'server/dist/index.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  }));
  let stdout = '';
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(
      `server exited before READY (${signal ? `signal ${signal}` : `code ${String(code)}`})`,
    ));
    const timer = setTimeout(() => finish(new Error('timeout waiting for this server child READY marker')), 15_000);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      serverLog += text;
      const marker = /\[MAT_AGENT\] READY url=(http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (marker) finish(undefined, marker[1]);
    });
    child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  });
  const readyUrl = await ready;
  baseUrl = readyUrl.replace(/\/$/, '');
};

try {
  await startServer();
  const health = (await api('/api/health')).body;
  const expectVersion = process.env.MAT_EXPECT_VERSION ?? CURRENT_VERSION;
  check(`F: server reports ${expectVersion}`, health.version === expectVersion, String(health.version));

  const providers = (await api('/api/providers')).body;
  const expectedProviderIds = ['agy', 'claude', 'codex', 'grok', 'mock', 'openrouter'];
  const actualProviderIds = Array.isArray(providers)
    ? providers.map((provider) => provider.id).sort()
    : [];
  check(
    'F: exact six-provider set listed',
    JSON.stringify(actualProviderIds) === JSON.stringify(expectedProviderIds),
    JSON.stringify(actualProviderIds),
  );
  const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]));
  check('F: every provider carries installable flag', providers.every((provider) => typeof provider.installable === 'boolean'));
  check('F: agy discovered through augmented PATH', byId.agy?.ok === true, JSON.stringify({ ok: byId.agy?.ok, detail: byId.agy?.detail }));
  check('F: agy version comes from the fake-HOME stub', byId.agy?.version === 'agy-stub/9.9.9', String(byId.agy?.version));
  check('F: npm providers are installable', ['claude', 'codex', 'grok'].every((id) => byId[id]?.installable === true));
  check('F: mock is not installable', byId.mock?.installable === false);
  check('F: OpenRouter has no separate installer', byId.openrouter?.installable === false, JSON.stringify(byId.openrouter));
  check('F: OpenRouter reuses the codex runtime family', byId.openrouter?.runtimeFamily === 'codex', String(byId.openrouter?.runtimeFamily));
  check(
    'F: OpenRouter reports an unconfigured environment credential without its value',
    byId.openrouter?.environmentCredential?.name === 'OPENROUTER_API_KEY'
      && byId.openrouter.environmentCredential.configured === false,
    JSON.stringify(byId.openrouter?.environmentCredential),
  );
  check('F: OpenRouter advertises no CLI sign-in command', byId.openrouter?.signInCommand === undefined, String(byId.openrouter?.signInCommand));
  check('F: grok failure stub returns a probe detail', byId.grok?.ok === false && typeof byId.grok?.detail === 'string' && byId.grok.detail.includes('deterministic-grok-probe-failure'), JSON.stringify({ ok: byId.grok?.ok, detail: byId.grok?.detail }));

  const agyInstall = await api('/api/providers/agy/install', { method: 'POST' });
  check('F: installing an available provider is rejected', agyInstall.status === 409, String(agyInstall.status));
  const mockInstall = await api('/api/providers/mock/install', { method: 'POST' });
  check('F: mock install is rejected', mockInstall.status === 409, String(mockInstall.status));
  const unknownInstall = await api('/api/providers/nonsense/install', { method: 'POST' });
  check('F: unknown provider install is a client error', unknownInstall.status >= 400 && unknownInstall.status < 500, String(unknownInstall.status));

  const serverDiag = readFileSync(join(dataDir, 'logs', 'server-diag.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const grokProbe = serverDiag.find((line) => line.cat === 'probe' && line.command === 'grok');
  check('F: probe diag carries failure detail', grokProbe !== undefined && grokProbe.ok === false && typeof grokProbe.detail === 'string', JSON.stringify(grokProbe));
  const agyProbe = serverDiag.find((line) => line.cat === 'probe' && line.command === 'agy');
  check('F: probe diag records the stub version', agyProbe?.ok === true && agyProbe?.version === 'agy-stub/9.9.9', JSON.stringify(agyProbe));

  const workspace = (await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'v018', path: ws }) })).body;
  const workflowOverride = {
    schemaVersion: 1, id: 'v018-stagger', name: 'v018 stagger', description: '',
    orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, gateTimeoutSec: 10 },
    stages: [{ id: 'pair', name: 'pair', join: 'all', timeoutSec: 60, stallSec: 30, gate: false, requireVerified: false, isolation: 'worktree',
      slots: [{ id: 'agent', label: 'agent', agent: { provider: 'mock', model: 'ok', permission: 'auto' }, count: 2, promptTemplate: '{{task}}' }] }],
    maxParallel: 4, maxRetriesPerStage: 0,
  };
  const run = (await api('/api/runs', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id, workflowId: 'v018-stagger', task: 'MOCK_REPLY: stagger probe', workflowOverride }) })).body;
  const done = await waitFor(async () => {
    const snapshot = (await api(`/api/runs/${run.runId}`)).body;
    return snapshot.status === 'done' ? snapshot : undefined;
  }, 'stagger run done', 60_000);
  check('G: two-node mock run completes', done.nodes.filter((node) => node.status === 'done').length === 2);
  const runDiag = readFileSync(join(dataDir, 'runs', run.runId, 'diag.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const spawns = runDiag.filter((line) => line.cat === 'spawn').map((line) => line.ts).sort((a, b) => a - b);
  check('G: mock spawns are not staggered', spawns.length === 2 && spawns[1] - spawns[0] < 1000, `delta ${spawns.length === 2 ? spawns[1] - spawns[0] : 'n/a'}ms`);
} catch (error) {
  check('instrument completed', false, String(error?.stack ?? error));
  console.error('--- server log tail ---\n' + serverLog.slice(-2000));
} finally {
  try {
    await stopProcess(child);
  } catch (error) {
    check('F: server process tree closes', false, String(error?.message ?? error));
  }
  for (const dir of [dataDir, ws, fakeHome]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      check('F: temporary evidence directories are removed', false, String(error?.message ?? error));
    }
  }
  if ([dataDir, ws, fakeHome].some((dir) => existsSync(dir))) {
    check('F: temporary evidence directories are removed', false);
  }
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES:\n${failures.join('\n')}`);
process.exit(failures.length === 0 ? 0 : 1);
