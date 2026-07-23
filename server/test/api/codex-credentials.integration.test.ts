import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/index.js';
import { captureCurrent, markActiveNeedsLogin } from '../../src/providers/codex/accounts.js';
import { resetCodexSessionRuntimeForTest } from '../../src/providers/codex/runtime.js';
import { resetSignInForTests, setSignInRecipeForTests, setSignInTimingForTests, startSignIn } from '../../src/providers/signin.js';

let app: FastifyInstance | undefined;
let root: string;
let dataDir: string;
let codexHome: string;
const previousCodexHome = process.env.CODEX_HOME;
const previousKey = process.env.OPENAI_API_KEY;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mat-codex-routes-'));
  dataDir = join(root, 'data');
  codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  delete process.env.OPENAI_API_KEY;
  app = await buildServer({ port: 0, host: '127.0.0.1', dataDir, token: undefined }, {
    sweepOnBoot: async () => undefined,
  });
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  resetCodexSessionRuntimeForTest();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('codex credential routes', () => {
  it('serves capture, list, switch, and remove', async () => {
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ account_id: 'one', email: 'one@example.test' }));
    expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/capture' })).json()).toMatchObject({ ok: true, account: { id: 'one' } });
    expect((await app!.inject({ method: 'GET', url: '/api/providers/codex/accounts' })).json()).toMatchObject({ activeAccountId: 'one', accounts: [{ id: 'one' }] });
    expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/switch', payload: { accountId: 'one' } })).json()).toMatchObject({ ok: true });
    expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/remove', payload: { accountId: 'one' } })).json()).toEqual({ ok: true, removed: true });
  });

  it('passes through store refusal errors', async () => {
    expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/switch', payload: { accountId: 'missing' } })).json())
      .toEqual({ ok: false, error: 'Unknown codex account: missing' });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ account_id: 'one' }));
    captureCurrent({ dataDir, codexHome });
    markActiveNeedsLogin('expired', { dataDir, codexHome });
    expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/switch', payload: { accountId: 'one' } })).json())
      .toMatchObject({ ok: false, error: expect.stringContaining('needs login') });
  });

  it('refuses account mutations while a sign-in ceremony is active and rejects unsafe ids', async () => {
    expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/switch', payload: { accountId: '../escape' } })).statusCode).toBe(400);
    setSignInRecipeForTests('codex', {
      mode: 'device', command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 3000)'], trustedHosts: ['openai.com'],
    });
    setSignInTimingForTests({ urlWaitMs: 400 });
    const ceremony = startSignIn('codex');
    try {
      expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/capture' })).json())
        .toEqual({ ok: false, error: 'Cannot capture codex account while a sign-in is in progress.' });
      expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/switch', payload: { accountId: 'one' } })).json())
        .toEqual({ ok: false, error: 'Cannot switch codex account while a sign-in is in progress.' });
      expect((await app!.inject({ method: 'POST', url: '/api/providers/codex/accounts/remove', payload: { accountId: 'one' } })).json())
        .toEqual({ ok: false, error: 'Cannot remove codex account while a sign-in is in progress.' });
    } finally {
      resetSignInForTests();
      await ceremony;
      setSignInRecipeForTests('codex', undefined);
      setSignInTimingForTests();
    }
  }, 30_000);

  it('never returns the API key and reports file/env fallback after delete', async () => {
    const fixtureKey = 'sk-fixture-never-return-this';
    let response = await app!.inject({ method: 'POST', url: '/api/providers/codex/api-key', payload: { key: fixtureKey } });
    expect(response.json()).toEqual({ configured: true, source: 'file' });
    expect(response.body).not.toContain(fixtureKey);
    response = await app!.inject({ method: 'GET', url: '/api/providers/codex/api-key' });
    expect(response.json()).toEqual({ configured: true, source: 'file' });
    expect(response.body).not.toContain(fixtureKey);
    process.env.OPENAI_API_KEY = 'env-fixture-never-return-this';
    response = await app!.inject({ method: 'DELETE', url: '/api/providers/codex/api-key' });
    expect(response.json()).toEqual({ configured: true, source: 'env' });
    expect(response.body).not.toContain(process.env.OPENAI_API_KEY);
  });
});
