import { z } from 'zod';
import { AgentEventSchema, type AgentEvent } from './events.js';
import { RunSnapshotSchema, RunStatusSchema, type RunSnapshot, type RunStatus } from './run.js';
import { WorkflowDefSchema, type WorkflowDef } from './workflow.js';

export interface Workspace {
  id: string; name: string; path: string;
  isGit: boolean;
  defaultWorkflowId?: string;
  lastRun?: { runId: string; workflowName: string; status: RunStatus; at: number };
}
export interface RunCreateRequest {
  workspaceId: string;
  workflowId: string;
  task: string;
  workflowOverride?: WorkflowDef;
}
export interface RetryStageRequest { promptAddendum?: string }
export interface ApplyPatchResponse { ok: boolean; conflicts?: string[]; message: string }
export type WsClientMsg = { type:'sub'|'unsub'; runId: string };
export type WsServerMsg =
  | { type:'event'; event: AgentEvent }
  | { type:'run'; run: RunSnapshot }
  | { type:'workspaces' };

export const WorkspaceSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), path: z.string().min(1), isGit: z.boolean(),
  defaultWorkflowId: z.string().optional(),
  lastRun: z.object({ runId: z.string(), workflowName: z.string(), status: RunStatusSchema, at: z.number().int().nonnegative() }).strict().optional(),
}).strict();
export const RunCreateRequestSchema = z.object({
  workspaceId: z.string().min(1), workflowId: z.string().min(1), task: z.string().min(1), workflowOverride: WorkflowDefSchema.optional(),
}).strict();
export const RetryStageRequestSchema = z.object({ promptAddendum: z.string().optional() }).strict();
export const ApplyPatchResponseSchema = z.object({ ok: z.boolean(), conflicts: z.array(z.string()).optional(), message: z.string() }).strict();
export const WsClientMsgSchema = z.object({ type: z.enum(['sub', 'unsub']), runId: z.string().min(1) }).strict();
export const WsServerMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: AgentEventSchema }).strict(),
  z.object({ type: z.literal('run'), run: RunSnapshotSchema }).strict(),
  z.object({ type: z.literal('workspaces') }).strict(),
]);

export const WorkspaceCreateRequestSchema = z.object({ name: z.string().min(1), path: z.string().min(1), defaultWorkflowId: z.string().optional() }).strict();
export const WorkspacePatchRequestSchema = WorkspaceCreateRequestSchema.partial();
export const WorkflowCreateRequestSchema = WorkflowDefSchema.omit({ builtin: true });
export const WorkflowPatchRequestSchema = WorkflowCreateRequestSchema.partial();
