import { z } from 'zod';
import { AgentEventSchema, type AgentEvent } from './events.js';
import { RunSnapshotSchema, RunStatusSchema, type RunSnapshot, type RunStatus } from './run.js';
import { WorkflowDefSchema, type WorkflowDef } from './workflow.js';

export interface Workspace {
  id: string; name: string; path: string;
  isGit: boolean;
  defaultWorkflowId?: string;
  verifyCommand?: string;
  verifyTimeoutSec?: number;
  lastRun?: {
    runId: string; workflowName: string; status: RunStatus; at: number;
    workflowId?: string;
    workflowBuiltin?: boolean;
  };
}
export interface RunCreateRequest {
  workspaceId: string;
  workflowId: string;
  task: string;
  workflowOverride?: WorkflowDef;
}
export interface RetryStageRequest { promptAddendum?: string }
export interface SteerRequest { text: string; mode?: 'interrupt'|'queue' }
export interface ApplyPatchResponse { ok: boolean; conflicts?: string[]; message: string }
export type RuntimeFamily = 'claude' | 'codex';
export interface RuntimeStatus {
  family: RuntimeFamily;
  state: 'managed' | 'external' | 'missing' | 'broken';
  managedVersion?: string;
  resolvedPath?: string;
  canInstallManaged: boolean;
}
export interface RuntimeChangedEvent {
  family: RuntimeFamily;
  state: RuntimeStatus['state'];
  managedVersion?: string;
  error?: string;
}
export type WsClientMsg = { type:'sub'|'unsub'; runId: string };
export type WsServerMsg =
  | { type:'event'; event: AgentEvent }
  | { type:'run'; run: RunSnapshot }
  | { type:'workspaces' }
  | { type:'runtime:changed'; event: RuntimeChangedEvent };

export const WorkspaceSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), path: z.string().min(1), isGit: z.boolean(),
  defaultWorkflowId: z.string().optional(),
  verifyCommand: z.string().optional(),
  verifyTimeoutSec: z.number().int().positive().optional(),
  lastRun: z.object({
    runId: z.string(), workflowName: z.string(), status: RunStatusSchema, at: z.number().int().nonnegative(),
    workflowId: z.string().optional(),
    workflowBuiltin: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export const RunCreateRequestSchema = z.object({
  workspaceId: z.string().min(1), workflowId: z.string().min(1), task: z.string().min(1), workflowOverride: WorkflowDefSchema.optional(),
}).strict();
export const RetryStageRequestSchema = z.object({ promptAddendum: z.string().optional() }).strict();
export const SteerRequestSchema = z.object({ text: z.string().min(1).max(4000), mode: z.enum(['interrupt', 'queue']).default('interrupt') }).strict();
export const ApplyPatchResponseSchema = z.object({ ok: z.boolean(), conflicts: z.array(z.string()).optional(), message: z.string() }).strict();
export const RuntimeFamilySchema = z.enum(['claude', 'codex']);
export const RuntimeStatusSchema = z.object({
  family: RuntimeFamilySchema,
  state: z.enum(['managed', 'external', 'missing', 'broken']),
  managedVersion: z.string().optional(), resolvedPath: z.string().optional(), canInstallManaged: z.boolean(),
}).strict();
export const RuntimeChangedEventSchema = z.object({
  family: RuntimeFamilySchema, state: z.enum(['managed', 'external', 'missing', 'broken']),
  managedVersion: z.string().optional(), error: z.string().optional(),
}).strict();
export const WsClientMsgSchema = z.object({ type: z.enum(['sub', 'unsub']), runId: z.string().min(1) }).strict();
export const WsServerMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: AgentEventSchema }).strict(),
  z.object({ type: z.literal('run'), run: RunSnapshotSchema }).strict(),
  z.object({ type: z.literal('workspaces') }).strict(),
  z.object({ type: z.literal('runtime:changed'), event: RuntimeChangedEventSchema }).strict(),
]);

export const WorkspaceCreateRequestSchema = z.object({
  name: z.string().min(1), path: z.string().min(1), defaultWorkflowId: z.string().optional(),
  verifyCommand: z.string().optional(), verifyTimeoutSec: z.number().int().positive().optional(),
}).strict();
// JSON null is the explicit clearing operation for optional verification settings.
export const WorkspacePatchRequestSchema = z.object({
  name: z.string().min(1).optional(), path: z.string().min(1).optional(), defaultWorkflowId: z.string().optional(),
  verifyCommand: z.string().nullable().optional(), verifyTimeoutSec: z.number().int().positive().nullable().optional(),
}).strict();
export const WorkflowCreateRequestSchema = WorkflowDefSchema.omit({ builtin: true });
export const WorkflowPatchRequestSchema = WorkflowCreateRequestSchema.partial();
