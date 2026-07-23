import { access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeChangedEvent, RuntimeStatus } from '@mat/shared';
import { redactEnvironmentValues } from '../redact.js';
import { currentPlatformKey, loadRuntimeCatalog, platformEntry, runtimeVersion, type RuntimeCatalog } from './catalog.js';
import { installRuntime, managedBinaryPath, managedRuntimeDir, probeRuntime, type InstallDependencies } from './install.js';
import { clearRuntimeResolutionCache, resolveRuntimeBinary, type ResolveOptions } from './resolve.js';

export type ManagedRuntimeFamily = 'claude' | 'codex';
const FAMILIES: readonly ManagedRuntimeFamily[] = ['claude', 'codex'];
const SELF_PROVISION_FAMILIES: readonly ManagedRuntimeFamily[] = ['codex', 'claude'];
type Listener = (event: RuntimeChangedEvent) => void;
const listeners = new Set<Listener>();
let active: { family: ManagedRuntimeFamily; promise: Promise<unknown> } | undefined;
let reserved: ManagedRuntimeFamily | undefined;
// Keyed by family:operation — a clear requested during an install must queue
// behind it, not silently join the install's promise.
const inFlight = new Map<string, Promise<unknown>>();
let tail: Promise<unknown> = Promise.resolve();
let selfProvisionStarted = false;

export interface TriggerDependencies extends InstallDependencies, ResolveOptions {
  install?: typeof installRuntime;
  probe?: typeof probeRuntime;
  exists?: (path: string) => Promise<boolean>;
}

export const subscribeRuntimeChanges = (listener: Listener): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const activeRuntimeMutation = (): ManagedRuntimeFamily | undefined => active?.family ?? reserved;
export const isManagedRuntimeFamily = (value: string): value is ManagedRuntimeFamily => FAMILIES.includes(value as ManagedRuntimeFamily);

function emit(event: RuntimeChangedEvent): void { for (const listener of listeners) { try { listener(event); } catch { /* observers cannot fail mutation */ } } }
async function pathExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

export async function runtimeStatus(dataDir: string, deps: TriggerDependencies = {}): Promise<RuntimeStatus[]> {
  const catalog = deps.catalog ?? loadRuntimeCatalog();
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const key = `${platform}-${arch}`;
  return Promise.all(FAMILIES.map(async (family): Promise<RuntimeStatus> => {
    const managedVersion = runtimeVersion(family, catalog);
    let canInstallManaged = true;
    try { platformEntry(family, key, catalog); } catch { canInstallManaged = false; }
    if (canInstallManaged) {
      const binary = managedBinaryPath(dataDir, family, catalog, key, platform);
      if (await (deps.probe ?? deps.probeManaged ?? probeRuntime)(binary, 5_000)) {
        return { family, state: 'managed', managedVersion, resolvedPath: binary, canInstallManaged };
      }
      const dir = managedRuntimeDir(dataDir, family, catalog, key);
      if (await (deps.exists ?? pathExists)(dir)) return { family, state: 'broken', managedVersion, canInstallManaged };
    }
    const resolvedPath = await resolveRuntimeBinary(dataDir, family, { ...deps, catalog, platform, arch });
    return { family, state: resolvedPath ? 'external' : 'missing', managedVersion, ...(resolvedPath ? { resolvedPath } : {}), canInstallManaged };
  }));
}

function mutate<T>(family: ManagedRuntimeFamily, kind: 'install' | 'clear', operation: () => Promise<T>): Promise<T> {
  const key = `${family}:${kind}`;
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  if (!reserved && !active) reserved = family;
  const run = tail.catch(() => undefined).then(async () => {
    const promise = operation(); active = { family, promise };
    if (reserved === family) reserved = undefined;
    try { return await promise; } finally { if (active?.promise === promise) active = undefined; }
  });
  inFlight.set(key, run);
  void run.finally(() => { if (inFlight.get(key) === run) inFlight.delete(key); }).catch(() => undefined);
  tail = run;
  return run;
}

async function finishEvent(dataDir: string, family: ManagedRuntimeFamily, error?: unknown, deps: TriggerDependencies = {}): Promise<void> {
  clearRuntimeResolutionCache(family);
  try {
    const status = (await runtimeStatus(dataDir, deps)).find((item) => item.family === family)!;
    emit({ family, state: status.state, ...(status.managedVersion ? { managedVersion: status.managedVersion } : {}), ...(error ? { error: redactEnvironmentValues(error instanceof Error ? error.message : String(error)) } : {}) });
  } catch (statusError) {
    // The mutation's own outcome must win: a status/emit failure is logged, never thrown.
    console.error(`[mat] runtime status after ${family} mutation failed: ${redactEnvironmentValues(statusError instanceof Error ? statusError.message : String(statusError))}`);
  }
}

export function installFamily(dataDir: string, family: ManagedRuntimeFamily, deps: TriggerDependencies = {}): Promise<string> {
  return mutate(family, 'install', async () => {
    let failure: unknown;
    try { return await (deps.install ?? installRuntime)(dataDir, family, deps); }
    catch (error) { failure = error; throw error; }
    finally { await finishEvent(dataDir, family, failure, deps); }
  });
}

export function clearFamily(dataDir: string, family: ManagedRuntimeFamily, deps: TriggerDependencies = {}): Promise<void> {
  return mutate(family, 'clear', async () => {
    let failure: unknown;
    try {
      const catalog = deps.catalog ?? loadRuntimeCatalog();
      const familyTree = resolve(dataDir, 'runtimes', family === 'claude' ? 'claude-agent-sdk' : 'codex');
      const runtimes = resolve(dataDir, 'runtimes');
      if (!familyTree.startsWith(`${runtimes}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Managed runtime path escaped runtimes directory');
      await rm(familyTree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) { failure = error; throw error; }
    finally { await finishEvent(dataDir, family, failure, deps); }
  });
}

export function maybeSelfProvision(dataDir: string, deps: TriggerDependencies = {}): void {
  if (process.env.MAT_SELF_PROVISION !== '1' || selfProvisionStarted) return;
  selfProvisionStarted = true;
  void (async () => {
    for (const family of SELF_PROVISION_FAMILIES) {
      try {
        // Recheck immediately before each mutation: an earlier install or an
        // external tool becoming available must never be overwritten.
        const status = (await runtimeStatus(dataDir, deps)).find((item) => item.family === family);
        if (status?.state === 'missing' && status.canInstallManaged) await installFamily(dataDir, family, deps);
      } catch (error) {
        console.error(`[mat] managed ${family} self-provision failed: ${redactEnvironmentValues(error instanceof Error ? error.message : String(error))}`);
      }
    }
  })();
}

export function resetRuntimeTriggersForTest(): void { active = undefined; reserved = undefined; inFlight.clear(); tail = Promise.resolve(); selfProvisionStarted = false; listeners.clear(); }
