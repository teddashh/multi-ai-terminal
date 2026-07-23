#!/usr/bin/env node
// Provider-runtime contract instrument (independent of repo tests).
//
// J: a deterministic fake codex app-server drives OpenRouter through the built
//    server and proves its exact model/provider routing, normalized thinking +
//    Bash tool pair + agent text, usage/session continuity, and the canonical
//    terminal marker in MAT's durable AgentEvent plane.
// K: event ids/sequences are server-authored, environment values stay out of
//    events/raw/report, and a server restart replays the exact same evidence.
//
// This instrument is Linux/POSIX-only like the rest of the extracted-.deb
// evidence lane. It imports no product source or test fixture and performs no
// network access; MAT_ROOT may point at an extracted release artifact.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.MAT_ROOT ?? REPO_ROOT;
const CURRENT_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const EXPECT_VERSION = process.env.MAT_EXPECT_VERSION ?? CURRENT_VERSION;
const PORT = Number(process.env.MAT_PORT ?? 0);
const MODEL = 'openai/gpt-5.6-sol-20260709';
const ENV_SENTINEL = 'mat-openrouter-evidence-sentinel-7f0ed38b';
const REDACTED_ENV = '[REDACTED_ENV]';
const REQUEST_TIMEOUT_MS = 10_000;
const failures = [];
let baseUrl;

const check = (name, ok, detail = '') => {
  failures.push(...(ok ? [] : [name + (detail ? ` — ${detail}` : '')]));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const safeText = (value) => String(value).replaceAll(ENV_SENTINEL, '[REDACTED_ENV]');

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
    if (!response.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${path} → ${response.status}: ${safeText(JSON.stringify(body))}`);
    }
    return body;
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
    // Evidence is POSIX-only; detached children lead a private process group
    // containing the server and its persistent fake app-server.
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

const jsonLines = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
const readTreeText = (directory) => {
  if (!existsSync(directory)) return '';
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? readTreeText(path) : readFileSync(path).toString('utf8');
    })
    .join('\n');
};

const tempRoot = mkdtempSync(join(tmpdir(), 'mat-runtime-contract-'));
const dataDir = join(tempRoot, 'data');
const fakeHome = join(tempRoot, 'home');
const codexHome = join(tempRoot, 'codex-home');
const workspaceDir = join(tempRoot, 'workspace');
const isolatedBin = join(tempRoot, 'bin');
const runtimeRecord = join(tempRoot, 'fake-runtime.jsonl');
const fakeRuntime = join(isolatedBin, 'codex-evidence.mjs');
for (const directory of [dataDir, fakeHome, codexHome, workspaceDir, isolatedBin]) {
  mkdirSync(directory, { recursive: true });
}

copyFileSync(fileURLToPath(new URL('./fake-codex-runtime.mjs', import.meta.url)), fakeRuntime);
chmodSync(fakeRuntime, 0o755);
symlinkSync(process.execPath, join(isolatedBin, 'node'));
const unavailableProvider = join(isolatedBin, 'provider-unavailable');
writeFileSync(
  unavailableProvider,
  '#!/usr/bin/env node\nconsole.error("deterministic provider unavailable");\nprocess.exit(7);\n',
  { encoding: 'utf8', mode: 0o755 },
);
chmodSync(unavailableProvider, 0o755);
for (const command of ['claude', 'grok', 'agy']) symlinkSync(unavailableProvider, join(isolatedBin, command));

// Start from an allowlist, not the verifier's shell. This makes it impossible
// for a credential, proxy, NODE_OPTIONS hook, or real runtime override to reach
// the server or fake provider child.
const serverEnv = {
  HOME: fakeHome,
  CODEX_HOME: codexHome,
  PATH: isolatedBin,
  MAT_PORT: String(PORT),
  MAT_HOST: '127.0.0.1',
  MAT_DATA_DIR: dataDir,
  MAT_SELF_PROVISION: '0',
  MAT_CLAUDE_BIN: unavailableProvider,
  MAT_CODEX_BIN: fakeRuntime,
  MAT_NODE_BIN: process.execPath,
  MAT_EVIDENCE_RUNTIME_RECORD: runtimeRecord,
  OPENROUTER_API_KEY: ENV_SENTINEL,
};

let server;
let serverLog = '';
let allServerLog = '';
const startServer = async () => {
  serverLog = '';
  baseUrl = undefined;
  const child = trackChild(spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.js')], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  }));
  // Assign before awaiting readiness so the outer finally can still terminate
  // a child whose boot fails or reports the wrong artifact version.
  server = child;
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
      allServerLog += text;
      const marker = /\[MAT_AGENT\] READY url=(http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (marker) finish(undefined, marker[1]);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      serverLog += text;
      allServerLog += text;
    });
  });
  const readyUrl = await ready;
  baseUrl = readyUrl.replace(/\/$/, '');
  const health = await api('/api/health');
  if (health.version !== EXPECT_VERSION) {
    throw new Error(`this server child reports ${String(health.version)}, expected ${EXPECT_VERSION}`);
  }
  return child;
};

try {
  server = await startServer();

  const workspace = await api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: 'Runtime contract evidence', path: workspaceDir }),
  });
  const workflowOverride = {
    schemaVersion: 1,
    id: 'runtime-contract-evidence',
    name: 'Runtime contract evidence',
    description: '',
    orchestrator: {
      enabled: false,
      agent: { provider: 'mock', model: 'ok', permission: 'safe' },
      gateTimeoutSec: 30,
    },
    stages: [{
      id: 'contract',
      name: 'Contract',
      join: 'all',
      timeoutSec: 60,
      stallSec: 30,
      gate: false,
      requireVerified: false,
      isolation: 'none',
      slots: [{
        id: 'openrouter',
        label: 'OpenRouter contract',
        agent: { provider: 'openrouter', model: MODEL, permission: 'safe' },
        count: 1,
        promptTemplate: '{{task}}',
      }],
    }],
    maxParallel: 1,
    maxRetriesPerStage: 0,
  };
  const created = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: workspace.id,
      workflowId: workflowOverride.id,
      task: 'Exercise the canonical provider event mapping.',
      workflowOverride,
    }),
  });
  const done = await waitFor(async () => {
    const snapshot = await api(`/api/runs/${created.runId}`);
    return ['done', 'failed', 'aborted'].includes(snapshot.status) ? snapshot : undefined;
  }, 'OpenRouter run terminal', 60_000);

  check('J: OpenRouter run completes', done.status === 'done', done.status);
  const node = done.nodes.find((candidate) => candidate.nodeRunId === 'contract.openrouter.0');
  check('J: node completes through the fake session runtime', node?.status === 'done', String(node?.status));
  check(
    'J: node records strict usage and resumable thread id',
    node?.usage?.inputTokens === 13
      && node?.usage?.outputTokens === 5
      && node?.usage?.costUsd === undefined
      && node?.sessionRef === 'thread-fixture-1',
    JSON.stringify({ usage: node?.usage, sessionRef: node?.sessionRef }),
  );

  const runtimeRecords = jsonLines(runtimeRecord);
  const environmentRecord = runtimeRecords.find((entry) => entry.kind === 'environment');
  check(
    'J: only the synthetic OpenRouter credential reaches the runtime',
    environmentRecord?.openRouterApiKeyPresent === true
      && environmentRecord?.openAiApiKeyPresent === false
      && environmentRecord?.codexApiKeyPresent === false
      && environmentRecord?.codexAccessTokenPresent === false
      && Array.isArray(environmentRecord?.unexpectedSensitiveNames)
      && environmentRecord.unexpectedSensitiveNames.length === 0,
    JSON.stringify(environmentRecord),
  );
  const threadStart = runtimeRecords.find((entry) => entry.kind === 'inbound' && entry.method === 'thread/start');
  check(
    'J: thread/start carries the exact selected model and OpenRouter provider',
    threadStart?.model === MODEL && threadStart?.modelProvider === 'openrouter',
    JSON.stringify(threadStart),
  );
  const turnStart = runtimeRecords.find((entry) => entry.kind === 'inbound' && entry.method === 'turn/start');
  check(
    'J: turn/start keeps the exact model without duplicating modelProvider',
    turnStart?.model === MODEL && turnStart?.modelProviderPresent === false,
    JSON.stringify(turnStart),
  );
  const expectedOutboundMethods = [
    'turn/started',
    'item/reasoning/summaryTextDelta',
    'item/started',
    'item/commandExecution/outputDelta',
    'item/completed',
    'item/agentMessage/delta',
    'thread/tokenUsage/updated',
    'turn/completed',
  ];
  const outboundMethods = runtimeRecords
    .filter((entry) => entry.kind === 'outbound')
    .map((entry) => entry.method);
  check(
    'J: fake app-server emits one complete ordered notification sequence',
    JSON.stringify(outboundMethods) === JSON.stringify(expectedOutboundMethods),
    JSON.stringify(outboundMethods),
  );

  const events = await api(`/api/runs/${created.runId}/events?afterSeq=0&limit=10000`);
  const expectedSequences = events.map((_, index) => index + 1);
  check(
    'K: server assigns one contiguous authoritative sequence',
    JSON.stringify(events.map((event) => event.seq)) === JSON.stringify(expectedSequences),
    JSON.stringify(events.map((event) => event.seq)),
  );
  check('K: every durable event id is unique', new Set(events.map((event) => event.id)).size === events.length, String(events.length));

  const nodeEvents = events.filter((event) => event.nodeRunId === node?.nodeRunId);
  const promptIndex = nodeEvents.findIndex((event) => event.role === 'user' && event.kind === 'message');
  const spawnedIndex = nodeEvents.findIndex((event) => event.kind === 'status' && event.data?.status === 'spawned');
  const runningIndex = nodeEvents.findIndex((event) => event.kind === 'status' && event.data?.status === 'running');
  check(
    'K: prompt precedes spawned and running lifecycle evidence',
    promptIndex >= 0 && promptIndex < spawnedIndex && spawnedIndex < runningIndex,
    JSON.stringify({ promptIndex, spawnedIndex, runningIndex }),
  );
  const thinking = nodeEvents.filter((event) => event.role === 'thinking' && event.kind === 'thinking');
  check(
    'K: thinking maps exactly once with its environment canary redacted',
    thinking.length === 1 && thinking[0].text === `mapped thinking ${REDACTED_ENV}`,
    JSON.stringify(thinking),
  );
  const toolUses = nodeEvents.filter((event) => event.kind === 'tool_use' && event.tool?.toolCallId === 'tool-fixture-1');
  const toolResults = nodeEvents.filter((event) => event.kind === 'tool_result' && event.tool?.toolCallId === 'tool-fixture-1');
  check(
    'K: Bash tool use/result preserve one matching id and redact tool output',
    toolUses.length === 1
      && toolResults.length === 1
      && toolUses[0].tool?.name === 'Bash'
      && toolResults[0].tool?.name === 'Bash'
      && toolResults[0].tool?.output === `tool output ${REDACTED_ENV}`
      && toolResults[0].tool?.isError === false,
    JSON.stringify({ toolUses, toolResults }),
  );
  const answers = nodeEvents.filter((event) => event.role === 'agent' && event.kind === 'message');
  check(
    'K: agent delta becomes one immutable redacted answer event',
    answers.length === 1 && answers[0].text === `mapped OpenRouter answer ${REDACTED_ENV}`,
    JSON.stringify(answers),
  );
  const resultEvents = nodeEvents.filter((event) => event.kind === 'result');
  const terminalData = resultEvents[0]?.data;
  const terminalStatus = terminalData?.providerStatus;
  const expectedProviderSessionId = node
    ? `provider:${created.runId}:${node.nodeRunId}:a${node.attempt}`
    : '';
  check(
    'K: exactly one result carries the canonical completed turn identity',
    resultEvents.length === 1
      && terminalData?.providerEvent === 'claude:turn-end'
      && terminalData?.providerSessionId === expectedProviderSessionId
      && terminalData?.turnReason === 'completed',
    JSON.stringify(resultEvents),
  );
  check(
    'K: terminal marker carries one complete non-streaming session snapshot',
    terminalStatus
      && typeof terminalStatus === 'object'
      && terminalStatus.permissionMode === 'plan'
      && terminalStatus.model === MODEL
      && terminalStatus.effort === null
      && terminalStatus.sdkSessionId === 'thread-fixture-1'
      && terminalStatus.cwd === workspaceDir
      && terminalStatus.inputTokens === 13
      && terminalStatus.outputTokens === 5
      && terminalStatus.contextTokens === 18
      && terminalStatus.numTurns === 1
      && terminalStatus.lastQueryCalls === 1
      && terminalStatus.isStreaming === false
      && terminalStatus.runtimeStatus === null
      && terminalStatus.runtimeMessage === null
      && terminalStatus.runtimeStatusStartedAt === null
      && typeof terminalStatus.durationMs === 'number'
      && terminalStatus.durationMs >= 0,
    JSON.stringify(terminalStatus),
  );

  const rawPath = node
    ? join(dataDir, 'runs', created.runId, 'raw', `${node.nodeRunId}.a${node.attempt}.jsonl`)
    : '';
  const raw = rawPath && existsSync(rawPath) ? readFileSync(rawPath, 'utf8') : '';
  const report = await api(`/api/runs/${created.runId}/report`);
  const serializedEvents = JSON.stringify(events);
  const dataTree = readTreeText(dataDir);
  check(
    'K: durable events replace the environment canary',
    !serializedEvents.includes(ENV_SENTINEL) && serializedEvents.includes(REDACTED_ENV),
  );
  check('K: environment sentinel is absent from raw adapter evidence', !raw.includes(ENV_SENTINEL));
  check(
    'K: run report replaces the environment canary',
    !String(report).includes(ENV_SENTINEL) && String(report).includes(REDACTED_ENV),
  );
  check(
    'K: server stderr replaces the environment canary',
    !allServerLog.includes(ENV_SENTINEL) && allServerLog.includes(REDACTED_ENV),
  );
  check(
    'K: complete durable data tree contains only the redacted canary',
    !dataTree.includes(ENV_SENTINEL) && dataTree.includes(REDACTED_ENV),
  );

  await stopProcess(server);
  check('K: first server process tree closes before restart', closedChildren.has(server));
  server = undefined;
  server = await startServer();
  const replayedRun = await api(`/api/runs/${created.runId}`);
  const replayedEvents = await api(`/api/runs/${created.runId}/events?afterSeq=0&limit=10000`);
  check('K: terminal run survives server restart', replayedRun.status === 'done', replayedRun.status);
  check(
    'K: restart replay is byte-for-byte JSON equivalent',
    JSON.stringify(replayedEvents) === JSON.stringify(events),
    `before=${events.length} after=${replayedEvents.length}`,
  );
} catch (error) {
  check('instrument completed', false, safeText(error?.stack ?? error));
  console.error(`--- server log tail ---\n${safeText(allServerLog.slice(-2000))}`);
} finally {
  try {
    await stopProcess(server);
  } catch (error) {
    check('K: final server process tree closes', false, safeText(error?.message ?? error));
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    check('K: temporary evidence tree is removed', false, safeText(error?.message ?? error));
  }
  if (existsSync(tempRoot)) check('K: temporary evidence tree is removed', false);
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES:\n${failures.join('\n')}`);
process.exit(failures.length === 0 ? 0 : 1);
