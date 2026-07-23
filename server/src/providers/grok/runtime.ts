import type { Adapter, ResolvedNodeSpec, SpawnedNode } from '../../adapters/base.js';
import { CliSessionManager, type CliTransport } from '../cli/manager.js';
import { spawnGrokTransport } from './transport.js';

type SpawnIo = Parameters<Adapter['spawn']>[1];

interface GrokRuntimeOverrides {
  spawn?: CliTransport;
  killFallbackMs?: number;
  createSessionId?: () => string;
}

export interface GrokSessionRuntime {
  startRun(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode;
  dispose(): void;
}

let singleton: CliSessionManager | undefined;
let testOverrides: GrokRuntimeOverrides = {};

export function grokSessionRuntime(): GrokSessionRuntime {
  return singleton ??= new CliSessionManager({
    provider: 'grok',
    resumable: true,
    spawn: testOverrides.spawn ?? spawnGrokTransport,
    ...(testOverrides.killFallbackMs !== undefined ? { killFallbackMs: testOverrides.killFallbackMs } : {}),
    ...(testOverrides.createSessionId ? { createSessionId: testOverrides.createSessionId } : {}),
  });
}

export function spawnGrok(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode {
  return grokSessionRuntime().startRun(spec, io);
}

/** Dispose only an already-created production singleton; never create one during shutdown. */
export function disposeGrokSessionRuntime(): void {
  const previous = singleton;
  singleton = undefined;
  previous?.dispose();
}

export function resetGrokSessionRuntimeForTest(overrides: GrokRuntimeOverrides = {}): void {
  singleton?.dispose();
  singleton = undefined;
  testOverrides = overrides;
}
