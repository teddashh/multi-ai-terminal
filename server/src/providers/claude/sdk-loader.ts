import { redactEnvironmentValues } from '../../redact.js';

export type AgentQueryStream = AsyncGenerator<Record<string, unknown>, void> & {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
  setModel?: (model: string) => Promise<unknown>;
  setPermissionMode?: (mode: string) => Promise<unknown>;
  stopTask?: (taskId: string) => Promise<unknown>;
};

export interface AgentSdkModule {
  query(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): AgentQueryStream;
}

let sdkLoadPromise: Promise<AgentSdkModule | null> | undefined;
let sdkOverrideSet = false;
let sdkOverride: AgentSdkModule | null = null;

export async function loadAgentSdk(): Promise<AgentSdkModule | null> {
  if (sdkOverrideSet) return sdkOverride;
  // Single-flight: concurrent cold-start callers share one import attempt —
  // a parallel caller must never observe null while the import is in flight.
  sdkLoadPromise ??= (async () => {
    if (process.env.MAT_DISABLE_AGENT_SDK === '1') return null;
    try {
      return await import('@anthropic-ai/claude-agent-sdk') as unknown as AgentSdkModule;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mat] claude sdk load failed: ${redactEnvironmentValues(message)}`);
      return null;
    }
  })();
  return sdkLoadPromise;
}

export function setSdkOverrideForTest(value: AgentSdkModule | null | undefined): void {
  if (value === undefined) {
    sdkOverrideSet = false;
    sdkOverride = null;
    sdkLoadPromise = undefined;
    return;
  }
  sdkOverrideSet = true;
  sdkOverride = value;
}
