import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexExecEnv } from '../../src/adapters/codex.js';
import { clearOpenAiKey, configuredOpenAiKey, setOpenAiKey } from '../../src/providers/codex/apiKey.js';

const roots: string[] = [];
const dataDir = () => { const root = mkdtempSync(join(tmpdir(), 'mat-codex-key-')); roots.push(root); return root; };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('codex API-key chain', () => {
  it('prefers the file and falls back to the environment', () => {
    const dir = dataDir();
    expect(configuredOpenAiKey({ dataDir: dir, env: { OPENAI_API_KEY: 'env-fixture' } })).toEqual({ key: 'env-fixture', source: 'env' });
    setOpenAiKey('file-fixture', { dataDir: dir });
    expect(configuredOpenAiKey({ dataDir: dir, env: { OPENAI_API_KEY: 'env-fixture' } })).toEqual({ key: 'file-fixture', source: 'file' });
  });

  it('carries the key into the exec child env with file-beats-env precedence', () => {
    const dir = dataDir();
    const priorDataDir = process.env.MAT_DATA_DIR;
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.MAT_DATA_DIR = dir;
    delete process.env.OPENAI_API_KEY;
    try {
      expect('OPENAI_API_KEY' in codexExecEnv(process.execPath)).toBe(false);
      process.env.OPENAI_API_KEY = 'env-fixture';
      expect(codexExecEnv(process.execPath).OPENAI_API_KEY).toBe('env-fixture');
      setOpenAiKey('file-fixture', { dataDir: dir });
      expect(codexExecEnv(process.execPath).OPENAI_API_KEY).toBe('file-fixture');
    } finally {
      if (priorDataDir === undefined) delete process.env.MAT_DATA_DIR; else process.env.MAT_DATA_DIR = priorDataDir;
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    }
  });

  it('writes mode 0600 and clears idempotently', () => {
    const dir = dataDir();
    setOpenAiKey('fixture', { dataDir: dir });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'openai-api-key.bin')).mode & 0o777).toBe(0o600);
    clearOpenAiKey({ dataDir: dir });
    clearOpenAiKey({ dataDir: dir });
    expect(configuredOpenAiKey({ dataDir: dir, env: {} })).toBeNull();
  });
});
