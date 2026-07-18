import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface DataDirOptions { dataDir?: string | undefined; env?: NodeJS.ProcessEnv | undefined; homeDir?: string | undefined }
let configuredDataDir: string | undefined;

export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = options.dataDir ?? env.MAT_DATA_DIR ?? resolve(options.homeDir ?? homedir(), '.multi-ai-terminal');
  const path = resolve(selected);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Sets the process-wide data root used by every runtime module after server boot. */
export function configureDataDir(path: string): string {
  configuredDataDir = resolveDataDir({ dataDir: path });
  return configuredDataDir;
}

export function getDataDir(): string {
  return configuredDataDir ?? resolveDataDir();
}
