import { z } from 'zod';
import { ProviderIdSchema, type ProviderId } from './workflow.js';

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
}
export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema, tier: z.enum(['rich', 'plain']), ok: z.boolean(),
  version: z.string().optional(), detail: z.string().optional(), installable: z.boolean(), manualCommand: z.string().optional(),
  models: z.array(z.string()), defaultModel: z.string(),
  authAlert: z.object({ message: z.string(), at: z.number().int().nonnegative(), runId: z.string() }).strict().optional(),
  signInCommand: z.string().optional(),
}).strict();
export const ProviderListSchema = z.array(ProviderInfoSchema);

export interface ProviderInstallResponse {
  ok: boolean;
  manualCommand?: string;
  exitCode?: number | null;
  logTail?: string;
  provider?: ProviderInfo;
}
