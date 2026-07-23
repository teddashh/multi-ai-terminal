import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentSdk, setSdkOverrideForTest, type AgentSdkModule } from '../../src/providers/claude/sdk-loader.js';

describe('claude Agent SDK loader', () => {
  afterEach(() => {
    delete process.env.MAT_DISABLE_AGENT_SDK;
    setSdkOverrideForTest(undefined);
  });

  it('returns an object override as-is', async () => {
    const override = { query: () => { throw new Error('not called'); } } as unknown as AgentSdkModule;
    setSdkOverrideForTest(override);
    await expect(loadAgentSdk()).resolves.toBe(override);
  });

  it('returns null for a null override', async () => {
    setSdkOverrideForTest(null);
    await expect(loadAgentSdk()).resolves.toBeNull();
  });

  it('resets cached state when clearing an override and honors the disable escape hatch', async () => {
    const override = { query: () => { throw new Error('not called'); } } as unknown as AgentSdkModule;
    setSdkOverrideForTest(override);
    await expect(loadAgentSdk()).resolves.toBe(override);
    setSdkOverrideForTest(undefined);
    process.env.MAT_DISABLE_AGENT_SDK = '1';
    await expect(loadAgentSdk()).resolves.toBeNull();
  });

  it('lazily imports and caches the installed SDK module', async () => {
    setSdkOverrideForTest(undefined);
    delete process.env.MAT_DISABLE_AGENT_SDK;
    const first = await loadAgentSdk();
    expect(typeof first?.query).toBe('function');
    await expect(loadAgentSdk()).resolves.toBe(first);
  });
});
