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
}
export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema, tier: z.enum(['rich', 'plain']), ok: z.boolean(),
  version: z.string().optional(), detail: z.string().optional(), installable: z.boolean(), manualCommand: z.string().optional(),
  models: z.array(z.string()), defaultModel: z.string(),
  authAlert: z.object({ message: z.string(), at: z.number().int().nonnegative(), runId: z.string() }).strict().optional(),
  signInCommand: z.string().optional(),
  signIn: z.object({ mode: z.enum(['paste-code', 'device']), replacesExistingLogin: z.boolean().optional() }).strict().optional(),
  updatable: z.boolean().optional(),
}).strict();
export const ProviderListSchema = z.array(ProviderInfoSchema);

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
