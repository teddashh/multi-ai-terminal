import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedNodeSpec } from '../../src/adapters/base.js';
import { openRouterAdapter, spawnOpenRouter } from '../../src/adapters/openrouter.js';
import { adapters } from '../../src/adapters/registry.js';
import { CodexConnection, type CodexConnectionConfig } from '../../src/providers/codex/connection.js';
import {
  ensureOpenRouterCodexHome,
  OPENROUTER_CODEX_CONFIG,
  OPENROUTER_ENV_KEY,
  openRouterCodexHome,
} from '../../src/providers/openrouter/config.js';
import {
  OPENROUTER_DEFAULT_MODEL,
  resetOpenRouterSessionRuntimeForTest,
} from '../../src/providers/openrouter/runtime.js';
import { configureDataDir } from '../../src/store/dataDir.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-app-server.mjs');
const roots: string[] = [];
const connections: CodexConnection[] = [];

type Recorded = {
  direction: 'in' | 'out';
  message: Record<string, any>;
  apiKeyPresent: boolean;
  openRouterApiKeyPresent: boolean;
  codexAccessTokenPresent: boolean;
  codexApiKeyPresent: boolean;
};

function records(file: string): Recorded[] {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Recorded);
  } catch {
    return [];
  }
}

function newRoot(): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'mat-openrouter-runtime-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  configureDataDir(dataDir);
  return { root, dataDir };
}

function runtimeSetup(scenario: Record<string, unknown>) {
  const { root, dataDir } = newRoot();
  const recordFile = join(root, 'wire.jsonl');
  process.env.MAT_FAKE_APPSERVER_SCENARIO = JSON.stringify({ ...scenario, recordFile });
  let connectionConfig: CodexConnectionConfig | undefined;
  resetOpenRouterSessionRuntimeForTest({
    resolveBinary: async () => process.execPath,
    createConnection: (config) => {
      connectionConfig = config;
      const connection = new CodexConnection({
        ...config,
        spawnArgs: [fixturePath],
        idleReaper: false,
      });
      connections.push(connection);
      return connection;
    },
    subscribe: () => () => undefined,
  });
  return { dataDir, recordFile, connectionConfig: () => connectionConfig };
}

function spec(options: { model?: string; resumeSessionRef?: string } = {}): ResolvedNodeSpec {
  return {
    binding: {
      provider: 'openrouter',
      permission: 'auto',
      ...(options.model ? { model: options.model } : {}),
    },
    promptText: 'hello',
    cwd: '/repo',
    ...(options.resumeSessionRef ? { resumeSessionRef: options.resumeSessionRef } : {}),
  };
}

const completedScenario = (
  threadId: string,
  turnId: string,
  usage?: Record<string, unknown>,
): Record<string, unknown> => ({
  responses: {
    'thread/start': { result: { thread: { id: threadId } } },
    'turn/start': {
      result: { turn: { id: turnId } },
      notifications: [{
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', ...(usage ? { usage } : {}) } },
      }],
    },
  },
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.dispose()));
  resetOpenRouterSessionRuntimeForTest();
  vi.unstubAllEnvs();
  delete process.env.MAT_FAKE_APPSERVER_SCENARIO;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('OpenRouter Codex runtime profile', () => {
  it('provisions an isolated config-only Codex home without credentials', async () => {
    const { root, dataDir } = newRoot();
    const unrelatedHome = join(root, 'unrelated-codex-home');
    mkdirSync(unrelatedHome, { recursive: true });
    writeFileSync(join(unrelatedHome, 'config.toml'), 'leave-me-alone\n');
    vi.stubEnv('CODEX_HOME', unrelatedHome);
    vi.stubEnv(OPENROUTER_ENV_KEY, 'mat-openrouter-config-canary');

    const home = await ensureOpenRouterCodexHome(dataDir);
    const configPath = join(home, 'config.toml');
    expect(home).toBe(openRouterCodexHome(dataDir));
    expect(readFileSync(configPath, 'utf8')).toBe(OPENROUTER_CODEX_CONFIG);
    expect(readFileSync(configPath, 'utf8')).not.toContain('mat-openrouter-config-canary');
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect(readFileSync(join(unrelatedHome, 'config.toml'), 'utf8')).toBe('leave-me-alone\n');

    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }

    writeFileSync(configPath, 'tampered\n');
    await ensureOpenRouterCodexHome(dataDir);
    expect(readFileSync(configPath, 'utf8')).toBe(OPENROUTER_CODEX_CONFIG);
  }, 30_000);

  it('routes arbitrary models through modelProvider and injects only OpenRouter key presence', async () => {
    const model = 'vendor/arbitrary-model:beta';
    vi.stubEnv(OPENROUTER_ENV_KEY, 'mat-openrouter-child-canary');
    vi.stubEnv('OPENAI_API_KEY', 'mat-unrelated-openai-canary');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'mat-unrelated-codex-token');
    vi.stubEnv('CODEX_API_KEY', 'mat-unrelated-codex-key');
    const setup = runtimeSetup(completedScenario('thread-1', 'turn-1', {
      input_tokens: -1,
      output_tokens: 7,
    }));

    await expect(spawnOpenRouter(spec({ model }), {
      onEvent: () => undefined,
      onRaw: () => undefined,
    }).completion).resolves.toEqual({
      exitCode: 0,
      sessionRef: 'thread-1',
      usage: { outputTokens: 7 },
    });

    const inbound = records(setup.recordFile).filter((entry) => entry.direction === 'in');
    const threadStart = inbound.find((entry) => entry.message.method === 'thread/start')!;
    const turnStart = inbound.find((entry) => entry.message.method === 'turn/start')!;
    expect(threadStart.message.params).toMatchObject({ model, modelProvider: 'openrouter' });
    expect(turnStart.message.params).toMatchObject({ model });
    expect(turnStart.message.params).not.toHaveProperty('modelProvider');

    const initialize = inbound.find((entry) => entry.message.method === 'initialize')!;
    expect(initialize).toMatchObject({
      apiKeyPresent: false,
      openRouterApiKeyPresent: true,
      codexAccessTokenPresent: false,
      codexApiKeyPresent: false,
    });

    const config = setup.connectionConfig()!;
    expect(config.codexHome).toBe(openRouterCodexHome(setup.dataDir));
    expect(config).not.toHaveProperty('apiKey');
    expect(existsSync(join(config.codexHome, 'auth.json'))).toBe(false);
    const persistentConfig = readFileSync(join(config.codexHome, 'config.toml'), 'utf8');
    expect(persistentConfig).toBe(OPENROUTER_CODEX_CONFIG);
    expect(persistentConfig).not.toMatch(/mat-(?:openrouter|unrelated)-/);
    expect(readFileSync(setup.recordFile, 'utf8')).not.toMatch(/mat-(?:openrouter|unrelated)-/);
  }, 30_000);

  it('sends modelProvider on thread resume but never on turn start', async () => {
    const model = '~custom/resumed-model';
    vi.stubEnv(OPENROUTER_ENV_KEY, 'mat-openrouter-resume-canary');
    const setup = runtimeSetup({
      responses: {
        'thread/resume': { result: { thread: { id: 'thread-9' } } },
        'turn/start': {
          result: { turn: { id: 'turn-9' } },
          notifications: [{
            method: 'turn/completed',
            params: { threadId: 'thread-9', turn: { id: 'turn-9', status: 'completed' } },
          }],
        },
      },
    });

    await expect(spawnOpenRouter(spec({ model, resumeSessionRef: 'thread-9' }), {
      onEvent: () => undefined,
      onRaw: () => undefined,
    }).completion).resolves.toMatchObject({ exitCode: 0, sessionRef: 'thread-9' });

    const inbound = records(setup.recordFile).filter((entry) => entry.direction === 'in');
    expect(inbound.find((entry) => entry.message.method === 'thread/resume')?.message.params)
      .toMatchObject({ threadId: 'thread-9', model, modelProvider: 'openrouter' });
    expect(inbound.some((entry) => entry.message.method === 'thread/start')).toBe(false);
    expect(inbound.find((entry) => entry.message.method === 'turn/start')?.message.params)
      .not.toHaveProperty('modelProvider');
  }, 30_000);

  it('treats a whitespace-only OpenRouter credential as absent from the child', async () => {
    vi.stubEnv(OPENROUTER_ENV_KEY, '   ');
    const setup = runtimeSetup(completedScenario('thread-blank-key', 'turn-blank-key'));

    await expect(spawnOpenRouter(spec(), {
      onEvent: () => undefined,
      onRaw: () => undefined,
    }).completion).resolves.toMatchObject({ exitCode: 0 });

    const initialize = records(setup.recordFile)
      .find((entry) => entry.direction === 'in' && entry.message.method === 'initialize');
    expect(initialize?.openRouterApiKeyPresent).toBe(false);
  }, 30_000);

  it('advertises OpenRouter as a Codex-backed provider without a new runtime family', () => {
    vi.stubEnv(OPENROUTER_ENV_KEY, 'configured-for-presence-only');
    expect(Object.keys(adapters)).toEqual(['claude', 'codex', 'grok', 'agy', 'openrouter', 'mock']);
    expect(openRouterAdapter).toMatchObject({
      id: 'openrouter',
      tier: 'rich',
      runtimeFamily: 'codex',
      defaultModel: OPENROUTER_DEFAULT_MODEL,
    });
    expect(openRouterAdapter.environmentCredential?.()).toEqual({
      name: OPENROUTER_ENV_KEY,
      configured: true,
    });
    vi.stubEnv(OPENROUTER_ENV_KEY, '   ');
    expect(openRouterAdapter.environmentCredential?.()).toEqual({
      name: OPENROUTER_ENV_KEY,
      configured: false,
    });
  });
});
