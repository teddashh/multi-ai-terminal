import {
  RetryStageRequestSchema,
  RunCreateRequestSchema,
  WorkspaceCreateRequestSchema,
  WorkspacePatchRequestSchema,
  WorkflowCreateRequestSchema,
  WorkflowPatchRequestSchema,
  type ApplyPatchResponse,
  type RetryStageRequest,
  type RunCreateRequest,
  type RunSnapshot,
  type WorkflowDef,
  type Workspace,
} from '@mat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listProviders } from '../adapters/registry.js';
import * as runManager from '../engine/runManager.js';
import { readEventsAfter } from '../store/eventLog.js';
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

export interface ApiRouteDependencies {
  providers(): ReturnType<typeof listProviders>;
  workspaces: {
    list: typeof listWorkspaces; get: typeof getWorkspace; create: typeof createWorkspace;
    update: typeof updateWorkspace; delete: typeof deleteWorkspace;
  };
  workflows: {
    list: typeof listWorkflows; create: typeof createWorkflow; update: typeof updateWorkflow;
    delete: typeof deleteWorkflow; duplicate: typeof duplicateWorkflow;
  };
  runs: {
    create(req: RunCreateRequest): Promise<RunSnapshot>;
    list: typeof listRuns; get: typeof getRun; delete: typeof deleteRun;
    events(runId: string, afterSeq: number, limit: number): ReturnType<typeof readEventsAfter>;
    patch: typeof readRunPatch;
    abort(runId: string): Promise<void>;
    killNode(runId: string, nodeRunId: string): Promise<void>;
    retryStage(runId: string, stageId: string, req: RetryStageRequest): Promise<RunSnapshot>;
    applyPatch(runId: string, nodeRunId: string): Promise<ApplyPatchResponse>;
  };
}

const defaultDependencies: ApiRouteDependencies = {
  providers: listProviders,
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
    applyPatch: runManager.applyPatch,
  },
};

export async function registerApiRoutes(app: FastifyInstance, dependencies: ApiRouteDependencies = defaultDependencies): Promise<void> {
  app.setErrorHandler((error, _request, reply) => sendError(reply, error));

  app.get('/api/health', wrap(async () => ({ ok: true, version: '0.1.0' })));
  app.get('/api/providers', wrap(async () => dependencies.providers()));

  app.get('/api/workspaces', wrap(async () => dependencies.workspaces.list()));
  app.post('/api/workspaces', wrap(async (request) => {
    const body = WorkspaceCreateRequestSchema.parse(request.body);
    return dependencies.workspaces.create(body as unknown as Omit<Workspace, 'id' | 'isGit'>);
  }));
  app.get('/api/workspaces/:id', wrap(async (request) => dependencies.workspaces.get(parseId(request))));
  app.patch('/api/workspaces/:id', wrap(async (request) => {
    const body = WorkspacePatchRequestSchema.parse(request.body);
    return dependencies.workspaces.update(parseId(request), body as unknown as Partial<Pick<Workspace, 'name' | 'path' | 'defaultWorkflowId'>>);
  }));
  app.delete('/api/workspaces/:id', wrap(async (request, reply) => {
    await dependencies.workspaces.delete(parseId(request));
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
    return reply.code(201).send(await dependencies.runs.create(body));
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
  app.get('/api/runs/:id/patches/:nodeRunId', wrap(async (request, reply) => {
    const { id, nodeRunId } = NodeParamsSchema.parse(request.params);
    const patch = await dependencies.runs.patch(id, nodeRunId);
    return reply.type('text/plain; charset=utf-8').send(patch);
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
  app.post('/api/runs/:id/nodes/:nodeRunId/apply-patch', wrap(async (request) => {
    const { id, nodeRunId } = NodeParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(id);
    if (!run.nodes.some((node) => node.nodeRunId === nodeRunId)) throw apiError(404, 'NOT_FOUND', `Node not found: ${nodeRunId}`);
    return dependencies.runs.applyPatch(id, nodeRunId);
  }));
  app.delete('/api/runs/:id', wrap(async (request, reply) => {
    await dependencies.runs.delete(parseId(request));
    return reply.code(204).send();
  }));
}

function parseId(request: FastifyRequest): string {
  return IdParamsSchema.parse(request.params).id;
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
    catch (error) { return sendError(reply, error); }
  };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const location = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `${location}${issue?.message ?? 'Invalid request'}` } });
  }
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (candidate.code === 'NOT_FOUND') return reply.code(404).send(errorBody('NOT_FOUND', messageOf(error)));
  if (candidate.code === 'CONFLICT') return reply.code(409).send(errorBody('CONFLICT', messageOf(error)));
  if (candidate.code === 'INVALID_PATH' || candidate.code === 'INVALID_DATA') {
    return reply.code(400).send(errorBody(String(candidate.code), messageOf(error)));
  }
  if (typeof candidate.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode < 500) {
    return reply.code(candidate.statusCode).send(errorBody(typeof candidate.code === 'string' ? candidate.code : 'BAD_REQUEST', messageOf(error)));
  }
  reply.log.error(error);
  return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}
