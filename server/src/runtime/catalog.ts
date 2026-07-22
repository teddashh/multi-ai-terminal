import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const integrity = z.string().min(1);
const runtimeRelativePath = z.string().regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/\/)[^/]+(?:\/[^/]+)*$/);
const catalogSchema = z.object({
  claude: z.object({ version: z.string().min(1), platforms: z.record(z.object({ packageName: z.string().min(1), integrity })) }),
  codex: z.object({ version: z.string().min(1), platforms: z.record(z.object({ npmVersion: z.string().min(1), integrity })) }),
  node: z.object({ version: z.string().min(1), platforms: z.record(z.object({
    nodePlatform: z.string().min(1), nodeArch: z.string().min(1), archiveExt: z.string().min(1),
    exePath: runtimeRelativePath, sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  })) }),
}).passthrough();

export type RuntimeCatalog = z.infer<typeof catalogSchema>;
export type RuntimeFamily = 'claude' | 'codex' | 'node';
export type PlatformEntry<F extends RuntimeFamily> = RuntimeCatalog[F]['platforms'][string];

export const currentPlatformKey = (): string => `${process.platform}-${process.arch}`;

export function catalogPathCandidates(moduleUrl = import.meta.url): string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  return [resolve(here, 'runtime-catalog.json'), resolve(here, '../runtime-catalog.json'), resolve(here, '../../../runtime-catalog.json')];
}

export function catalogPath(): string {
  const candidates = catalogPathCandidates();
  const found = candidates.find(existsSync);
  if (found) return found;
  throw new Error(`Runtime catalog not found; tried: ${candidates.join(', ')}`);
}

export function loadRuntimeCatalog(path = catalogPath()): RuntimeCatalog {
  try {
    return catalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed runtime catalog at ${path}: ${detail}`);
  }
}

export function runtimeVersion(family: RuntimeFamily, catalog = loadRuntimeCatalog()): string {
  return catalog[family].version;
}

export function platformEntry<F extends RuntimeFamily>(
  family: F,
  key = currentPlatformKey(),
  catalog = loadRuntimeCatalog(),
): PlatformEntry<F> {
  const entry = catalog[family].platforms[key] as PlatformEntry<F> | undefined;
  if (!entry) throw new Error(`Managed ${family} runtime is unsupported on platform ${key}`);
  return entry;
}
