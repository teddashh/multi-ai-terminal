#!/usr/bin/env node
// v0.1.9 auth-visibility instrument (independent of repo tests).
// H: providers contract — every real provider advertises a sign-in command
//    (the "where do I log in" discoverability), mock does not, and no alert
//    exists on a fresh boot.
// I: INV3 — a mock node emitting a textbook auth failure (MOCK_AUTHFAIL)
//    fails WITHOUT gaining errorReason or registering an auth alert, while
//    the CLI's own text stays intact in the event transcript and the report
//    still carries the failure line.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const PORT = Number(process.env.MAT_PORT ?? 7817);
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (name, ok, detail = '') => {
  failures.push(...(ok ? [] : [name + (detail ? ` — ${detail}` : '')]));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const api = async (path, init) => {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) } });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body };
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

const gitWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mat-v019-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'evidence@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Evidence'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
  return dir;
};

const dataDir = mkdtempSync(join(tmpdir(), 'mat-v019-data-'));
const ws = gitWorkspace();
const child = spawn(process.execPath, [join(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, MAT_PORT: String(PORT), MAT_DATA_DIR: dataDir, MAT_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

try {
  await waitFor(async () => { try { return (await api('/api/health')).status === 200 ? true : undefined; } catch { return undefined; } }, 'server health', 15_000);
  const expectVersion = process.env.MAT_EXPECT_VERSION ?? '0.1.9';
  const health = (await api('/api/health')).body;
  check(`H: server reports ${expectVersion}`, health.version === expectVersion, String(health.version));

  const providers = (await api('/api/providers')).body;
  const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]));
  const expectations = { codex: 'codex logout', claude: '/login', grok: 'device-code', agy: 'agy' };
  for (const [id, needle] of Object.entries(expectations)) {
    check(`H: ${id} advertises a sign-in command`, typeof byId[id]?.signInCommand === 'string' && byId[id].signInCommand.includes(needle), String(byId[id]?.signInCommand));
  }
  check('H: mock has no sign-in command', byId.mock?.signInCommand === undefined);
  check('H: fresh boot has no auth alerts', providers.every((provider) => provider.authAlert === undefined));

  const workspace = (await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'v019', path: ws }) })).body;
  const workflowOverride = {
    schemaVersion: 1, id: 'v019-auth', name: 'v019 auth', description: '',
    orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, gateTimeoutSec: 10 },
    stages: [{ id: 'authfail', name: 'authfail', join: 'all', timeoutSec: 60, stallSec: 30, gate: false, requireVerified: false, isolation: 'worktree',
      slots: [{ id: 'agent', label: 'agent', agent: { provider: 'mock', model: 'MOCK_AUTHFAIL', permission: 'auto' }, count: 1, promptTemplate: '{{task}}' }] }],
    maxParallel: 2, maxRetriesPerStage: 0,
  };
  const run = (await api('/api/runs', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id, workflowId: 'v019-auth', task: 'auth probe', workflowOverride }) })).body;
  const finished = await waitFor(async () => {
    const snapshot = (await api(`/api/runs/${run.runId}`)).body;
    return snapshot.status === 'failed' || snapshot.status === 'done' ? snapshot : undefined;
  }, 'authfail run terminal', 60_000);
  const node = finished.nodes.find((candidate) => candidate.nodeRunId === 'authfail.agent.0');
  check('I: MOCK_AUTHFAIL node fails', node?.status === 'failed', String(node?.status));
  check('I: mock stays exempt from auth reasons', node?.errorReason === undefined, String(node?.errorReason));
  const providersAfter = (await api('/api/providers')).body;
  check('I: mock gains no auth alert', providersAfter.find((provider) => provider.id === 'mock')?.authAlert === undefined);
  const events = (await api(`/api/runs/${run.runId}/events?limit=10000`)).body;
  check('I: CLI auth text intact in transcript', events.some((event) => typeof event.text === 'string' && event.text.includes('grok login --device-code')));
  const report = (await api(`/api/runs/${run.runId}/report`)).body;
  const reportText = typeof report === 'string' ? report : JSON.stringify(report);
  check('I: report carries the failure line', reportText.includes('Error:'), reportText.slice(0, 200));
} catch (error) {
  check('instrument completed', false, String(error?.stack ?? error));
  console.error('--- server log tail ---\n' + serverLog.slice(-2000));
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of [dataDir, ws]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES:\n${failures.join('\n')}`);
process.exit(failures.length === 0 ? 0 : 1);
