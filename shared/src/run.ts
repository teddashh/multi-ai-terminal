import { z } from 'zod';
import { UsageSchema, type Usage } from './events.js';
import { AgentBindingSchema, WorkflowDefSchema, type AgentBinding, type WorkflowDef } from './workflow.js';

export type NodeRunStatus = 'queued'|'running'|'stalled'|'done'|'failed'|'killed';
export const TERMINAL_NODE_STATUSES = ['done', 'failed', 'killed'] as const satisfies readonly NodeRunStatus[];
export type RunStatus = 'created'|'running'|'gating'|'done'|'failed'|'aborted';
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
  patchFile?: string;
  baseCommit?: string;
  exitCode?: number | null;
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
  createdAt: number; endedAt?: number;
}

export const NodeRunStatusSchema = z.enum(['queued', 'running', 'stalled', 'done', 'failed', 'killed']);
export const RunStatusSchema = z.enum(['created', 'running', 'gating', 'done', 'failed', 'aborted']);
export const NodeRunSchema = z.object({
  nodeRunId: z.string().min(1), stageId: z.string().nullable(), slotId: z.string().min(1),
  instanceIndex: z.number().int().nonnegative(), agent: AgentBindingSchema, label: z.string(),
  status: NodeRunStatusSchema, attempt: z.number().int().positive(), cwd: z.string(),
  pid: z.number().int().positive().optional(), sessionRef: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(), endedAt: z.number().int().nonnegative().optional(),
  usage: UsageSchema.optional(), resultText: z.string().optional(), patchFile: z.string().optional(),
  baseCommit: z.string().optional(), exitCode: z.number().int().nullable().optional(),
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
  createdAt: z.number().int().nonnegative(), endedAt: z.number().int().nonnegative().optional(),
}).strict();
