import { isAbsolute } from 'node:path';
import { clearVersionCache, probeVersion } from '../adapters/base.js';
import { loadRuntimeCatalog, type RuntimeCatalog, type RuntimeFamily } from './catalog.js';
import { managedBinaryPath, probeRuntime } from './install.js';

const ENV_NAMES: Record<RuntimeFamily, string> = { claude: 'MAT_CLAUDE_BIN', codex: 'MAT_CODEX_BIN', node: 'MAT_NODE_BIN' };
const COMMANDS: Record<RuntimeFamily, string> = { claude: 'claude', codex: 'codex', node: 'node' };
const cache = new Map<RuntimeFamily, string | null>();
const managedSeen = new Map<RuntimeFamily, boolean>();

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  catalog?: RuntimeCatalog;
  probeManaged?: (path: string, timeoutMs: number) => Promise<boolean>;
  probePath?: (command: string) => Promise<{ ok: boolean }>;
  platform?: NodeJS.Platform;
  arch?: string;
}

export async function resolveRuntimeBinary(dataDir: string, family: RuntimeFamily, options: ResolveOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const override = env[ENV_NAMES[family]];
  if (override !== undefined) {
    // Environment overrides are intentionally unconditional so invalid configuration fails loudly.
    if (!isAbsolute(override)) throw new Error(`${ENV_NAMES[family]} must be an absolute path`);
    return override;
  }
  const catalog = options.catalog ?? loadRuntimeCatalog();
  const platform = options.platform ?? process.platform;
  const key = `${platform}-${options.arch ?? process.arch}`;
  const managed = managedBinaryPath(dataDir, family, catalog, key, platform);
  const isManaged = await (options.probeManaged ?? probeRuntime)(managed, 5_000);
  if (isManaged && managedSeen.get(family) !== true) {
    cache.delete(family);
    clearVersionCache(COMMANDS[family]);
  }
  managedSeen.set(family, isManaged);
  if (isManaged) { cache.set(family, managed); return managed; }
  if (cache.get(family) === managed) cache.delete(family);
  if (cache.has(family)) return cache.get(family)!;
  const command = COMMANDS[family];
  const found = (await (options.probePath ?? probeVersion)(command)).ok ? command : null;
  cache.set(family, found);
  return found;
}

export function clearRuntimeResolutionCache(family?: RuntimeFamily): void {
  if (family) { cache.delete(family); managedSeen.delete(family); }
  else { cache.clear(); managedSeen.clear(); }
}
