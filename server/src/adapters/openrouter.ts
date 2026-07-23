import { getDataDir } from '../store/dataDir.js';
import { resolveRuntimeBinary } from '../runtime/resolve.js';
import { OPENROUTER_ENV_KEY } from '../providers/openrouter/config.js';
import {
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_MODELS,
  openRouterSessionRuntime,
} from '../providers/openrouter/runtime.js';
import { probeVersion, type Adapter, type ResolvedNodeSpec, type SpawnedNode } from './base.js';

export function spawnOpenRouter(
  spec: ResolvedNodeSpec,
  io: Parameters<Adapter['spawn']>[1],
): SpawnedNode {
  return openRouterSessionRuntime().startRun(spec, io);
}

export const openRouterAdapter: Adapter = {
  id: 'openrouter',
  tier: 'rich',
  runtimeFamily: 'codex',
  environmentCredential: () => ({
    name: OPENROUTER_ENV_KEY,
    configured: typeof process.env[OPENROUTER_ENV_KEY] === 'string'
      && process.env[OPENROUTER_ENV_KEY]!.trim().length > 0,
  }),
  models: [...OPENROUTER_MODELS],
  defaultModel: OPENROUTER_DEFAULT_MODEL,
  available: async () => {
    const command = await resolveRuntimeBinary(getDataDir(), 'codex');
    return command ? probeVersion(command) : { ok: false };
  },
  spawn: spawnOpenRouter,
};

export default openRouterAdapter;
