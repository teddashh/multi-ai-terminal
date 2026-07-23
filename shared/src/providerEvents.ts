import { z } from 'zod';

const NonemptyStringSchema = z.string().min(1);
const NullableStringSchema = z.string().nullable();
const NonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const NonnegativeFiniteIntegerSchema = NonnegativeFiniteNumberSchema.int();

/**
 * Full provider-session snapshot carried by every status event.
 *
 * All fields are required on purpose: consumers must never merge a partial
 * status patch into stale state. Null/zero/false are the wire defaults when a
 * provider cannot supply a value.
 */
export const ProviderSessionMetaSchema = z.object({
  permissionMode: z.string(),
  model: NullableStringSchema,
  effort: NullableStringSchema,
  ultracode: z.boolean(),
  autoCompactWindow: NonnegativeFiniteNumberSchema.nullable(),
  sdkSessionId: NullableStringSchema,
  cwd: NullableStringSchema,
  totalCost: NonnegativeFiniteNumberSchema,
  inputTokens: NonnegativeFiniteNumberSchema,
  outputTokens: NonnegativeFiniteNumberSchema,
  durationMs: NonnegativeFiniteNumberSchema,
  numTurns: NonnegativeFiniteIntegerSchema,
  contextWindow: NonnegativeFiniteNumberSchema,
  maxOutputTokens: NonnegativeFiniteNumberSchema,
  contextTokens: NonnegativeFiniteNumberSchema,
  cacheReadTokens: NonnegativeFiniteNumberSchema,
  cacheCreationTokens: NonnegativeFiniteNumberSchema,
  callCacheRead: NonnegativeFiniteNumberSchema,
  callCacheWrite: NonnegativeFiniteNumberSchema,
  lastQueryCalls: NonnegativeFiniteNumberSchema,
  isStreaming: z.boolean(),
  runtimeStatus: NullableStringSchema,
  runtimeMessage: NullableStringSchema,
  runtimeStatusStartedAt: NonnegativeFiniteNumberSchema.nullable(),
}).strict();
export type ProviderSessionMeta = z.infer<typeof ProviderSessionMetaSchema>;

export const ProviderMessageSchema = z.object({
  id: NonemptyStringSchema,
  // BAT's renderer-facing message shape carries the owning session both in
  // the event envelope and on the message/history item itself.
  sessionId: NonemptyStringSchema,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  thinking: z.string().optional(),
  parentToolUseId: NonemptyStringSchema.nullable().optional(),
  timestamp: NonnegativeFiniteIntegerSchema,
}).strict();
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>;

export const ProviderToolUseSchema = z.object({
  id: NonemptyStringSchema,
  sessionId: NonemptyStringSchema,
  toolName: NonemptyStringSchema,
  // Tool inputs are authored by the provider and vary by tool.
  input: z.unknown(),
  status: z.literal('running'),
  parentToolUseId: NonemptyStringSchema.nullable().optional(),
  timestamp: NonnegativeFiniteIntegerSchema.optional(),
}).strict();
export type ProviderToolUse = z.infer<typeof ProviderToolUseSchema>;

export const ProviderToolResultSchema = z.object({
  id: NonemptyStringSchema,
  status: z.enum(['completed', 'error']),
  // Tool result bodies are provider-defined JSON values.
  result: z.unknown().optional(),
}).strict();
export type ProviderToolResult = z.infer<typeof ProviderToolResultSchema>;

export const ProviderStreamDataSchema = z.object({
  text: z.string().optional(),
  thinking: z.string().optional(),
  parentToolUseId: NonemptyStringSchema.nullable().optional(),
}).strict().refine(
  (value) => value.text !== undefined || value.thinking !== undefined,
  { message: 'stream data must contain text or thinking' },
);
export type ProviderStreamData = z.infer<typeof ProviderStreamDataSchema>;

export const ProviderTurnUsageSchema = z.object({
  inputTokens: NonnegativeFiniteNumberSchema.optional(),
  outputTokens: NonnegativeFiniteNumberSchema.optional(),
  costUsd: NonnegativeFiniteNumberSchema.optional(),
}).strict();
export type ProviderTurnUsage = z.infer<typeof ProviderTurnUsageSchema>;

export const ProviderTurnEndReasonSchema = z.enum(['completed', 'error', 'interrupted', 'aborted']);
export type ProviderTurnEndReason = z.infer<typeof ProviderTurnEndReasonSchema>;

export const ProviderTurnEndPayloadSchema = z.object({
  reason: ProviderTurnEndReasonSchema,
  result: z.string().optional(),
  error: z.string().optional(),
  sdkSessionId: NonemptyStringSchema.optional(),
  turnId: NonemptyStringSchema.optional(),
  usage: ProviderTurnUsageSchema.optional(),
}).strict();
export type ProviderTurnEndPayload = z.infer<typeof ProviderTurnEndPayloadSchema>;

export const ProviderRateLimitInfoSchema = z.object({
  rateLimitType: NonemptyStringSchema,
  resetsAt: NonnegativeFiniteNumberSchema,
  utilization: NonnegativeFiniteNumberSchema.nullable(),
  isUsingOverage: z.boolean(),
}).strict();
export type ProviderRateLimitInfo = z.infer<typeof ProviderRateLimitInfoSchema>;

export const ProviderTaskSchema = z.object({
  id: NonemptyStringSchema,
  toolUseId: NonemptyStringSchema.nullable(),
  type: NonemptyStringSchema.nullable(),
  status: NonemptyStringSchema,
  isWorkflow: z.boolean(),
  workflowName: z.string().nullable(),
  subagentType: z.string().nullable(),
  description: z.string(),
  startedAt: NonnegativeFiniteIntegerSchema,
  error: z.string().optional(),
  isBackground: z.boolean().optional(),
  skipTranscript: z.boolean().optional(),
}).strict();
export type ProviderTask = z.infer<typeof ProviderTaskSchema>;

export const ProviderPermissionRequestDataSchema = z.object({
  toolUseId: NonemptyStringSchema,
  toolName: NonemptyStringSchema,
  // Tool input and SDK permission suggestions vary by provider/tool.
  input: z.unknown(),
  suggestions: z.array(z.record(z.unknown())).optional(),
  decisionReason: z.string().optional(),
}).strict();
export type ProviderPermissionRequestData = z.infer<typeof ProviderPermissionRequestDataSchema>;

export const ProviderAskUserDataSchema = z.object({
  toolUseId: NonemptyStringSchema,
  // AskUserQuestion owns the question record shape, not the provider manager.
  questions: z.array(z.record(z.unknown())),
}).strict();
export type ProviderAskUserData = z.infer<typeof ProviderAskUserDataSchema>;

export const ProviderHistoryMessageSchema = ProviderMessageSchema;
export const ProviderHistoryToolSchema = z.object({
  id: NonemptyStringSchema,
  sessionId: NonemptyStringSchema,
  toolName: NonemptyStringSchema,
  input: z.unknown(),
  status: z.enum(['running', 'completed', 'error']),
  result: z.unknown().optional(),
  parentToolUseId: NonemptyStringSchema.nullable().optional(),
  timestamp: NonnegativeFiniteIntegerSchema.optional(),
}).strict();
export const ProviderHistoryItemSchema = z.union([
  ProviderHistoryMessageSchema,
  ProviderHistoryToolSchema,
]);
export type ProviderHistoryItem = z.infer<typeof ProviderHistoryItemSchema>;

export const ProviderWorktreeInfoSchema = z.object({
  branchName: NonemptyStringSchema,
  worktreePath: NonemptyStringSchema,
  sourceBranch: NonemptyStringSchema,
  gitRoot: NonemptyStringSchema,
}).strict();
export type ProviderWorktreeInfo = z.infer<typeof ProviderWorktreeInfoSchema>;

export const ProviderEventTypeSchema = z.enum([
  'claude:message',
  'claude:tool-use',
  'claude:tool-result',
  'claude:stream',
  'claude:status',
  'claude:result',
  'claude:turn-end',
  'claude:error',
  'claude:rate-limit',
  'claude:task',
  'claude:permission-request',
  'claude:permission-resolved',
  'claude:ask-user',
  'claude:ask-user-resolved',
  'claude:modeChange',
  'claude:history',
  'claude:resume-loading',
  'claude:session-reset',
  'claude:worktree-info',
]);
export type ProviderEventType = z.infer<typeof ProviderEventTypeSchema>;

const MessageEventSchema = z.object({
  type: z.literal('claude:message'),
  sessionId: NonemptyStringSchema,
  message: ProviderMessageSchema,
}).strict();

const ToolUseEventSchema = z.object({
  type: z.literal('claude:tool-use'),
  sessionId: NonemptyStringSchema,
  toolCall: ProviderToolUseSchema,
}).strict();

const ToolResultEventSchema = z.object({
  type: z.literal('claude:tool-result'),
  sessionId: NonemptyStringSchema,
  result: ProviderToolResultSchema,
}).strict();

const StreamEventSchema = z.object({
  type: z.literal('claude:stream'),
  sessionId: NonemptyStringSchema,
  data: ProviderStreamDataSchema,
}).strict();

const StatusEventSchema = z.object({
  type: z.literal('claude:status'),
  sessionId: NonemptyStringSchema,
  meta: ProviderSessionMetaSchema,
}).strict();

const ResultEventSchema = z.object({
  type: z.literal('claude:result'),
  sessionId: NonemptyStringSchema,
  // Result frames are the one intentionally raw provider payload.
  result: z.record(z.unknown()),
}).strict();

const TurnEndEventSchema = z.object({
  type: z.literal('claude:turn-end'),
  sessionId: NonemptyStringSchema,
  payload: ProviderTurnEndPayloadSchema,
}).strict();

const ErrorEventSchema = z.object({
  type: z.literal('claude:error'),
  sessionId: NonemptyStringSchema,
  error: NonemptyStringSchema,
}).strict();

const RateLimitEventSchema = z.object({
  type: z.literal('claude:rate-limit'),
  sessionId: NonemptyStringSchema,
  info: ProviderRateLimitInfoSchema,
}).strict();

const TaskEventSchema = z.object({
  type: z.literal('claude:task'),
  sessionId: NonemptyStringSchema,
  task: ProviderTaskSchema,
}).strict();

const PermissionRequestEventSchema = z.object({
  type: z.literal('claude:permission-request'),
  sessionId: NonemptyStringSchema,
  data: ProviderPermissionRequestDataSchema,
}).strict();

const PermissionResolvedEventSchema = z.object({
  type: z.literal('claude:permission-resolved'),
  sessionId: NonemptyStringSchema,
  toolUseId: NonemptyStringSchema,
}).strict();

const AskUserEventSchema = z.object({
  type: z.literal('claude:ask-user'),
  sessionId: NonemptyStringSchema,
  data: ProviderAskUserDataSchema,
}).strict();

const AskUserResolvedEventSchema = z.object({
  type: z.literal('claude:ask-user-resolved'),
  sessionId: NonemptyStringSchema,
  toolUseId: NonemptyStringSchema,
}).strict();

const ModeChangeEventSchema = z.object({
  type: z.literal('claude:modeChange'),
  sessionId: NonemptyStringSchema,
  mode: NonemptyStringSchema,
}).strict();

const HistoryEventSchema = z.object({
  type: z.literal('claude:history'),
  sessionId: NonemptyStringSchema,
  items: z.array(ProviderHistoryItemSchema),
}).strict();

const ResumeLoadingEventSchema = z.object({
  type: z.literal('claude:resume-loading'),
  sessionId: NonemptyStringSchema,
  loading: z.boolean(),
}).strict();

const SessionResetEventSchema = z.object({
  type: z.literal('claude:session-reset'),
  sessionId: NonemptyStringSchema,
}).strict();

const WorktreeInfoEventSchema = z.object({
  type: z.literal('claude:worktree-info'),
  sessionId: NonemptyStringSchema,
  payload: ProviderWorktreeInfoSchema.nullable(),
}).strict();

/** BAT's provider-neutral 19-event manager surface. */
export const ProviderEventSchema = z.discriminatedUnion('type', [
  MessageEventSchema,
  ToolUseEventSchema,
  ToolResultEventSchema,
  StreamEventSchema,
  StatusEventSchema,
  ResultEventSchema,
  TurnEndEventSchema,
  ErrorEventSchema,
  RateLimitEventSchema,
  TaskEventSchema,
  PermissionRequestEventSchema,
  PermissionResolvedEventSchema,
  AskUserEventSchema,
  AskUserResolvedEventSchema,
  ModeChangeEventSchema,
  HistoryEventSchema,
  ResumeLoadingEventSchema,
  SessionResetEventSchema,
  WorktreeInfoEventSchema,
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
