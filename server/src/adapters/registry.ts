import type { ProviderId, ProviderInfo } from '@mat/shared';
import { agyAdapter } from './agy.js';
import type { Adapter } from './base.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';
import { mockAdapter } from './mock.js';

export const adapters: Readonly<Record<ProviderId, Adapter>> = { claude: claudeAdapter, codex: codexAdapter, grok: grokAdapter, agy: agyAdapter, mock: mockAdapter };
export const adapterRegistry = adapters;
export const getAdapter = (id: ProviderId): Adapter => adapters[id];
export async function listProviders(): Promise<ProviderInfo[]> {
  return Promise.all(Object.values(adapters).map(async (adapter) => ({ id: adapter.id, tier: adapter.tier, ...(await adapter.available()), models: adapter.models, defaultModel: adapter.defaultModel })));
}
