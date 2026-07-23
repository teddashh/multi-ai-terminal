import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_MODELS_ENDPOINT,
  OPENROUTER_MODELS_RETRY_MS,
  OPENROUTER_MODELS_TIMEOUT_MS,
  OPENROUTER_MODELS_TTL_MS,
  loadOpenRouterModelCatalog,
  resetOpenRouterModelCatalogForTest,
} from '../../src/providers/openrouter/catalog.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  resetOpenRouterModelCatalogForTest();
});

afterEach(() => {
  resetOpenRouterModelCatalogForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('OpenRouter public model catalog', () => {
  it('keeps distinct models separate, exposes current and pinned versions, and recognizes latest aliases', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: [
        {
          id: '~openai/gpt-mini-latest',
          canonical_slug: '~openai/gpt-mini-latest',
          name: 'OpenAI GPT Mini Latest',
          created: 350,
          supported_parameters: ['tools'],
        },
        {
          id: 'openai/gpt-5.2',
          canonical_slug: 'openai/gpt-5.2-20251211',
          name: 'GPT-5.2',
          created: 200,
          supported_parameters: ['tools', 'temperature'],
        },
        {
          id: 'openai/gpt-5.2',
          canonical_slug: 'openai/gpt-5.2-20251211',
          name: 'GPT-5.2 duplicate',
          created: 150,
          supported_parameters: [],
        },
        {
          id: 'openai/gpt-5.2-preview',
          canonical_slug: 'openai/gpt-5.2-20251211',
          created: 100,
          supported_parameters: [],
        },
        {
          id: 'openai/gpt-5.3',
          canonical_slug: 'openai/gpt-5.3-20260120',
          created: 300,
          supported_parameters: [],
        },
        {
          id: 'anthropic/claude-sonnet-4.5',
          canonical_slug: 'anthropic/claude-sonnet-4.5-20250929',
          created: 250,
          supported_parameters: ['tools'],
        },
        {
          id: 'google/gemini-3-pro',
          canonical_slug: 'google/gemini-3-pro-20260101',
          name: 'Google: Gemini 3 Pro',
          created: 275,
          supported_parameters: [],
        },
        {
          id: 'vendor/stable-model-20260101',
          canonical_slug: 'vendor/stable-model-20260101',
          name: 'Vendor: Stable Model',
          created: 225,
          supported_parameters: ['tools'],
        },
        {
          id: 'openai/gpt-5.3:free',
          canonical_slug: 'openai/gpt-5.3:free',
          created: 400,
          supported_parameters: ['tools'],
        },
      ],
    })));

    const catalog = await loadOpenRouterModelCatalog();

    expect(catalog.source).toBe('live');
    expect(catalog.groups).toHaveLength(6);
    expect(catalog.groups[0]).toMatchObject({
      id: '~openai/gpt-mini-latest',
      defaultVersion: '~openai/gpt-mini-latest',
      versions: [{ id: '~openai/gpt-mini-latest', kind: 'latest', supportsTools: true }],
    });
    expect(catalog.groups.find((group) => group.id === 'openai/gpt-5.2-20251211')).toMatchObject({
      label: 'GPT-5.2',
      defaultVersion: 'openai/gpt-5.2',
      versions: [
        { id: 'openai/gpt-5.2', kind: 'current', supportsTools: true, created: 200 },
        { id: 'openai/gpt-5.2-preview', kind: 'current', supportsTools: false, created: 100 },
        { id: 'openai/gpt-5.2-20251211', kind: 'pinned', supportsTools: true, created: 200 },
      ],
    });
    expect(catalog.groups.find((group) => group.id === 'openai/gpt-5.3-20260120')).toMatchObject({
      versions: [
        { id: 'openai/gpt-5.3', kind: 'current', supportsTools: false },
        { id: 'openai/gpt-5.3-20260120', kind: 'pinned', supportsTools: false, created: 300 },
      ],
    });
    expect(catalog.groups.find((group) => group.id === 'anthropic/claude-sonnet-4.5-20250929')?.versions.map((version) => version.id)).toEqual([
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-sonnet-4.5-20250929',
    ]);
    expect(catalog.groups.find((group) => group.id === 'google/gemini-3-pro-20260101')).toMatchObject({
      label: 'Google: Gemini 3 Pro',
      defaultVersion: 'google/gemini-3-pro',
      versions: [
        { id: 'google/gemini-3-pro', kind: 'current', supportsTools: false },
        { id: 'google/gemini-3-pro-20260101', kind: 'pinned', supportsTools: false },
      ],
    });
    expect(catalog.groups.find((group) => group.id === 'vendor/stable-model-20260101')).toMatchObject({
      versions: [{ id: 'vendor/stable-model-20260101', kind: 'pinned', supportsTools: true }],
    });
    const versionIds = catalog.groups.flatMap((group) => group.versions.map((version) => version.id));
    expect(new Set(versionIds).size).toBe(versionIds.length);
    expect(JSON.stringify(catalog)).not.toContain(':free');
  });

  it('drops malformed entries but rejects malformed or empty envelopes without exposing them', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [
          { id: '', canonical_slug: 'invalid' },
          { id: 'vendor/usable', name: 'Usable', supported_parameters: ['tools'] },
          { id: 'vendor/bad-parameters', supported_parameters: 'tools' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ data: 'remote-body-canary' }))
      .mockResolvedValueOnce(new Response('{remote-error-canary', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const partiallyValid = await loadOpenRouterModelCatalog();
    expect(partiallyValid.source).toBe('live');
    expect(partiallyValid.groups.some((group) => group.id === 'vendor/usable')).toBe(true);
    expect(JSON.stringify(partiallyValid)).not.toMatch(/invalid|bad-parameters/);

    resetOpenRouterModelCatalogForTest();
    const malformedEnvelope = await loadOpenRouterModelCatalog();
    expect(malformedEnvelope.source).toBe('fallback');
    expect(JSON.stringify(malformedEnvelope)).not.toContain('remote-body-canary');

    resetOpenRouterModelCatalogForTest();
    const invalidJson = await loadOpenRouterModelCatalog();
    expect(invalidJson.source).toBe('fallback');
    expect(JSON.stringify(invalidJson)).not.toContain('remote-error-canary');
  });

  it('uses the fixed public URL without forwarding authorization or environment values', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'openrouter-environment-canary');
    vi.stubEnv('OPENAI_API_KEY', 'openai-environment-canary');
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect([...headers.values()].join(' ')).not.toMatch(/environment-canary/);
      expect(JSON.stringify(init)).not.toMatch(/environment-canary/);
      return jsonResponse({ data: [{ id: 'vendor/model', supported_parameters: [] }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await loadOpenRouterModelCatalog()).source).toBe('live');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(OPENROUTER_MODELS_ENDPOINT);
  });

  it('shares in-flight work and caches successful results until the TTL expires', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const first = loadOpenRouterModelCatalog();
    const concurrent = loadOpenRouterModelCatalog();
    expect(first).toBe(concurrent);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(jsonResponse({ data: [{ id: 'vendor/model-v1', supported_parameters: ['tools'] }] }));
    expect((await first).source).toBe('live');
    expect(await concurrent).toEqual(await first);

    expect((await loadOpenRouterModelCatalog()).groups.some((group) => group.id === 'vendor/model-v1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    now += OPENROUTER_MODELS_TTL_MS + 1;
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'vendor/model-v2', supported_parameters: [] }] }));
    const refreshed = await loadOpenRouterModelCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.groups.some((group) => group.id === 'vendor/model-v2')).toBe(true);
  });

  it('returns last-good data as stale and bundled aliases as fallback', async () => {
    let now = 20_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'vendor/last-good', supported_parameters: ['tools'] }] }))
      .mockRejectedValue(new Error('remote-transport-canary'));
    vi.stubGlobal('fetch', fetchMock);

    const live = await loadOpenRouterModelCatalog();
    now += OPENROUTER_MODELS_TTL_MS + 1;
    const stale = await loadOpenRouterModelCatalog();
    expect(stale).toEqual({ groups: live.groups, source: 'stale' });
    expect(JSON.stringify(stale)).not.toContain('remote-transport-canary');

    resetOpenRouterModelCatalogForTest();
    const fallback = await loadOpenRouterModelCatalog();
    expect(fallback.source).toBe('fallback');
    expect(fallback.groups.map((group) => group.defaultVersion)).toEqual([
      '~openai/gpt-latest',
      '~anthropic/claude-sonnet-latest',
    ]);
  });

  it('briefly caches a failed refresh before retrying the public endpoint', async () => {
    let now = 25_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn().mockRejectedValue(new Error('catalog unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    expect((await loadOpenRouterModelCatalog()).source).toBe('fallback');
    expect((await loadOpenRouterModelCatalog()).source).toBe('fallback');
    expect(fetchMock).toHaveBeenCalledOnce();

    now += OPENROUTER_MODELS_RETRY_MS + 1;
    expect((await loadOpenRouterModelCatalog()).source).toBe('fallback');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a request after the fixed timeout and falls back safely', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('remote-timeout-canary', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = loadOpenRouterModelCatalog();
    await vi.advanceTimersByTimeAsync(OPENROUTER_MODELS_TIMEOUT_MS);
    const catalog = await pending;
    expect(catalog.source).toBe('fallback');
    expect(JSON.stringify(catalog)).not.toContain('remote-timeout-canary');
  });

  it('cancels unread response bodies for HTTP failures and advertised oversize payloads', async () => {
    const cancelled: string[] = [];
    const streamingResponse = (label: string, status: number, contentLength?: number): Response => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
        },
        cancel() {
          cancelled.push(label);
        },
      }),
      {
        status,
        headers: contentLength === undefined ? undefined : { 'Content-Length': String(contentLength) },
      },
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamingResponse('http', 503))
      .mockResolvedValueOnce(streamingResponse('oversize', 200, 2 * 1024 * 1024 + 1));
    vi.stubGlobal('fetch', fetchMock);

    expect((await loadOpenRouterModelCatalog()).source).toBe('fallback');
    expect(cancelled).toEqual(['http']);
    resetOpenRouterModelCatalogForTest();
    expect((await loadOpenRouterModelCatalog()).source).toBe('fallback');
    expect(cancelled).toEqual(['http', 'oversize']);
  });

  it('rejects an advertised response larger than the bounded body limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { data: [{ id: 'vendor/oversized' }] },
      { headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024 + 1) } },
    )));

    const catalog = await loadOpenRouterModelCatalog();
    expect(catalog.source).toBe('fallback');
    expect(catalog.groups.some((group) => group.id === 'vendor/oversized')).toBe(false);
  });
});
