import { z } from 'zod';
import { ProviderIdSchema, type ProviderId } from './workflow.js';

export type ProviderSignInMode = 'paste-code' | 'device';

export interface ProviderInfo {
  id: ProviderId;
  tier: 'rich' | 'plain';
  ok: boolean;
  version?: string;
  detail?: string;
  installable: boolean;
  manualCommand?: string;
  models: string[];
  defaultModel: string;
  authAlert?: { message: string; at: number; runId: string };
  signInCommand?: string;
  signIn?: { mode: ProviderSignInMode; replacesExistingLogin?: boolean };
  updatable?: boolean;
  runtimeFamily?: 'claude' | 'codex';
  environmentCredential?: { name: string; configured: boolean };
}
export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema, tier: z.enum(['rich', 'plain']), ok: z.boolean(),
  version: z.string().optional(), detail: z.string().optional(), installable: z.boolean(), manualCommand: z.string().optional(),
  models: z.array(z.string()), defaultModel: z.string(),
  authAlert: z.object({ message: z.string(), at: z.number().int().nonnegative(), runId: z.string() }).strict().optional(),
  signInCommand: z.string().optional(),
  signIn: z.object({ mode: z.enum(['paste-code', 'device']), replacesExistingLogin: z.boolean().optional() }).strict().optional(),
  updatable: z.boolean().optional(),
  runtimeFamily: z.enum(['claude', 'codex']).optional(),
  environmentCredential: z.object({ name: z.string(), configured: z.boolean() }).strict().optional(),
}).strict();
export const ProviderListSchema = z.array(ProviderInfoSchema);

export const OpenRouterModelVersionSchema = z.object({
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(512),
  kind: z.enum(['latest', 'current', 'pinned']),
  supportsTools: z.boolean(),
  created: z.number().int().nonnegative().optional(),
}).strict();
export type OpenRouterModelVersion = z.infer<typeof OpenRouterModelVersionSchema>;

export const OpenRouterModelGroupSchema = z.object({
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(512),
  versions: z.array(OpenRouterModelVersionSchema).min(1).max(10_001),
  defaultVersion: z.string().min(1).max(512),
}).strict().superRefine((group, context) => {
  if (!group.versions.some((version) => version.id === group.defaultVersion)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultVersion'],
      message: 'defaultVersion must identify one of the group versions',
    });
  }
});
export type OpenRouterModelGroup = z.infer<typeof OpenRouterModelGroupSchema>;

export const OpenRouterModelCatalogSchema = z.object({
  groups: z.array(OpenRouterModelGroupSchema).max(10_000),
  source: z.enum(['live', 'stale', 'fallback']),
}).strict();
export type OpenRouterModelCatalog = z.infer<typeof OpenRouterModelCatalogSchema>;

export interface ProviderInstallResponse {
  ok: boolean;
  manualCommand?: string;
  exitCode?: number | null;
  logTail?: string;
  provider?: ProviderInfo;
}

export interface ProviderSignInStartResponse {
  ok: boolean;
  loginId?: string;
  mode?: ProviderSignInMode;
  url?: string;
  userCode?: string;
  outputExcerpt?: string;
  error?: string;
}
export interface ProviderSignInStatusResponse {
  phase: 'pending' | 'succeeded' | 'failed';
  url?: string;
  userCode?: string;
  outputExcerpt?: string;
  statusDetail?: string;
  error?: string;
}
export interface ProviderSignInCodeResponse {
  ok: boolean;
  statusDetail?: string;
  outputExcerpt?: string;
  error?: string;
}
export const ProviderSignInCodeRequestSchema = z.object({ loginId: z.string().min(1), code: z.string().min(1).max(512) }).strict();
export const ProviderSignInCancelRequestSchema = z.object({ loginId: z.string().min(1) }).strict();

export const ClaudeAccountSchema = z.object({
  id: z.string(),
  email: z.string(),
  subscriptionType: z.string().optional(),
  isDefault: z.boolean().optional(),
  createdAt: z.string().optional(),
}).strict();
export const ClaudeAccountIndexResponseSchema = z.object({
  accounts: z.array(ClaudeAccountSchema),
  activeAccountId: z.string().optional(),
}).strict();
export type ClaudeAccountIndexResponse = z.infer<typeof ClaudeAccountIndexResponseSchema>;

export const CodexAccountSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  accountId: z.string().optional(),
  label: z.string(),
  sourceHome: z.string().optional(),
  createdAt: z.string(),
  needsLogin: z.boolean(),
  lastValidatedAt: z.string().optional(),
  lastInvalidatedAt: z.string().optional(),
  lastAuthError: z.string().optional(),
}).strict();
export type CodexAccount = z.infer<typeof CodexAccountSchema>;

export const CodexAccountIndexSchema = z.object({
  schemaVersion: z.literal(1),
  migrated: z.boolean(),
  activeAccountId: z.string().optional(),
  accounts: z.array(CodexAccountSchema),
}).strict();
export type CodexAccountIndex = z.infer<typeof CodexAccountIndexSchema>;

// Codex account ids double as path segments in the server's account store;
// both the API schema and the store enforce this same alphabet.
export const CODEX_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const CodexAccountIdRequestSchema = z.object({ accountId: z.string().regex(CODEX_ACCOUNT_ID_PATTERN) }).strict();
export const CodexAccountOperationResponseSchema = z.object({
  ok: z.boolean(),
  account: CodexAccountSchema.optional(),
  removed: z.boolean().optional(),
  error: z.string().optional(),
}).strict();
export const CodexAccountCaptureResponseSchema = CodexAccountOperationResponseSchema;
export const CodexAccountSwitchResponseSchema = CodexAccountOperationResponseSchema;
export const CodexAccountRemoveResponseSchema = CodexAccountOperationResponseSchema;

export const CodexApiKeyStatusResponseSchema = z.object({
  configured: z.boolean(),
  source: z.enum(['file', 'env']).optional(),
}).strict();
export const CodexApiKeySetRequestSchema = z.object({ key: z.string().trim().min(1) }).strict();
export const CodexApiKeySetResponseSchema = CodexApiKeyStatusResponseSchema;
export const CodexApiKeyClearResponseSchema = CodexApiKeyStatusResponseSchema;
export type CodexApiKeyStatusResponse = z.infer<typeof CodexApiKeyStatusResponseSchema>;
