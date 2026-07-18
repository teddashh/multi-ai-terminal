import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface DataDirOptions { dataDir?: string | undefined; env?: NodeJS.ProcessEnv | undefined; homeDir?: string | undefined }
export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = options.dataDir ?? env.MAT_DATA_DIR ?? resolve(options.homeDir ?? homedir(), '.multi-ai-terminal');
  const path = resolve(selected);
  mkdirSync(path, { recursive: true });
  return path;
}
