import type { Adapter, ResolvedNodeSpec, SpawnedNode } from '../../adapters/base.js';
import { CliSessionManager, type CliTransport } from '../cli/manager.js';
import { spawnAgyTransport } from './transport.js';

type SpawnIo = Parameters<Adapter['spawn']>[1];

interface AgyRuntimeOverrides {
  spawn?: CliTransport;
  killFallbackMs?: number;
  createSessionId?: () => string;
}

export interface AgySessionRuntime {
  startRun(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode;
  dispose(): void;
}

let singleton: CliSessionManager | undefined;
let testOverrides: AgyRuntimeOverrides = {};

export function agySessionRuntime(): AgySessionRuntime {
  return singleton ??= new CliSessionManager({
    provider: 'agy',
    resumable: false,
    spawn: testOverrides.spawn ?? spawnAgyTransport,
    ...(testOverrides.killFallbackMs !== undefined ? { killFallbackMs: testOverrides.killFallbackMs } : {}),
    ...(testOverrides.createSessionId ? { createSessionId: testOverrides.createSessionId } : {}),
  });
}

export function spawnAgy(spec: ResolvedNodeSpec, io: SpawnIo): SpawnedNode {
  return agySessionRuntime().startRun(spec, io);
}

/** Dispose only an already-created production singleton; never create one during shutdown. */
export function disposeAgySessionRuntime(): void {
  const previous = singleton;
  singleton = undefined;
  previous?.dispose();
}

export function resetAgySessionRuntimeForTest(overrides: AgyRuntimeOverrides = {}): void {
  singleton?.dispose();
  singleton = undefined;
  testOverrides = overrides;
}
