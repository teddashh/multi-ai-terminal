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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const PORT = Number(process.env.MAT_PORT ?? 7816);
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

// Fake HOME with an agy stub in ~/.local/bin — NOT on the inherited PATH.
const fakeHome = mkdtempSync(join(tmpdir(), 'mat-v018-home-'));
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
const child = spawn(process.execPath, [join(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, HOME: fakeHome, MAT_PORT: String(PORT), MAT_DATA_DIR: dataDir, MAT_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

try {
  await waitFor(async () => { try { return (await api('/api/health')).status === 200 ? true : undefined; } catch { return undefined; } }, 'server health', 15_000);
  const health = (await api('/api/health')).body;
  const expectVersion = process.env.MAT_EXPECT_VERSION ?? '0.1.8';
  check(`F: server reports ${expectVersion}`, health.version === expectVersion, String(health.version));

  const providers = (await api('/api/providers')).body;
  check('F: five providers listed', Array.isArray(providers) && providers.length === 5, String(providers.length));
  const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]));
  check('F: every provider carries installable flag', providers.every((provider) => typeof provider.installable === 'boolean'));
  check('F: agy discovered through augmented PATH', byId.agy?.ok === true, JSON.stringify({ ok: byId.agy?.ok, detail: byId.agy?.detail }));
  check('F: agy version comes from the fake-HOME stub', byId.agy?.version === 'agy-stub/9.9.9', String(byId.agy?.version));
  check('F: npm providers are installable', ['claude', 'codex', 'grok'].every((id) => byId[id]?.installable === true));
  check('F: mock is not installable', byId.mock?.installable === false);
  check('F: grok unavailable here with a failure detail', byId.grok?.ok === false && typeof byId.grok?.detail === 'string' && byId.grok.detail.length > 0, JSON.stringify({ ok: byId.grok?.ok, detail: byId.grok?.detail }));

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
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of [dataDir, ws, fakeHome]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } }
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES:\n${failures.join('\n')}`);
process.exit(failures.length === 0 ? 0 : 1);
