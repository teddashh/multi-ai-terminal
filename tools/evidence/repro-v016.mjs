#!/usr/bin/env node
// Evidence-plane end-to-end instrument (independent of the repo's own tests).
// Scenario A: 2-stage run in a git workspace with passing verifyCommand →
//   stage1 node verified 'passed', stage2 node handoff.priorNodeRunIds = [stage1],
//   report contains Outcome/verified/handoff lines, verify.log artifact exists.
// Scenario B: run with failing verifyCommand + requireVerified + mock orchestrator
//   (mock can't emit valid gate JSON → degraded advance) → engine must convert
//   advance→retry on evidence ('[engine] requireVerified' rationale), rerun the
//   candidate (attempt 2), then exhaust budget → honest degraded advance; node
//   verification 'failed' with the boom marker in outputTail.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const PORT = Number(process.env.MAT_PORT ?? 7813);
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (name, ok, detail = '') => {
  failures.push(...(ok ? [] : [name + (detail ? ` — ${detail}` : '')]));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const api = async (path, init) => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${response.status}: ${await response.text()}`);
  const type = response.headers.get('content-type') ?? '';
  return type.includes('json') ? response.json() : response.text();
};

const gitWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mat-evidence-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'evidence@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Evidence'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
  return dir;
};

const waitRun = async (runId, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = await api(`/api/runs/${runId}`);
    if (['done', 'failed', 'aborted'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run ${runId} still ${run?.status} after ${timeoutMs}ms`);
};

const stage = (over) => ({
  join: 'all', timeoutSec: 120, stallSec: 60, gate: true, requireVerified: false, isolation: 'none', ...over,
});
const mockSlot = (id, promptTemplate) => ({ id, label: id, agent: { provider: 'mock', model: 'ok', permission: 'auto' }, count: 1, promptTemplate });

const dataDir = mkdtempSync(join(tmpdir(), 'mat-evidence-data-'));
const wsA = gitWorkspace();
const wsB = gitWorkspace();
const child = spawn(process.execPath, [join(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, MAT_PORT: String(PORT), MAT_DATA_DIR: dataDir, MAT_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

try {
  const ready = Date.now() + 15_000;
  for (;;) {
    try { await api('/api/health'); break; }
    catch { if (Date.now() > ready) throw new Error(`server never became healthy\n${serverLog}`); await new Promise((r) => setTimeout(r, 200)); }
  }

  // ---------- Scenario A ----------
  const workspaceA = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({
    name: 'Evidence A', path: wsA, verifyCommand: 'node -e "process.exit(0)"',
  }) });
  const runA = await api('/api/runs', { method: 'POST', body: JSON.stringify({
    workspaceId: workspaceA.id, workflowId: 'planning', task: 'evidence scenario A',
    workflowOverride: {
      schemaVersion: 1, id: 'evidence-a', name: 'Evidence A', description: '',
      orchestrator: { enabled: false, agent: { provider: 'mock', model: 'ok', permission: 'auto' }, gateTimeoutSec: 60 },
      stages: [
        stage({ id: 's1', name: 'Implement', isolation: 'worktree', gate: false, slots: [mockSlot('writer', 'MOCK_WRITE:evidence-a.txt\nMOCK_REPLY: implemented')] }),
        stage({ id: 's2', name: 'Review', gate: false, slots: [mockSlot('reviewer', 'Digest: {{prior_stage_digest}}\nPatches: {{patches}}\nMOCK_REPLY: reviewed')] }),
      ],
      maxParallel: 2, maxRetriesPerStage: 1,
    },
  }) });
  const doneA = await waitRun(runA.runId);
  check('A: run done', doneA.status === 'done', doneA.status);
  const s1 = doneA.nodes.find((node) => node.stageId === 's1');
  const s2 = doneA.nodes.find((node) => node.stageId === 's2');
  check('A: stage1 verification passed', s1?.verification?.status === 'passed', JSON.stringify(s1?.verification));
  check('A: verification command recorded', s1?.verification?.command?.includes('process.exit(0)') === true);
  check('A: verify.log artifact exists', Boolean(s1?.verification?.logFile) && existsSync(s1.verification.logFile), s1?.verification?.logFile);
  check('A: providerVersions snapshot has mock', doneA.providerVersions?.mock === 'mock/0', JSON.stringify(doneA.providerVersions));
  check('A: stage2 handoff lists stage1 node', Array.isArray(s2?.handoff?.priorNodeRunIds) && s2.handoff.priorNodeRunIds.length === 1 && s2.handoff.priorNodeRunIds[0] === s1.nodeRunId, JSON.stringify(s2?.handoff));
  const patchText = s1?.patchFile && existsSync(s1.patchFile) ? readFileSync(s1.patchFile, 'utf8') : '';
  check('A: candidate patch contains written file', patchText.includes('evidence-a.txt'));
  const reportA = await api(`/api/runs/${runA.runId}/report`);
  check('A: report has Outcome section', reportA.includes('## Outcome'));
  check('A: report counts 1 verified', /1 candidates generated · 1 verified · 0 failed checks/.test(reportA), reportA.split('\n').find((line) => line.includes('candidates generated')));
  check('A: report shows handoff arrow', reportA.includes(`Handoff: ← ${s1.nodeRunId}`));
  const eventsA = await api(`/api/runs/${runA.runId}/events?afterSeq=0&limit=2000`);
  const verifyEvents = eventsA.filter((event) => event.data?.detail === 'verify-result');
  check('A: exactly one verify-result event (stage2 unconfigured-silent? no: stage2 not worktree → absent)', verifyEvents.length === 1, String(verifyEvents.length));
  check('A: verify event says passed', verifyEvents[0]?.text?.startsWith('Verification passed'), verifyEvents[0]?.text);
  check('A: stage2 has no verification (not isolated)', s2?.verification === undefined, JSON.stringify(s2?.verification));

  // ---------- Scenario B ----------
  const workspaceB = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({
    name: 'Evidence B', path: wsB, verifyCommand: 'node -e "console.error(\'boom marker 42\'); process.exit(1)"',
  }) });
  const runB = await api('/api/runs', { method: 'POST', body: JSON.stringify({
    workspaceId: workspaceB.id, workflowId: 'planning', task: 'evidence scenario B',
    workflowOverride: {
      schemaVersion: 1, id: 'evidence-b', name: 'Evidence B', description: '',
      orchestrator: { enabled: true, agent: { provider: 'mock', model: 'ok', permission: 'auto' }, gateTimeoutSec: 60 },
      stages: [
        stage({ id: 'b1', name: 'Build', isolation: 'worktree', gate: true, requireVerified: true, slots: [mockSlot('builder', 'MOCK_WRITE:evidence-b.txt\nMOCK_REPLY: built')] }),
      ],
      maxParallel: 2, maxRetriesPerStage: 1,
    },
  }) });
  const doneB = await waitRun(runB.runId, 90_000);
  check('B: run done (fail-open, never bricked)', doneB.status === 'done', doneB.status);
  const b1 = doneB.nodes.find((node) => node.stageId === 'b1');
  check('B: verification failed with exit 1', b1?.verification?.status === 'failed' && b1.verification.exitCode === 1, JSON.stringify(b1?.verification));
  check('B: outputTail carries the boom marker', b1?.verification?.outputTail?.includes('boom marker 42') === true);
  const decisionsB = doneB.gateDecisions.filter((decision) => decision.stageId === 'b1');
  check('B: two gate decisions (retry then advance)', decisionsB.length === 2, JSON.stringify(decisionsB.map((d) => d.action)));
  check('B: decision 1 is engine-forced retry', decisionsB[0]?.action === 'retry' && decisionsB[0].rationale.includes('[engine] requireVerified'), decisionsB[0]?.rationale?.slice(0, 200));
  check('B: retry targets the failing candidate', JSON.stringify(decisionsB[0]?.retryNodeRunIds) === JSON.stringify([b1.nodeRunId]));
  check('B: candidate actually reran (attempt 2)', b1?.attempt === 2, String(b1?.attempt));
  check('B: decision 2 is honest degraded advance', decisionsB[1]?.action === 'advance' && decisionsB[1].degraded === true, JSON.stringify(decisionsB[1]));
  const reportB = await api(`/api/runs/${runB.runId}/report`);
  check('B: report counts failed checks', /1 candidates generated · 0 verified · 1 failed checks/.test(reportB), reportB.split('\n').find((line) => line.includes('candidates generated')));
  check('B: report includes degraded stage label', reportB.includes('degraded at stage Build'));
  check('B: report verification log carries marker', reportB.includes('boom marker 42'));

  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECKS FAILED`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error('INSTRUMENT ERROR:', error);
  console.error(serverLog.slice(-2000));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
  for (const dir of [dataDir, wsA, wsB]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } }
}
