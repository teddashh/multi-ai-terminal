import { z } from 'zod';

export type EventRole = 'user' | 'agent' | 'tool' | 'thinking' | 'system' | 'decision';
export type EventKind =
  | 'message' | 'thinking' | 'tool_use' | 'tool_result'
  | 'status'
  | 'decision'
  | 'error'
  | 'result';

export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number }

export interface AgentEvent {
  id: string;
  seq: number;
  runId: string;
  stageId: string | null;
  nodeRunId: string | null;
  attempt: number;
  role: EventRole;
  kind: EventKind;
  text: string;
  tool?: { toolCallId?: string; name: string; input?: string; output?: string; isError?: boolean };
  data?: Record<string, unknown>;
  ts: number;
}

export const EventRoleSchema = z.enum(['user', 'agent', 'tool', 'thinking', 'system', 'decision']);
export const EventKindSchema = z.enum(['message', 'thinking', 'tool_use', 'tool_result', 'status', 'decision', 'error', 'result']);
export const UsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
}).strict();
export const EventToolSchema = z.object({
  toolCallId: z.string().optional(),
  name: z.string(),
  input: z.string().optional(),
  output: z.string().optional(),
  isError: z.boolean().optional(),
}).strict();
export const AdapterContentEventSchema = z.object({
  role: EventRoleSchema,
  kind: z.enum(['message', 'thinking', 'tool_use', 'tool_result']),
  text: z.string(),
  tool: EventToolSchema.optional(),
  data: z.record(z.unknown()).optional(),
}).strict();
export type AdapterContentEvent = z.infer<typeof AdapterContentEventSchema>;
export const AgentEventSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  runId: z.string().min(1),
  stageId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  role: EventRoleSchema,
  kind: EventKindSchema,
  text: z.string(),
  tool: EventToolSchema.optional(),
  data: z.record(z.unknown()).optional(),
  ts: z.number().int().nonnegative(),
}).strict();
