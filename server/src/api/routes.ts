import { existsSync } from 'node:fs';
import {
  ProviderSignInCancelRequestSchema,
  ProviderSignInCodeRequestSchema,
  CodexAccountIdRequestSchema,
  CodexApiKeySetRequestSchema,
  RetryStageRequestSchema,
  SteerRequestSchema,
  RunCreateRequestSchema,
  WorkspaceCreateRequestSchema,
  WorkspacePatchRequestSchema,
  WorkflowCreateRequestSchema,
  WorkflowPatchRequestSchema,
  type ApplyPatchResponse,
  type RetryStageRequest,
  type RunCreateRequest,
  type RunSnapshot,
  type SteerRequest,
  type ProviderInfo,
  type ProviderId,
  type RuntimeFamily,
  type WorkflowDef,
  type Workspace,
} from '@mat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listProviders } from '../adapters/registry.js';
import { clearVersionCache } from '../adapters/base.js';
import { VERSION } from '../version.js';
import { diag, serverDiagPath } from '../diag.js';
import * as runManager from '../engine/runManager.js';
import { buildDebugBundle, readTail } from '../engine/debugBundle.js';
import { buildRunReport } from '../engine/report.js';
import { redactEnvironmentValues } from '../redact.js';
import { providerInstallPlan, providerInstallTimeoutMs, providerUpdatePlan, type ProviderInstallPlan } from '../providers/install.js';
import { readClaudeAccountIndex } from '../providers/claude/accounts.js';
import { cancelSignIn, signInStatus, startSignIn, submitSignInCode } from '../providers/signin.js';
import { isSignInActive } from '../providers/signin.js';
import { captureCurrent, readAccountIndex, removeAccount, switchAccount } from '../providers/codex/accounts.js';
import { clearOpenAiKey, configuredOpenAiKey, setOpenAiKey } from '../providers/codex/apiKey.js';
import { codexSessionRuntime } from '../providers/codex/runtime.js';
import { clearAugmentedPathCache, spawnManaged, type ManagedProcess } from '../spawn.js';
import { readEventsAfter } from '../store/eventLog.js';
import { getDataDir } from '../store/dataDir.js';
import { activeRuntimeMutation, clearFamily, installFamily, isManagedRuntimeFamily, runtimeStatus } from '../runtime/triggers.js';
import {
  deleteRun,
  getRun,
  listRuns,
  readRunPatch,
} from '../store/runs.js';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from '../store/workspaces.js';
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  listWorkflows,
  updateWorkflow,
} from '../store/workflows.js';

const IdParamsSchema = z.object({ id: z.string().min(1) }).strict();
const NodeParamsSchema = z.object({ id: z.string().min(1), nodeRunId: z.string().min(1) }).strict();
const StageParamsSchema = z.object({ id: z.string().min(1), stageId: z.string().min(1) }).strict();
const RunListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().nonnegative().optional(),
}).strict();
const EventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
}).strict();
const ClientLogSchema = z.object({
  level: z.enum(['error', 'warn']), message: z.string().max(4000),
  stack: z.string().max(8000).optional(), url: z.string().optional(),
}).strict();
const ACTIVE_RUN_STATUSES = new Set<RunSnapshot['status']>(['created', 'running', 'gating']);
const codexRefusal = (error: string): { ok: false; error: string } => ({ ok: false, error: redactEnvironmentValues(error) });

export interface ApiRouteDependencies {
  providers(): ReturnType<typeof listProviders>;
  providerInstall: {
    plan(providerId: ProviderId): ProviderInstallPlan;
    updatePlan(providerId: ProviderId): ProviderInstallPlan;
    spawn: typeof spawnManaged;
    clearVersionCache(command?: string): void;
    clearPathCache(): void;
  };
  providerSignIn: {
    start: typeof startSignIn;
    status: typeof signInStatus;
    submitCode: typeof submitSignInCode;
    cancel: typeof cancelSignIn;
  };
  runtimes: { status: typeof runtimeStatus; install: typeof installFamily; clear: typeof clearFamily; active: typeof activeRuntimeMutation };
  report: typeof buildRunReport;
  workspaces: {
    list: typeof listWorkspaces; get: typeof getWorkspace; create: typeof createWorkspace;
    update: typeof updateWorkspace; delete: typeof deleteWorkspace;
  };
  workflows: {
    list: typeof listWorkflows; create: typeof createWorkflow; update: typeof updateWorkflow;
    delete: typeof deleteWorkflow; duplicate: typeof duplicateWorkflow;
  };
  runs: {
    create(req: RunCreateRequest, providerVersions?: Record<string, string>): Promise<RunSnapshot>;
    list: typeof listRuns; get: typeof getRun; delete: typeof deleteRun;
    events(runId: string, afterSeq: number, limit: number): ReturnType<typeof readEventsAfter>;
    patch: typeof readRunPatch;
    abort(runId: string): Promise<void>;
    killNode(runId: string, nodeRunId: string): Promise<void>;
    retryStage(runId: string, stageId: string, req: RetryStageRequest): Promise<RunSnapshot>;
    steer(runId: string, req: SteerRequest): Promise<RunSnapshot>;
    applyPatch(runId: string, nodeRunId: string): Promise<ApplyPatchResponse>;
  };
}

export const defaultApiRouteDependencies: ApiRouteDependencies = {
  providers: listProviders,
  providerInstall: { plan: providerInstallPlan, updatePlan: providerUpdatePlan, spawn: spawnManaged, clearVersionCache, clearPathCache: clearAugmentedPathCache },
  providerSignIn: { start: startSignIn, status: signInStatus, submitCode: submitSignInCode, cancel: cancelSignIn },
  runtimes: { status: runtimeStatus, install: installFamily, clear: clearFamily, active: activeRuntimeMutation },
  report: buildRunReport,
  workspaces: { list: listWorkspaces, get: getWorkspace, create: createWorkspace, update: updateWorkspace, delete: deleteWorkspace },
  workflows: { list: listWorkflows, create: createWorkflow, update: updateWorkflow, delete: deleteWorkflow, duplicate: duplicateWorkflow },
  runs: {
    create: runManager.createRun,
    list: listRuns,
    get: getRun,
    delete: deleteRun,
    events: readEventsAfter,
    patch: readRunPatch,
    abort: runManager.abortRun,
    killNode: runManager.killNode,
    retryStage: runManager.retryStage,
    steer: runManager.steerRun,
    applyPatch: runManager.applyPatch,
  },
};

export async function registerApiRoutes(app: FastifyInstance, dependencies: ApiRouteDependencies = defaultApiRouteDependencies): Promise<void> {
  let acceptedClientLogs = 0;
  const runningInstalls = new Set<ProviderId>();
  app.setErrorHandler((error, request, reply) => sendError(reply, error, request));

  app.get('/api/health', wrap(async () => ({ ok: true, version: VERSION })));
  app.get('/api/providers', wrap(async () => dependencies.providers()));
  app.get('/api/providers/claude/accounts', wrap(async () => readClaudeAccountIndex(getDataDir())));
  app.get('/api/providers/codex/accounts', wrap(async () => readAccountIndex()));
  app.post('/api/providers/codex/accounts/capture', wrap(async () => {
    if (isSignInActive()) return codexRefusal('Cannot capture codex account while a sign-in is in progress.');
    if (codexSessionRuntime().busy()) return codexRefusal('Cannot capture codex account while a turn is running.');
    return captureCurrent();
  }));
  app.post('/api/providers/codex/accounts/switch', wrap(async (request) => {
    const { accountId } = CodexAccountIdRequestSchema.parse(request.body);
    if (isSignInActive()) return codexRefusal('Cannot switch codex account while a sign-in is in progress.');
    const runtime = codexSessionRuntime();
    if (runtime.busy()) return codexRefusal('Cannot switch codex account while a turn is running.');
    const result = switchAccount(accountId);
    if (result.ok) await runtime.recycleForAccountChange();
    return result;
  }));
  app.post('/api/providers/codex/accounts/remove', wrap(async (request) => {
    const { accountId } = CodexAccountIdRequestSchema.parse(request.body);
    if (isSignInActive()) return codexRefusal('Cannot remove codex account while a sign-in is in progress.');
    if (codexSessionRuntime().busy()) return codexRefusal('Cannot remove codex account while a turn is running.');
    return removeAccount(accountId);
  }));
  app.get('/api/providers/codex/api-key', wrap(async () => {
    const configured = configuredOpenAiKey();
    return { configured: configured !== null, ...(configured ? { source: configured.source } : {}) };
  }));
  app.post('/api/providers/codex/api-key', wrap(async (request) => {
    const { key } = CodexApiKeySetRequestSchema.parse(request.body);
    setOpenAiKey(key);
    const configured = configuredOpenAiKey();
    return { configured: configured !== null, ...(configured ? { source: configured.source } : {}) };
  }));
  app.delete('/api/providers/codex/api-key', wrap(async () => {
    clearOpenAiKey();
    const configured = configuredOpenAiKey();
    return { configured: configured !== null, ...(configured ? { source: configured.source } : {}) };
  }));
  app.get('/api/runtimes', wrap(async () => dependencies.runtimes.status(getDataDir())));
  const runtimeMutation = async (request: FastifyRequest, reply: FastifyReply, kind: 'install' | 'clear'): Promise<FastifyReply> => {
    const raw = (request.params as { family?: unknown }).family;
    if (typeof raw !== 'string' || !isManagedRuntimeFamily(raw)) throw apiError(400, 'BAD_REQUEST', `Unknown managed runtime family: ${String(raw)}`);
    const family = raw as RuntimeFamily;
    const status = (await dependencies.runtimes.status(getDataDir())).find((item) => item.family === family)!;
    // Clear stays available off-matrix: it only deletes local managed bits and must not be gated on installability.
    if (kind === 'install' && !status.canInstallManaged) throw apiError(400, 'BAD_REQUEST', `Managed ${family} runtime is unsupported on this platform`);
    const heldBy = dependencies.runtimes.active();
    if (heldBy) throw apiError(409, 'CONFLICT', `Runtime mutation lock is held by ${heldBy}`);
    const operation = kind === 'install' ? dependencies.runtimes.install(getDataDir(), family) : dependencies.runtimes.clear(getDataDir(), family);
    void operation.catch(() => undefined);
    return reply.code(202).send({ accepted: true, family, operation: kind });
  };
  app.post('/api/runtimes/:family/install', wrap((request, reply) => runtimeMutation(request, reply, 'install')));
  app.post('/api/runtimes/:family/clear', wrap((request, reply) => runtimeMutation(request, reply, 'clear')));
  app.post('/api/providers/refresh', wrap(async () => {
    dependencies.providerInstall.clearPathCache();
    dependencies.providerInstall.clearVersionCache();
    return dependencies.providers();
  }));
  const runProviderRecipe = async (current: ProviderInfo, plan: ProviderInstallPlan, kind: 'install' | 'update', reply: FastifyReply): Promise<FastifyReply> => {
    if (!plan.recipe) return reply.send({ ok: false, ...(plan.manualCommand ? { manualCommand: plan.manualCommand } : {}) });
    runningInstalls.add(current.id);
    const startedAt = Date.now();
    let exitCode: number | null = null;
    let output = Buffer.alloc(0);
    const appendOutput = (chunk: Buffer | string): void => {
      output = Buffer.concat([output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (output.length > 64 * 1024) output = output.subarray(output.length - 64 * 1024);
    };
    try {
      let managed: ManagedProcess | undefined;
      try {
        managed = dependencies.providerInstall.spawn({
          command: plan.recipe.command, args: plan.recipe.args, cwd: process.cwd(), timeoutMs: providerInstallTimeoutMs(current.id), shell: false,
        });
      } catch (error) {
        appendOutput(error instanceof Error ? error.message : String(error));
      }
      if (managed) {
        managed.child.stdout?.on('data', appendOutput);
        managed.child.stderr?.on('data', appendOutput);
        exitCode = await new Promise<number | null>((resolve) => {
          let settled = false;
          const finish = (code: number | null): void => { if (!settled) { settled = true; resolve(code); } };
          managed.child.once('error', (error) => { appendOutput(error.message); if (managed.child.pid === undefined) finish(null); });
          managed.child.once('close', (code) => finish(code));
        });
      }
      dependencies.providerInstall.clearPathCache();
      dependencies.providerInstall.clearVersionCache(current.id);
      const provider = (await dependencies.providers()).find((candidate) => candidate.id === current.id) ?? current;
      const logTail = redactEnvironmentValues(output.subarray(Math.max(0, output.length - 8 * 1024)).toString('utf8'));
      const safeProvider = provider.detail === undefined ? provider : { ...provider, detail: redactEnvironmentValues(provider.detail) };
      diag(null, kind, { providerId: current.id, exitCode, durationMs: Math.max(0, Date.now() - startedAt) });
      return reply.send({ ok: exitCode === 0 && provider.ok, exitCode, logTail, provider: safeProvider });
    } finally {
      runningInstalls.delete(current.id);
    }
  };
  app.post('/api/providers/:id/install', wrap(async (request, reply) => {
    const id = parseId(request);
    const providers = await dependencies.providers();
    const current = providers.find((provider) => provider.id === id);
    if (!current) throw apiError(404, 'NOT_FOUND', `Provider not found: ${id}`);
    if (current.ok) throw apiError(409, 'CONFLICT', `${id} is already installed`);
    if (runningInstalls.has(current.id)) throw apiError(409, 'CONFLICT', `${id} installation is already running`);
    return runProviderRecipe(current, dependencies.providerInstall.plan(current.id), 'install', reply);
  }));
  app.post('/api/providers/:id/update', wrap(async (request, reply) => {
    const id = parseId(request);
    const providers = await dependencies.providers();
    const current = providers.find((provider) => provider.id === id);
    if (!current) throw apiError(404, 'NOT_FOUND', `Provider not found: ${id}`);
    if (current.id === 'mock') throw apiError(409, 'CONFLICT', 'mock has no CLI to update');
    if (!current.ok) throw apiError(409, 'CONFLICT', `${id} is not installed; use install instead`);
    if (runningInstalls.has(current.id)) throw apiError(409, 'CONFLICT', `${id} installation is already running`);
    return runProviderRecipe(current, dependencies.providerInstall.updatePlan(current.id), 'update', reply);
  }));
  const SignInStatusQuerySchema = z.object({ loginId: z.string().min(1) }).strict();
  app.post('/api/providers/:id/signin/start', wrap(async (request) => {
    const id = parseId(request);
    const providers = await dependencies.providers();
    if (!providers.some((provider) => provider.id === id)) throw apiError(404, 'NOT_FOUND', `Provider not found: ${id}`);
    return dependencies.providerSignIn.start(id as ProviderId);
  }));
  app.get('/api/providers/:id/signin/status', wrap(async (request) => {
    parseId(request);
    const query = SignInStatusQuerySchema.parse(request.query);
    return dependencies.providerSignIn.status(query.loginId);
  }));
  app.post('/api/providers/:id/signin/code', wrap(async (request) => {
    parseId(request);
    const body = ProviderSignInCodeRequestSchema.parse(request.body);
    return dependencies.providerSignIn.submitCode(body.loginId, body.code);
  }));
  app.post('/api/providers/:id/signin/cancel', wrap(async (request) => {
    parseId(request);
    const body = ProviderSignInCancelRequestSchema.parse(request.body);
    return dependencies.providerSignIn.cancel(body.loginId);
  }));
  app.post('/api/client-log', wrap(async (request, reply) => {
    const body = ClientLogSchema.parse(request.body);
    if (acceptedClientLogs < 200) {
      acceptedClientLogs += 1;
      diag(null, 'client', body);
    }
    return reply.code(204).send();
  }));
  app.get('/api/debug/server-log', wrap(async (_request, reply) => {
    const path = serverDiagPath();
    return reply.type('text/plain; charset=utf-8').send(existsSync(path) ? redactEnvironmentValues(readTail(path).toString('utf8')) : '');
  }));

  app.get('/api/workspaces', wrap(async () => dependencies.workspaces.list()));
  app.post('/api/workspaces', wrap(async (request) => {
    const body = WorkspaceCreateRequestSchema.parse(request.body);
    return dependencies.workspaces.create(body as unknown as Omit<Workspace, 'id' | 'isGit'>);
  }));
  app.get('/api/workspaces/:id', wrap(async (request) => dependencies.workspaces.get(parseId(request))));
  app.patch('/api/workspaces/:id', wrap(async (request) => {
    const body = WorkspacePatchRequestSchema.parse(request.body);
    const update: Record<string, unknown> = { ...body };
    if (body.verifyCommand === null) update.verifyCommand = undefined;
    if (body.verifyTimeoutSec === null) update.verifyTimeoutSec = undefined;
    return dependencies.workspaces.update(parseId(request), update as Partial<Pick<Workspace, 'name' | 'path' | 'defaultWorkflowId' | 'verifyCommand' | 'verifyTimeoutSec'>>);
  }));
  app.delete('/api/workspaces/:id', wrap(async (request, reply) => {
    const workspaceId = parseId(request);
    const runs = await dependencies.runs.list(workspaceId, Number.MAX_SAFE_INTEGER);
    const active = runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
    if (active) throw apiError(409, 'CONFLICT', `Workspace has an active run: ${active.runId}`);
    const legacy = runs.find((run) => !run.workspaceSnapshot);
    if (legacy) {
      throw apiError(409, 'CONFLICT', `Workspace has a legacy run without embedded provenance: ${legacy.runId}. Delete that run before deleting the workspace.`);
    }
    await dependencies.workspaces.delete(workspaceId);
    return reply.code(204).send();
  }));

  app.get('/api/workflows', wrap(async () => dependencies.workflows.list()));
  app.post('/api/workflows', wrap(async (request, reply) => {
    const body = WorkflowCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await dependencies.workflows.create(body as unknown as WorkflowDef));
  }));
  app.patch('/api/workflows/:id', wrap(async (request) => {
    const body = WorkflowPatchRequestSchema.parse(request.body);
    return dependencies.workflows.update(parseId(request), body as unknown as Partial<WorkflowDef>);
  }));
  app.delete('/api/workflows/:id', wrap(async (request, reply) => {
    await dependencies.workflows.delete(parseId(request));
    return reply.code(204).send();
  }));
  app.post('/api/workflows/:id/duplicate', wrap(async (request, reply) =>
    reply.code(201).send(await dependencies.workflows.duplicate(parseId(request))),
  ));

  app.post('/api/runs', wrap(async (request, reply) => {
    const body = RunCreateRequestSchema.parse(request.body) as RunCreateRequest;
    const workflow = body.workflowOverride ?? (await dependencies.workflows.list()).find((candidate) => candidate.id === body.workflowId);
    let versions: Record<string, string> | undefined;
    if (workflow) {
      const providers = await dependencies.providers();
      const unavailable = unavailableProviderBindings(workflow, providers);
      if (unavailable.length > 0) throw apiError(400, 'PROVIDER_UNAVAILABLE', unavailable.join('\n'));
      const used = new Set(workflow.stages.flatMap((stage) => stage.slots.map((slot) => slot.agent.provider)));
      if (workflow.orchestrator.enabled) used.add(workflow.orchestrator.agent.provider);
      versions = Object.fromEntries(providers.flatMap((provider) => used.has(provider.id) && provider.version ? [[provider.id, provider.version]] : []));
    }
    const created = versions && Object.keys(versions).length > 0
      ? await dependencies.runs.create(body, versions)
      : await dependencies.runs.create(body);
    return reply.code(201).send(created);
  }));
  app.get('/api/runs', wrap(async (request) => {
    const query = RunListQuerySchema.parse(request.query);
    return dependencies.runs.list(query.workspaceId, query.limit, query.before);
  }));
  app.get('/api/runs/:id', wrap(async (request) => dependencies.runs.get(parseId(request))));
  app.get('/api/runs/:id/events', wrap(async (request) => {
    const runId = parseId(request);
    await dependencies.runs.get(runId);
    const query = EventsQuerySchema.parse(request.query);
    return dependencies.runs.events(runId, query.afterSeq, query.limit);
  }));
  app.get('/api/runs/:id/report', wrap(async (request, reply) => {
    const run = await dependencies.runs.get(parseId(request));
    const workspace = await evidenceWorkspace(run, dependencies);
    const events = await dependencies.runs.events(run.runId, 0, Number.MAX_SAFE_INTEGER);
    return reply.type('text/markdown; charset=utf-8').send(redactEnvironmentValues(dependencies.report(run, workspace, events)));
  }));
  app.get('/api/runs/:id/debug-bundle', wrap(async (request, reply) => {
    const run = await dependencies.runs.get(parseId(request));
    const workspace = await evidenceWorkspace(run, dependencies);
    const events = await dependencies.runs.events(run.runId, 0, Number.MAX_SAFE_INTEGER);
    const zip = buildDebugBundle(run, workspace, events);
    return reply
      .header('content-disposition', `attachment; filename="mat-debug-${run.runId}.zip"`)
      .type('application/zip')
      .send(zip.outputStream);
  }));
  app.get('/api/runs/:id/patches/:nodeRunId', wrap(async (request, reply) => {
    const { id, nodeRunId } = NodeParamsSchema.parse(request.params);
    const patch = await dependencies.runs.patch(id, nodeRunId);
    return reply.type('text/plain; charset=utf-8').send(redactEnvironmentValues(patch));
  }));
  app.post('/api/runs/:id/abort', wrap(async (request) => {
    const runId = parseId(request);
    await dependencies.runs.get(runId);
    await dependencies.runs.abort(runId);
    return dependencies.runs.get(runId);
  }));
  app.post('/api/runs/:id/nodes/:nodeRunId/kill', wrap(async (request) => {
    const { id, nodeRunId } = NodeParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(id);
    if (!run.nodes.some((node) => node.nodeRunId === nodeRunId)) throw apiError(404, 'NOT_FOUND', `Node not found: ${nodeRunId}`);
    await dependencies.runs.killNode(id, nodeRunId);
    return dependencies.runs.get(id);
  }));
  app.post('/api/runs/:id/stages/:stageId/retry', wrap(async (request) => {
    const { id, stageId } = StageParamsSchema.parse(request.params);
    const body = RetryStageRequestSchema.parse(request.body ?? {}) as RetryStageRequest;
    const run = await dependencies.runs.get(id);
    validateRetryStage(run, stageId);
    return dependencies.runs.retryStage(id, stageId, body);
  }));
  app.post('/api/runs/:id/steer', wrap(async (request) => {
    const id = parseId(request);
    await dependencies.runs.get(id);
    const body = SteerRequestSchema.parse(request.body) as SteerRequest;
    return dependencies.runs.steer(id, body);
  }));
  app.post('/api/runs/:id/nodes/:nodeRunId/apply-patch', wrap(async (request) => {
    const { id, nodeRunId } = NodeParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(id);
    if (!run.nodes.some((node) => node.nodeRunId === nodeRunId)) throw apiError(404, 'NOT_FOUND', `Node not found: ${nodeRunId}`);
    const result = await dependencies.runs.applyPatch(id, nodeRunId);
    return {
      ...result,
      message: redactEnvironmentValues(result.message),
      ...(result.conflicts ? { conflicts: result.conflicts.map((conflict) => redactEnvironmentValues(conflict)) } : {}),
    };
  }));
  app.delete('/api/runs/:id', wrap(async (request, reply) => {
    await dependencies.runs.delete(parseId(request));
    return reply.code(204).send();
  }));
}

function parseId(request: FastifyRequest): string {
  return IdParamsSchema.parse(request.params).id;
}

async function evidenceWorkspace(run: RunSnapshot, dependencies: ApiRouteDependencies): Promise<Workspace> {
  if (run.workspaceSnapshot) return { id: run.workspaceId, ...run.workspaceSnapshot };
  return dependencies.workspaces.get(run.workspaceId);
}

function unavailableProviderBindings(workflow: WorkflowDef, providers: readonly ProviderInfo[]): string[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const bindings = workflow.stages.flatMap((stage) => stage.slots.map((slot) => ({ label: slot.label, provider: slot.agent.provider })));
  if (workflow.orchestrator.enabled) bindings.push({ label: 'Orchestrator', provider: workflow.orchestrator.agent.provider });
  return bindings.flatMap(({ label, provider }) => {
    const availability = byId.get(provider);
    return availability?.ok === false
      ? [`${label} · ${provider} unavailable: ${availability.detail || 'not detected'}`]
      : [];
  });
}

function validateRetryStage(run: RunSnapshot, stageId: string): void {
  if (!run.workflow.stages.some((stage) => stage.id === stageId)) {
    throw apiError(404, 'NOT_FOUND', `Stage not found: ${stageId}`);
  }
  const retriesFromDecisions = run.gateDecisions.filter((decision) => decision.stageId === stageId && decision.action === 'retry').length;
  const retriesFromAttempts = Math.max(0, ...run.nodes
    .filter((node) => node.stageId === stageId)
    .map((node) => node.attempt - 1));
  if (Math.max(retriesFromDecisions, retriesFromAttempts) >= run.workflow.maxRetriesPerStage) {
    throw apiError(409, 'CONFLICT', `Stage ${stageId} has exhausted its retry budget`);
  }
  if (run.status === 'gating' && run.currentStageId === stageId) return;
  if (run.status === 'done' || run.status === 'failed' || run.status === 'aborted') {
    if (lastExecutedStageId(run) === stageId) return;
  }
  throw apiError(409, 'CONFLICT', `Stage ${stageId} cannot be retried while run ${run.runId} is ${run.status}`);
}

function lastExecutedStageId(run: RunSnapshot): string | undefined {
  if (run.currentStageId && run.workflow.stages.some((stage) => stage.id === run.currentStageId)) return run.currentStageId;
  const executed = new Set<string>();
  for (const decision of run.gateDecisions) executed.add(decision.stageId);
  for (const node of run.nodes) {
    if (node.stageId && (node.startedAt !== undefined || node.status !== 'queued')) executed.add(node.stageId);
  }
  return [...run.workflow.stages].reverse().find((stage) => executed.has(stage.id))?.id;
}

interface HttpError extends Error { statusCode: number; code: string }

function apiError(statusCode: number, code: string, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode, code });
}

function wrap(
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try { return await handler(request, reply); }
    catch (error) { return sendError(reply, error, request); }
  };
}

function sendError(reply: FastifyReply, error: unknown, request?: FastifyRequest): FastifyReply {
  const send = (status: number, body: object): FastifyReply => {
    diag(null, 'api-error', {
      method: request?.method ?? 'unknown', url: request?.url ?? 'unknown', status, message: messageOf(error),
    });
    return reply.code(status).send(body);
  };
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const location = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return send(400, { error: { code: 'VALIDATION_ERROR', message: `${location}${issue?.message ?? 'Invalid request'}` } });
  }
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (candidate.code === 'NOT_FOUND') return send(404, errorBody('NOT_FOUND', messageOf(error)));
  if (candidate.code === 'CONFLICT') return send(409, errorBody('CONFLICT', messageOf(error)));
  if (candidate.code === 'INVALID_PATH' || candidate.code === 'INVALID_DATA') {
    return send(400, errorBody(String(candidate.code), messageOf(error)));
  }
  if (typeof candidate.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode < 500) {
    return send(candidate.statusCode, errorBody(typeof candidate.code === 'string' ? candidate.code : 'BAD_REQUEST', messageOf(error)));
  }
  reply.log.error({ message: redactEnvironmentValues(messageOf(error)) }, 'request failed');
  return send(500, errorBody('INTERNAL_ERROR', 'Internal server error'));
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function messageOf(error: unknown): string {
  return redactEnvironmentValues(error instanceof Error ? error.message : 'Request failed');
}
