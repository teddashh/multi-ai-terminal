import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearVersionCache, probeVersion, providerVersionCacheTtlMs, providerVersionProbeTimeoutMs } from '../src/adapters/base.js';
import { providerInstallPlan, providerInstallTimeoutMs } from '../src/providers/install.js';
import { configureDataDir } from '../src/store/dataDir.js';
import { createFakeExecutable } from './helpers/fakeExecutable.js';

const root = mkdtempSync(join(tmpdir(), 'mat-provider-tests-'));

beforeAll(() => { configureDataDir(join(root, 'data')); clearVersionCache(); });
afterAll(() => {
  clearVersionCache();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('provider install recipes', () => {
  it('returns fixed npm recipes and no mock recipe', () => {
    expect(providerInstallPlan('claude', 'linux')).toEqual({ recipe: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] } });
    expect(providerInstallPlan('codex', 'win32')).toEqual({ recipe: { command: 'npm', args: ['install', '-g', '@openai/codex'] } });
    expect(providerInstallPlan('grok', 'darwin')).toEqual({ recipe: { command: 'npm', args: ['install', '-g', '@xai-official/grok'] } });
    expect(providerInstallPlan('mock', 'linux')).toEqual({});
  });

  it('uses winget for Antigravity on Windows and exposes the manual command elsewhere', () => {
    expect(providerInstallPlan('agy', 'win32')).toEqual({ recipe: { command: 'winget', args: ['install', '-e', '--id', 'Google.AntigravityCLI', '--accept-source-agreements', '--accept-package-agreements'] } });
    expect(providerInstallPlan('agy', 'linux')).toEqual({ manualCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' });
  });

  it('allows the slower Antigravity installer more time without changing other recipes', () => {
    expect(providerInstallTimeoutMs('agy')).toBe(600_000);
    expect(providerInstallTimeoutMs('codex')).toBe(300_000);
  });
});

describe('provider version probes', () => {
  it('allows Windows cold starts and only briefly caches transient failures', () => {
    expect(providerVersionProbeTimeoutMs('win32')).toBe(15_000);
    expect(providerVersionProbeTimeoutMs('linux')).toBe(8_000);
    expect(providerVersionCacheTtlMs(true)).toBe(600_000);
    expect(providerVersionCacheTtlMs(false)).toBe(2_000);
  });

  it('returns actionable failure detail', async () => {
    const command = join(root, 'definitely-missing-provider');
    clearVersionCache(command);
    await expect(probeVersion(command)).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('CLI not found on PATH') });
  });

  it('clears one cached command so a fresh version is observed', async () => {
    const command = createFakeExecutable(root, 'versioned-provider', "console.log('provider 1.0.0');");
    clearVersionCache(command);
    await expect(probeVersion(command)).resolves.toEqual({ ok: true, version: 'provider 1.0.0' });
    createFakeExecutable(root, 'versioned-provider', "console.log('provider 2.0.0');");
    await expect(probeVersion(command)).resolves.toEqual({ ok: true, version: 'provider 1.0.0' });
    clearVersionCache(command);
    await expect(probeVersion(command)).resolves.toEqual({ ok: true, version: 'provider 2.0.0' });
  });

  it('reports a nonzero version probe exit when no output is available', async () => {
    const command = createFakeExecutable(root, 'failing-provider', 'process.exit(3);');
    clearVersionCache(command);
    await expect(probeVersion(command)).resolves.toEqual({ ok: false, detail: 'exit 3' });
  });
});
