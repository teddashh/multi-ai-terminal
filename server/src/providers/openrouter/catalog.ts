import {
  OpenRouterModelCatalogSchema,
  type OpenRouterModelCatalog,
  type OpenRouterModelGroup,
  type OpenRouterModelVersion,
} from '@mat/shared';
import { z } from 'zod';

export const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models?output_modalities=text';
export const OPENROUTER_MODELS_TIMEOUT_MS = 5_000;
export const OPENROUTER_MODELS_TTL_MS = 15 * 60_000;
export const OPENROUTER_MODELS_RETRY_MS = 30_000;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_MODELS = 10_000;

const RemoteEnvelopeSchema = z.object({
  data: z.array(z.unknown()).max(MAX_REMOTE_MODELS),
}).strip();

const RemoteModelSchema = z.object({
  id: z.string().min(1).max(512),
  canonical_slug: z.string().min(1).max(512).nullish(),
  name: z.string().min(1).max(512).nullish(),
  created: z.number().int().nonnegative().optional(),
  supported_parameters: z.array(z.string().max(128)).max(256).nullish(),
}).strip();

interface RemoteModel {
  id: string;
  canonicalSlug?: string;
  name?: string;
  created?: number;
  supportsTools: boolean;
}

interface FallbackModel {
  id: string;
  label: string;
}

const FALLBACK_MODELS: readonly FallbackModel[] = [
  {
    id: '~openai/gpt-latest',
    label: 'OpenAI GPT',
  },
  {
    id: '~anthropic/claude-sonnet-latest',
    label: 'Anthropic Claude Sonnet',
  },
];

const FALLBACK_CATALOG: OpenRouterModelCatalog = OpenRouterModelCatalogSchema.parse({
  groups: FALLBACK_MODELS.map((model) => ({
    id: model.id,
    label: model.label,
    versions: [{
      id: model.id,
      label: 'Latest',
      kind: 'latest',
      supportsTools: true,
    }],
    defaultVersion: model.id,
  })),
  source: 'fallback',
});

let cachedResult: { catalog: OpenRouterModelCatalog; expiresAt: number } | undefined;
let lastGoodGroups: OpenRouterModelGroup[] | undefined;
let inflight: Promise<OpenRouterModelCatalog> | undefined;
let generation = 0;

/**
 * Loads the public catalog only when the dedicated models endpoint is called.
 * Failures are deliberately opaque: callers receive last-good data or the
 * bundled aliases, never remote response bodies or transport error details.
 */
export function loadOpenRouterModelCatalog(): Promise<OpenRouterModelCatalog> {
  const now = Date.now();
  if (cachedResult && now < cachedResult.expiresAt) return Promise.resolve(cachedResult.catalog);
  if (inflight) return inflight;

  const requestGeneration = generation;
  const request = fetchLiveCatalog()
    .then((catalog) => {
      if (requestGeneration === generation) {
        cachedResult = { catalog, expiresAt: Date.now() + OPENROUTER_MODELS_TTL_MS };
        lastGoodGroups = catalog.groups;
      }
      return catalog;
    })
    .catch(() => {
      const catalog: OpenRouterModelCatalog = {
        groups: lastGoodGroups ?? FALLBACK_CATALOG.groups,
        source: lastGoodGroups ? 'stale' : 'fallback',
      };
      if (requestGeneration === generation) {
        cachedResult = { catalog, expiresAt: Date.now() + OPENROUTER_MODELS_RETRY_MS };
      }
      return catalog;
    });
  const shared = request.finally(() => {
    if (requestGeneration === generation && inflight === shared) inflight = undefined;
  });
  inflight = shared;
  return shared;
}

/** Clears process-local catalog state without starting a request. */
export function resetOpenRouterModelCatalogForTest(): void {
  generation += 1;
  cachedResult = undefined;
  lastGoodGroups = undefined;
  inflight = undefined;
}

async function fetchLiveCatalog(): Promise<OpenRouterModelCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_MODELS_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error('OpenRouter model catalog request failed');
    }
    const raw = await readBoundedJson(response);
    const envelope = RemoteEnvelopeSchema.parse(raw);
    const models = envelope.data.flatMap((candidate) => {
      const parsed = RemoteModelSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.id.includes(':')) return [];
      const value = parsed.data;
      return [{
        id: value.id,
        ...(value.canonical_slug ? { canonicalSlug: value.canonical_slug } : {}),
        ...(value.name ? { name: value.name } : {}),
        ...(value.created !== undefined ? { created: value.created } : {}),
        supportsTools: value.supported_parameters?.includes('tools') ?? false,
      } satisfies RemoteModel];
    });
    if (models.length === 0) throw new Error('OpenRouter model catalog contained no usable models');
    return OpenRouterModelCatalogSchema.parse({
      groups: buildGroups(models),
      source: 'live',
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error('OpenRouter model catalog response exceeded the size limit');
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('OpenRouter model catalog response exceeded the size limit');
    }
    return JSON.parse(text) as unknown;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('OpenRouter model catalog response exceeded the size limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received).toString('utf8')) as unknown;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the stable fallback with transport details.
  }
}

function buildGroups(models: readonly RemoteModel[]): OpenRouterModelGroup[] {
  const sortedModels = [...models].sort(compareRemoteModels);
  const groups = new Map<string, {
    label: string;
    versions: Map<string, OpenRouterModelVersion>;
  }>();
  const groupByRequestId = new Map<string, string>();
  for (const model of sortedModels) {
    const groupId = model.canonicalSlug ?? model.id;
    const assignedGroup = groupByRequestId.get(model.id);
    if (assignedGroup !== undefined && assignedGroup !== groupId) continue;
    groupByRequestId.set(model.id, groupId);

    const group = groups.get(groupId) ?? {
      label: model.name ?? model.id,
      versions: new Map<string, OpenRouterModelVersion>(),
    };
    mergeVersion(group.versions, requestVersion(model));
    if (model.canonicalSlug && model.canonicalSlug !== model.id && !model.canonicalSlug.includes(':')) {
      mergeVersion(group.versions, {
        id: model.canonicalSlug,
        label: model.canonicalSlug,
        kind: 'pinned',
        supportsTools: model.supportsTools,
        ...(model.created !== undefined ? { created: model.created } : {}),
      });
    }
    groups.set(groupId, group);
  }

  return [...groups.entries()].map(([id, group]) => {
    const versions = [...group.versions.values()].sort(compareVersions);
    return {
      id,
      label: group.label,
      versions,
      defaultVersion: versions[0]!.id,
    };
  }).sort((left, right) => {
    const leftLatest = isLatestAlias(left.defaultVersion) ? 0 : 1;
    const rightLatest = isLatestAlias(right.defaultVersion) ? 0 : 1;
    return leftLatest - rightLatest
      || compareText(left.label, right.label)
      || compareText(left.id, right.id);
  });
}

function requestVersion(model: RemoteModel): OpenRouterModelVersion {
  return {
    id: model.id,
    label: model.id,
    kind: isLatestAlias(model.id)
      ? 'latest'
      : model.canonicalSlug === model.id
        ? 'pinned'
        : 'current',
    supportsTools: model.supportsTools,
    ...(model.created !== undefined ? { created: model.created } : {}),
  };
}

function mergeVersion(
  versions: Map<string, OpenRouterModelVersion>,
  candidate: OpenRouterModelVersion,
): void {
  const current = versions.get(candidate.id);
  if (!current) {
    versions.set(candidate.id, candidate);
  } else {
    versions.set(candidate.id, {
      ...current,
      supportsTools: current.supportsTools || candidate.supportsTools,
      ...(Math.max(current.created ?? -1, candidate.created ?? -1) >= 0
        ? { created: Math.max(current.created ?? -1, candidate.created ?? -1) }
        : {}),
    });
  }
}

function isLatestAlias(id: string): boolean {
  return id.startsWith('~') && id.endsWith('-latest');
}

function compareRemoteModels(left: RemoteModel, right: RemoteModel): number {
  return (right.created ?? -1) - (left.created ?? -1)
    || compareText(left.id, right.id)
    || compareText(left.canonicalSlug ?? '', right.canonicalSlug ?? '');
}

function compareVersions(left: OpenRouterModelVersion, right: OpenRouterModelVersion): number {
  const rank = { latest: 0, current: 1, pinned: 2 } as const;
  return rank[left.kind] - rank[right.kind]
    || (right.created ?? -1) - (left.created ?? -1)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
