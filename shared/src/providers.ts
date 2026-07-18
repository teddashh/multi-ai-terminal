import { z } from 'zod';
import { ProviderIdSchema, type ProviderId } from './workflow.js';

export interface ProviderInfo {
  id: ProviderId;
  tier: 'rich' | 'plain';
  ok: boolean;
  version?: string;
  detail?: string;
  models: string[];
  defaultModel: string;
}
export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema, tier: z.enum(['rich', 'plain']), ok: z.boolean(),
  version: z.string().optional(), detail: z.string().optional(), models: z.array(z.string()), defaultModel: z.string(),
}).strict();
export const ProviderListSchema = z.array(ProviderInfoSchema);
