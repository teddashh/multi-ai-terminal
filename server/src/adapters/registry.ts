import type { ProviderId, ProviderInfo } from '@mat/shared';
import { agyAdapter } from './agy.js';
import type { Adapter } from './base.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';
import { mockAdapter } from './mock.js';
import { providerInstallPlan } from '../providers/install.js';
import { getAuthAlert, signInCommand } from '../providers/auth.js';

export const adapters: Readonly<Record<ProviderId, Adapter>> = { claude: claudeAdapter, codex: codexAdapter, grok: grokAdapter, agy: agyAdapter, mock: mockAdapter };
export const adapterRegistry = adapters;
export const getAdapter = (id: ProviderId): Adapter => adapters[id];
export async function listProviders(): Promise<ProviderInfo[]> {
  return Promise.all(Object.values(adapters).map(async (adapter) => {
    const install = providerInstallPlan(adapter.id);
    const authAlert = getAuthAlert(adapter.id);
    const command = signInCommand(adapter.id);
    return {
      id: adapter.id, tier: adapter.tier, ...(await adapter.available()), installable: install.recipe !== undefined,
      ...(install.manualCommand ? { manualCommand: install.manualCommand } : {}), models: adapter.models, defaultModel: adapter.defaultModel,
      ...(authAlert ? { authAlert: { message: authAlert.message, at: authAlert.at, runId: authAlert.runId } } : {}),
      ...(command ? { signInCommand: command } : {}),
    };
  }));
}
