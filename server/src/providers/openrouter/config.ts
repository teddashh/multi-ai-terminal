import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getDataDir } from '../../store/dataDir.js';

export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';

export const OPENROUTER_CODEX_CONFIG = `[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "${OPENROUTER_ENV_KEY}"
wire_api = "responses"
requires_openai_auth = false
`;

export function openRouterCodexHome(dataDir = getDataDir()): string {
  return resolve(dataDir, 'openrouter-codex-home');
}

async function currentConfig(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Provisions only the fixed custom-provider config. Codex owns any session
 * state it creates beside this file; MAT never places auth.json or key bytes
 * in this isolated home.
 */
export async function ensureOpenRouterCodexHome(dataDir = getDataDir()): Promise<string> {
  const home = openRouterCodexHome(dataDir);
  const configPath = join(home, 'config.toml');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => undefined);
  if (await currentConfig(configPath) === OPENROUTER_CODEX_CONFIG) {
    await chmod(configPath, 0o600).catch(() => undefined);
    return home;
  }

  const temporary = join(home, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, OPENROUTER_CODEX_CONFIG, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    try {
      await rename(temporary, configPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await rm(configPath, { force: true });
      await rename(temporary, configPath);
    }
    await chmod(configPath, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return home;
}
