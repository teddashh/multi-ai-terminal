import { z } from 'zod';

export type ProviderId = 'claude' | 'codex' | 'grok' | 'agy' | 'mock';
export interface AgentBinding {
  provider: ProviderId;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  permission: 'safe' | 'auto' | 'full';
  systemPromptAppend?: string;
  maxTurns?: number;
}
export interface Slot {
  id: string; label: string;
  agent: AgentBinding;
  count: number;
  promptTemplate: string;
}
export interface Stage {
  id: string; name: string;
  slots: Slot[];
  isolation: 'none' | 'worktree';
  join: 'all';
  timeoutSec: number;
  stallSec: number;
  gate: boolean;
}
export interface OrchestratorConfig {
  enabled: boolean;
  agent: AgentBinding;
  gateTimeoutSec: number;
}
export interface WorkflowDef {
  schemaVersion: 1;
  id: string; name: string; description: string;
  builtin?: boolean;
  orchestrator: OrchestratorConfig;
  stages: Stage[];
  maxParallel: number;
  maxRetriesPerStage: number;
}

export const ProviderIdSchema = z.enum(['claude', 'codex', 'grok', 'agy', 'mock']);
export const WorkflowIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'must be 1-64 letters, numbers, underscores, or hyphens');
export const AgentBindingSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  permission: z.enum(['safe', 'auto', 'full']).default('auto'),
  systemPromptAppend: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
}).strict();
export const SlotSchema = z.object({
  id: WorkflowIdSchema,
  label: z.string().min(1),
  agent: AgentBindingSchema,
  count: z.number().int().min(1).max(8),
  promptTemplate: z.string(),
}).strict();
export const StageSchema = z.object({
  id: WorkflowIdSchema,
  name: z.string().min(1),
  slots: z.array(SlotSchema).min(1),
  isolation: z.enum(['none', 'worktree']).default('none'),
  join: z.literal('all').default('all'),
  timeoutSec: z.number().int().positive().default(1800),
  stallSec: z.number().int().positive().default(240),
  gate: z.boolean().default(true),
}).strict().superRefine((stage, ctx) => {
  const count = stage.slots.reduce((sum, slot) => sum + slot.count, 0);
  if (count > 12) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stage fan-out must not exceed 12', path: ['slots'] });
});
export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean(),
  agent: AgentBindingSchema.default({ provider: 'claude', model: 'sonnet', permission: 'auto' }),
  gateTimeoutSec: z.number().int().positive().default(300),
}).strict();
export const WorkflowDefSchema = z.object({
  schemaVersion: z.literal(1),
  id: WorkflowIdSchema,
  name: z.string().min(1),
  description: z.string(),
  builtin: z.boolean().optional(),
  orchestrator: OrchestratorConfigSchema,
  stages: z.array(StageSchema).min(1),
  maxParallel: z.number().int().positive().default(4),
  maxRetriesPerStage: z.number().int().nonnegative().default(2),
}).strict();

export const DEFAULT_AGENT_BINDING: AgentBinding = { provider: 'claude', model: 'sonnet', permission: 'auto' };
export const DEFAULT_STAGE = { isolation: 'none', join: 'all', timeoutSec: 1800, stallSec: 240, gate: true } as const;
export const DEFAULT_ORCHESTRATOR: OrchestratorConfig = { enabled: true, agent: DEFAULT_AGENT_BINDING, gateTimeoutSec: 300 };
export const applyAgentBindingDefaults = (value: unknown): AgentBinding => AgentBindingSchema.parse(value) as AgentBinding;
export const applyStageDefaults = (value: unknown): Stage => StageSchema.parse(value) as Stage;
export const applyWorkflowDefaults = (value: unknown): WorkflowDef => WorkflowDefSchema.parse(value) as WorkflowDef;
