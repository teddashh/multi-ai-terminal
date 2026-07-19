import { z } from 'zod';
import { UsageSchema, type Usage } from './events.js';
import { AgentBindingSchema, WorkflowDefSchema, type AgentBinding, type WorkflowDef } from './workflow.js';

export type NodeRunStatus = 'queued'|'running'|'stalled'|'done'|'failed'|'killed';
export const TERMINAL_NODE_STATUSES = ['done', 'failed', 'killed'] as const satisfies readonly NodeRunStatus[];
export type RunStatus = 'created'|'running'|'gating'|'done'|'failed'|'aborted';
export interface VerificationResult {
  status: 'passed' | 'failed' | 'error' | 'skipped';
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputTail?: string;
  reason?: string;
  logFile?: string;
}
export interface NodeHandoff {
  priorNodeRunIds: string[];
  orchestratorContext: boolean;
  retryAddendum: boolean;
}
export interface NodeRun {
  nodeRunId: string;
  stageId: string | null;
  slotId: string; instanceIndex: number;
  agent: AgentBinding; label: string;
  status: NodeRunStatus;
  attempt: number;
  cwd: string;
  pid?: number;
  sessionRef?: string;
  startedAt?: number; endedAt?: number;
  usage?: Usage;
  resultText?: string;
  error?: string;
  patchFile?: string;
  baseCommit?: string;
  exitCode?: number | null;
  verification?: VerificationResult;
  handoff?: NodeHandoff;
}
export interface GateDecision {
  stageId: string; gateAttempt: number;
  action: 'advance'|'retry'|'abort';
  retryNodeRunIds?: string[];
  promptAddendum?: string;
  contextForNext?: string;
  rationale: string;
  raw?: string;
  degraded?: boolean;
  ts: number;
}
export interface RunSnapshot {
  runId: string; workspaceId: string;
  workflow: WorkflowDef;
  task: string; status: RunStatus;
  currentStageId?: string;
  nodes: NodeRun[];
  gateDecisions: GateDecision[];
  providerVersions?: Record<string, string>;
  createdAt: number; endedAt?: number;
}

export const NodeRunStatusSchema = z.enum(['queued', 'running', 'stalled', 'done', 'failed', 'killed']);
export const RunStatusSchema = z.enum(['created', 'running', 'gating', 'done', 'failed', 'aborted']);
export const VerificationResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  command: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outputTail: z.string().max(2000).optional(),
  reason: z.string().optional(),
  logFile: z.string().optional(),
}).strict();
export const NodeHandoffSchema = z.object({
  priorNodeRunIds: z.array(z.string()),
  orchestratorContext: z.boolean(),
  retryAddendum: z.boolean(),
}).strict();
export const NodeRunSchema = z.object({
  nodeRunId: z.string().min(1), stageId: z.string().nullable(), slotId: z.string().min(1),
  instanceIndex: z.number().int().nonnegative(), agent: AgentBindingSchema, label: z.string(),
  status: NodeRunStatusSchema, attempt: z.number().int().positive(), cwd: z.string(),
  pid: z.number().int().positive().optional(), sessionRef: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(), endedAt: z.number().int().nonnegative().optional(),
  usage: UsageSchema.optional(), resultText: z.string().optional(), error: z.string().optional(), patchFile: z.string().optional(),
  baseCommit: z.string().optional(), exitCode: z.number().int().nullable().optional(),
  verification: VerificationResultSchema.optional(), handoff: NodeHandoffSchema.optional(),
}).strict();
export const GateDecisionSchema = z.object({
  stageId: z.string().min(1), gateAttempt: z.number().int().positive(),
  action: z.enum(['advance', 'retry', 'abort']), retryNodeRunIds: z.array(z.string()).optional(),
  promptAddendum: z.string().optional(), contextForNext: z.string().optional(), rationale: z.string(),
  raw: z.string().optional(), degraded: z.boolean().optional(), ts: z.number().int().nonnegative(),
}).strict();
export const RunSnapshotSchema = z.object({
  runId: z.string().min(1), workspaceId: z.string().min(1), workflow: WorkflowDefSchema,
  task: z.string(), status: RunStatusSchema, currentStageId: z.string().optional(),
  nodes: z.array(NodeRunSchema), gateDecisions: z.array(GateDecisionSchema),
  providerVersions: z.record(z.string()).optional(),
  createdAt: z.number().int().nonnegative(), endedAt: z.number().int().nonnegative().optional(),
}).strict();
