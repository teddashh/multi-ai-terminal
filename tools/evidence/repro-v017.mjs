#!/usr/bin/env node
// v0.1.7 steering + debug-plane instrument (independent of repo tests).
// C: interrupt steer mid-stage → killed w/ partial patch, steer node verified,
//    deterministic redo (attempt 2, addendum carries steer outcome), review
//    decision on steer-1, diag categories present.
// D: queue steer at boundary (no kill, contextForNext into next stage) + a
//    trailing steer after the last stage → currentStageId restored to the real
//    stage (regression for the trailing-steer fix).
// E: debug bundle zip → manifest/run/events/diag/report/raw/artifacts present,
//    client-log lands in server-diag, /api/debug/server-log serves it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchWithTimeout,
  isolatedServerEnvironment,
  launchEvidenceServer,
} from './harness.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const REPO = process.env.MAT_REPO ?? REPO_ROOT;
const PORT = Number(process.env.MAT_PORT ?? 0);
let baseUrl;
const AdmZip = createRequire(join(REPO, 'server', 'package.json'))('adm-zip');
const failures = [];
const check = (name, ok, detail = '') => {
  failures.push(...(ok ? [] : [name + (detail ? ` — ${detail}` : '')]));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const api = async (path, init) => {
  if (!baseUrl) throw new Error(`cannot call ${path} before this server reports READY`);
  const response = await fetchWithTimeout(`${baseUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${response.status}: ${await response.text()}`);
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) return response.json();
  if (type.includes('zip')) return Buffer.from(await response.arrayBuffer());
  return response.text();
};

const gitWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mat-steer-evidence-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'evidence@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Evidence'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
  return dir;
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
const runIs = (runId, wanted) => async () => {
  const run = await api(`/api/runs/${runId}`);
  return wanted(run) ? run : undefined;
};

const stage = (over) => ({ join: 'all', timeoutSec: 60, stallSec: 30, gate: false, requireVerified: false, isolation: 'worktree', ...over });
const slot = (id, model, promptTemplate) => ({ id, label: id, agent: { provider: 'mock', model, permission: 'auto' }, count: 1, promptTemplate });

const dataDir = mkdtempSync(join(tmpdir(), 'mat-steer-evidence-data-'));
const wsC = gitWorkspace();
const wsD = gitWorkspace();
const harnessRoot = mkdtempSync(join(tmpdir(), 'mat-v017-harness-'));
let serverLog = '';
let server;

try {
  const env = isolatedServerEnvironment({ harnessRoot, dataDir, port: PORT });
  server = launchEvidenceServer({
    root: ROOT,
    env,
    onOutput: (text) => { serverLog += text; },
  });
  baseUrl = await server.ready;
  await api('/api/health');

  // ---------- Scenario C: interrupt steer ----------
  const workspaceC = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({
    name: 'Steer C', path: wsC, verifyCommand: 'node -e "process.exit(0)"',
  }) });
  const runC = await api('/api/runs', { method: 'POST', body: JSON.stringify({
    workspaceId: workspaceC.id, workflowId: 'planning', task: 'MOCK_WRITE:evidence-c.txt build the widget',
    workflowOverride: {
      schemaVersion: 1, id: 'steer-c', name: 'Steer C', description: '',
      orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'auto' }, gateTimeoutSec: 30 },
      stages: [stage({ id: 'build', name: 'Build', slots: [slot('writer', 'slow:250', 'MOCK_WRITE:evidence-c.txt\n{{task}} {{retry_addendum}}\nMOCK_REPLY: built')] })],
      maxParallel: 1, maxRetriesPerStage: 1,
    },
  }) });
  await waitFor(runIs(runC.runId, (run) => run.nodes[0]?.status === 'running'), 'C node running', 15_000);
  const steered = await api(`/api/runs/${runC.runId}/steer`, { method: 'POST', body: JSON.stringify({ text: 'pivot: rename the widget to gadget' }) });
  check('C: steer accepted with defaults', steered.steers?.[0]?.mode === 'interrupt' && steered.steers[0].status === 'pending');
  const doneC = await waitFor(runIs(runC.runId, (run) => run.status === 'done'), 'C run done', 60_000);
  const steerC = doneC.steers?.[0];
  check('C: steer reviewed', steerC?.status === 'reviewed', JSON.stringify(steerC));
  check('C: interruptedStageId is the build stage', steerC?.interruptedStageId === 'build');
  check('C: steerStageId assigned', steerC?.steerStageId === 'steer-1');
  const buildNode = doneC.nodes.find((node) => node.nodeRunId === 'build.writer.0');
  check('C: interrupted candidate redone (attempt 2, done)', buildNode?.status === 'done' && buildNode.attempt === 2, JSON.stringify({ status: buildNode?.status, attempt: buildNode?.attempt }));
  const steerNode = doneC.nodes.find((node) => node.nodeRunId === 'steer-1.agent.0');
  check('C: steer node executed and verified', steerNode?.status === 'done' && steerNode.verification?.status === 'passed', JSON.stringify(steerNode?.verification));
  const reviewC = doneC.gateDecisions.find((decision) => decision.stageId === 'steer-1');
  check('C: review decision is deterministic redo', reviewC?.action === 'retry' && reviewC.rationale.includes('deterministic redo'), reviewC?.rationale);
  check('C: currentStageId back on the real stage', doneC.currentStageId === 'build', doneC.currentStageId);
  const eventsC = await api(`/api/runs/${runC.runId}/events?afterSeq=0&limit=10000`);
  const attempt2Seed = eventsC.find((event) => event.nodeRunId === 'build.writer.0' && event.attempt === 2 && event.role === 'user');
  check(
    'C: redo prompt carries the steer outcome',
    attempt2Seed?.text?.includes('instruction was executed') === true && attempt2Seed.text.includes('pivot: rename the widget to gadget'),
    JSON.stringify(attempt2Seed?.text),
  );
  const killedEvent = eventsC.find((event) => event.nodeRunId === 'build.writer.0' && event.data?.detail === 'steer');
  check('C: kill lifecycle labeled steer', Boolean(killedEvent));
  const reportC = await api(`/api/runs/${runC.runId}/report`);
  check('C: report has Steering section with review', reportC.includes('## Steering') && reportC.includes('deterministic redo') && reportC.includes('1 steers'));
  const diagC = readFileSync(join(dataDir, 'runs', runC.runId, 'diag.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const cats = new Set(diagC.map((entry) => entry.cat));
  check('C: diag journal covers spawn/exit/steer/decision/stage/verify', ['spawn', 'exit', 'steer', 'decision', 'stage', 'verify-start', 'verify-result'].every((cat) => cats.has(cat)), [...cats].join(','));
  check('C: diag never logs env values', !diagC.some((entry) => JSON.stringify(entry).includes('LD_LIBRARY_PATH')));

  // ---------- Scenario D: queue steer + trailing steer ----------
  const workspaceD = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Steer D', path: wsD }) });
  const runD = await api('/api/runs', { method: 'POST', body: JSON.stringify({
    workspaceId: workspaceD.id, workflowId: 'planning', task: 'evidence scenario D',
    workflowOverride: {
      schemaVersion: 1, id: 'steer-d', name: 'Steer D', description: '',
      orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'auto' }, gateTimeoutSec: 30 },
      stages: [
        stage({ id: 'draft', name: 'Draft', isolation: 'none', slots: [slot('a', 'slow:200', '{{task}}\nMOCK_REPLY: drafted')] }),
        stage({ id: 'review', name: 'Review', isolation: 'none', slots: [slot('b', 'slow:200', 'Context: {{orchestrator_context}}\nMOCK_REPLY: reviewed')] }),
      ],
      maxParallel: 1, maxRetriesPerStage: 1,
    },
  }) });
  await waitFor(runIs(runD.runId, (run) => run.nodes.find((node) => node.nodeRunId === 'draft.a.0')?.status === 'running'), 'D draft running', 15_000);
  await api(`/api/runs/${runD.runId}/steer`, { method: 'POST', body: JSON.stringify({ text: 'also note the deadline', mode: 'queue' }) });
  await waitFor(runIs(runD.runId, (run) => run.nodes.find((node) => node.nodeRunId === 'review.b.0')?.status === 'running'), 'D review running', 30_000);
  await api(`/api/runs/${runD.runId}/steer`, { method: 'POST', body: JSON.stringify({ text: 'summarize for the changelog', mode: 'queue' }) });
  const doneD = await waitFor(runIs(runD.runId, (run) => run.status === 'done'), 'D run done', 60_000);
  const draftNode = doneD.nodes.find((node) => node.nodeRunId === 'draft.a.0');
  check('D: queue steer never killed the draft', draftNode?.status === 'done' && draftNode.attempt === 1);
  check('D: first steer reviewed at boundary', doneD.steers?.[0]?.status === 'reviewed' && doneD.steers[0].interruptedStageId === null, JSON.stringify(doneD.steers?.[0]));
  const eventsD = await api(`/api/runs/${runD.runId}/events?afterSeq=0&limit=10000`);
  const reviewSeed = eventsD.find((event) => event.nodeRunId === 'review.b.0' && event.role === 'user');
  check('D: steer context flows into the next stage', reviewSeed?.text?.includes('also note the deadline') === true);
  check('D: trailing steer reviewed too', doneD.steers?.[1]?.status === 'reviewed', JSON.stringify(doneD.steers?.[1]));
  check('D: trailing steer leaves currentStageId on the last real stage', doneD.currentStageId === 'review', doneD.currentStageId);
  check('D: run has two steer stages worth of decisions', ['steer-1', 'steer-2'].every((id) => doneD.gateDecisions.some((decision) => decision.stageId === id)));

  // ---------- Scenario E: debug bundle ----------
  await api('/api/client-log', { method: 'POST', body: JSON.stringify({ level: 'error', message: 'instrument synthetic client error', url: 'http://test/' }) });
  const zipBuffer = await api(`/api/runs/${runC.runId}/debug-bundle`);
  check('E: bundle is a zip', zipBuffer.length > 1024 && zipBuffer[0] === 0x50 && zipBuffer[1] === 0x4b, String(zipBuffer.length));
  const zipPath = join(dataDir, 'bundle.zip');
  writeFileSync(zipPath, zipBuffer);
  const zip = new AdmZip(zipPath);
  const names = zip.getEntries().map((entry) => entry.entryName);
  const has = (name) => names.some((candidate) => candidate === name || candidate.startsWith(name));
  check('E: bundle holds core files', ['manifest.json', 'run.json', 'events.jsonl', 'diag.jsonl', 'report.md'].every((name) => has(name)), names.join(','));
  check('E: bundle holds raw adapter output', has('raw/'));
  check('E: bundle holds artifacts (patch + verify log)', names.some((name) => name.endsWith('.patch')) && names.some((name) => name.endsWith('.verify.log')));
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  const healthVersion = (await api('/api/health')).version;
  check('E: manifest identifies the run and app', manifest.bundleVersion === 1 && manifest.runId === runC.runId && manifest.appVersion === healthVersion && typeof manifest.platform === 'string');
  check('E: manifest workspace has verify command', manifest.workspace?.verifyCommand?.includes('process.exit(0)') === true);
  const bundledRun = JSON.parse(zip.readAsText('run.json'));
  check('E: bundled run.json carries steers', bundledRun.steers?.length === 1 && bundledRun.steers[0].status === 'reviewed');
  check('E: bundled diag mentions steer transitions', zip.readAsText('diag.jsonl').includes('"cat":"steer"'));
  check('E: server-diag captured the client error', has('server-diag.jsonl') && zip.readAsText('server-diag.jsonl').includes('instrument synthetic client error'));
  const serverLogTail = await api('/api/debug/server-log');
  check('E: /api/debug/server-log serves the client error', String(serverLogTail).includes('instrument synthetic client error'));

  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECKS FAILED`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error('INSTRUMENT ERROR:', error);
  console.error(serverLog.slice(-2000));
  process.exitCode = 1;
} finally {
  try {
    await server?.stop();
  } catch (error) {
    console.error('INSTRUMENT CLEANUP ERROR:', error);
    process.exitCode = 1;
  }
  for (const dir of [dataDir, wsC, wsD, harnessRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error('INSTRUMENT CLEANUP ERROR:', error);
      process.exitCode = 1;
    }
  }
  if ([dataDir, wsC, wsD, harnessRoot].some((dir) => existsSync(dir))) {
    console.error('INSTRUMENT CLEANUP ERROR: a temporary directory remains');
    process.exitCode = 1;
  }
}
