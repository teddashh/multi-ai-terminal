import {
  createCodexSessionRuntime,
  type CodexRuntimeOverrides,
  type CodexRuntimeProfile,
  type CodexSessionRuntime,
} from '../codex/runtime.js';
import { ensureOpenRouterCodexHome, OPENROUTER_ENV_KEY } from './config.js';

export const OPENROUTER_DEFAULT_MODEL = '~openai/gpt-latest';
export const OPENROUTER_MODELS = [
  OPENROUTER_DEFAULT_MODEL,
  '~anthropic/claude-sonnet-latest',
] as const;

const openRouterProfile: CodexRuntimeProfile = {
  providerName: 'openrouter',
  defaultModel: OPENROUTER_DEFAULT_MODEL,
  modelProvider: 'openrouter',
  prepareConnection: async (dataDir) => {
    const key = process.env[OPENROUTER_ENV_KEY]?.trim() || undefined;
    return {
      codexHome: await ensureOpenRouterCodexHome(dataDir),
      extraEnv: {
        // The value stays in memory and reaches only the child environment.
        // Config stores the fixed variable name, never the credential.
        [OPENROUTER_ENV_KEY]: key,
        // This profile is API-metered OpenRouter only. Never let an inherited
        // ChatGPT/Codex automation credential blur that account boundary.
        CODEX_ACCESS_TOKEN: undefined,
        CODEX_API_KEY: undefined,
      },
    };
  },
};

let singleton: CodexSessionRuntime | undefined;
let testOverrides: CodexRuntimeOverrides = {};

export function openRouterSessionRuntime(): CodexSessionRuntime {
  return singleton ??= createCodexSessionRuntime(openRouterProfile, testOverrides);
}

/** Dispose only an already-created production singleton; never create one during shutdown. */
export async function disposeOpenRouterSessionRuntime(): Promise<void> {
  const previous = singleton;
  singleton = undefined;
  await previous?.dispose();
}

export function resetOpenRouterSessionRuntimeForTest(overrides: CodexRuntimeOverrides = {}): void {
  const previous = singleton;
  singleton = undefined;
  testOverrides = overrides;
  if (previous) void previous.dispose();
}
