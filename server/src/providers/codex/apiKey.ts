import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '../../store/dataDir.js';

export interface OpenAiKeyOptions { dataDir?: string; env?: NodeJS.ProcessEnv }
export type ConfiguredOpenAiKey = { key: string; source: 'file' | 'env' };

const keyPath = (dataDir = getDataDir()): string => join(dataDir, 'openai-api-key.bin');

// A desktop-native keyring is intentionally deferred: MAT's server is headless,
// so the BAT-compatible baseline is the protected file followed by environment.
export function configuredOpenAiKey(options: OpenAiKeyOptions = {}): ConfiguredOpenAiKey | null {
  const dataDir = options.dataDir ?? getDataDir();
  try {
    const key = readFileSync(keyPath(dataDir), 'utf8').trim();
    if (key) return { key, source: 'file' };
  } catch { /* missing/unreadable file falls through to the environment */ }
  const key = (options.env ?? process.env).OPENAI_API_KEY;
  return key?.trim() ? { key: key.trim(), source: 'env' } : null;
}

export function setOpenAiKey(key: string, options: Pick<OpenAiKeyOptions, 'dataDir'> = {}): void {
  const clean = key.trim();
  if (!clean) throw new Error('OpenAI API key must not be empty.');
  const path = keyPath(options.dataDir);
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, clean, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function clearOpenAiKey(options: Pick<OpenAiKeyOptions, 'dataDir'> = {}): void {
  rmSync(keyPath(options.dataDir), { force: true });
}
