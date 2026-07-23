import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogPathCandidates, loadRuntimeCatalog, platformEntry, runtimeVersion, type RuntimeCatalog } from '../src/runtime/catalog.js';
import {
  installRuntime, managedBinaryPath, pruneStaleRuntimeVersions, replaceRuntimeDir,
  verifySha256Hex, verifySriSha512,
} from '../src/runtime/install.js';
import { clearRuntimeResolutionCache, resolveRuntimeBinary } from '../src/runtime/resolve.js';
import { readTarEntry, tarEntriesUnder } from '../src/runtime/tar.js';
import { clearFamily, installFamily, maybeSelfProvision, resetRuntimeTriggersForTest, runtimeStatus, subscribeRuntimeChanges } from '../src/runtime/triggers.js';

const roots: string[] = [];
afterEach(() => {
  clearRuntimeResolutionCache();
  resetRuntimeTriggersForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mat-runtime-test-'));
  roots.push(root);
  return root;
}

interface FixtureEntry { path: string; bytes: Buffer; mode?: number; type?: number; prefix?: string }
function tar(entries: FixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 7, 'ascii');
    header.write(entry.bytes.length.toString(8).padStart(11, '0'), 124, 11, 'ascii');
    header[156] = entry.type ?? 48;
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
    chunks.push(header, entry.bytes, Buffer.alloc(Math.ceil(entry.bytes.length / 512) * 512 - entry.bytes.length));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function integrity(bytes: Uint8Array, algorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;
}

function catalogFor(claudeIntegrity: string, codexIntegrity = claudeIntegrity): RuntimeCatalog {
  return {
    claude: { version: '1.2.3', platforms: { 'linux-x64': { packageName: 'claude-fixture', integrity: claudeIntegrity } } },
    codex: { version: '2.3.4', platforms: { 'linux-x64': { npmVersion: '2.3.4-linux-x64', integrity: codexIntegrity } } },
    node: { version: '24.0.0', platforms: { 'linux-x64': {
      nodePlatform: 'linux', nodeArch: 'x64', archiveExt: 'tar.gz', exePath: 'bin/node', sha256: '0'.repeat(64),
    } } },
  };
}

describe('runtime integrity and tar parsing', () => {
  it('accepts valid SRI/sha256 and rejects mismatches', () => {
    const bytes = Buffer.from('archive');
    expect(() => verifySriSha512(bytes, integrity(bytes))).not.toThrow();
    expect(() => verifySriSha512(bytes, integrity(bytes).replace(/=+$/, ''))).not.toThrow();
    expect(() => verifySriSha512(bytes, integrity(Buffer.from('other')))).toThrow(/mismatch/i);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(() => verifySha256Hex(bytes, sha)).not.toThrow();
    expect(() => verifySha256Hex(bytes, '0'.repeat(64))).toThrow(/mismatch/i);
  });

  it.each(['../evil', '/absolute', 'C:/absolute', 'bin//evil', 'bin/./evil'])('rejects unsafe tar path %s', (path) => {
    const bytes = tar([{ path: `package/vendor/t/${path}`, bytes: Buffer.from('bad') }]);
    expect(() => tarEntriesUnder(bytes, 'package/vendor/t/')).toThrow(/unsafe/i);
  });

  it('requires a directory-boundary tar prefix and a non-empty size field', () => {
    const bytes = tar([{ path: 'package/vendor/x_evil/bin/codex', bytes: Buffer.from('bad') }]);
    expect(() => tarEntriesUnder(bytes, 'package/vendor/x')).toThrow(/prefix/i);
    const emptySize = Buffer.from(tar([{ path: 'file', bytes: Buffer.alloc(0) }]));
    emptySize.fill(0, 124, 136);
    expect(() => readTarEntry(emptySize, 'file')).toThrow(/size/i);
  });

  it('extracts a single file and a multi-file tree with modes and ustar prefix', () => {
    const bytes = tar([
      { path: 'claude', prefix: 'package', bytes: Buffer.from('single'), mode: 0o755 },
      { path: 'package/vendor/t/bin/codex', bytes: Buffer.from('codex'), mode: 0o755 },
      { path: 'package/vendor/t/codex-package.json', bytes: Buffer.from('{}'), mode: 0o644 },
      { path: 'package/vendor/t/link', bytes: Buffer.from('ignored'), type: 50 },
    ]);
    expect(readTarEntry(bytes, 'package/claude')?.toString()).toBe('single');
    expect(tarEntriesUnder(bytes, 'package/vendor/t/')).toEqual([
      expect.objectContaining({ path: 'bin/codex', mode: 0o755, bytes: Buffer.from('codex') }),
      expect.objectContaining({ path: 'codex-package.json', mode: 0o644, bytes: Buffer.from('{}') }),
    ]);
  });
});

describe('runtime catalog', () => {
  it('loads typed versions and platform entries and reports malformed or unsupported data clearly', () => {
    const root = tempRoot();
    const valid = catalogFor(integrity(Buffer.from('x')));
    const path = join(root, 'runtime-catalog.json');
    writeFileSync(path, JSON.stringify(valid));
    const loaded = loadRuntimeCatalog(path);
    expect(runtimeVersion('codex', loaded)).toBe('2.3.4');
    expect(platformEntry('claude', 'linux-x64', loaded).packageName).toBe('claude-fixture');
    expect(() => platformEntry('node', 'plan9-x64', loaded)).toThrow(/unsupported.*plan9-x64/i);
    writeFileSync(path, '{"node":');
    expect(() => loadRuntimeCatalog(path)).toThrow(/malformed runtime catalog/i);
  });

  it('tries bundle-adjacent, server-adjacent, then repository-root catalog candidates', () => {
    const base = join(tmpdir(), 'fixture');
    const moduleUrl = pathToFileURL(join(base, 'server', 'dist', 'runtime', 'catalog.js')).href;
    expect(catalogPathCandidates(moduleUrl)).toEqual([
      join(base, 'server', 'dist', 'runtime', 'runtime-catalog.json'),
      join(base, 'server', 'dist', 'runtime-catalog.json'),
      join(base, 'runtime-catalog.json'),
    ]);
  });
});

describe('runtime triggers', () => {
  const deps = (catalog: RuntimeCatalog) => ({ catalog, platform: 'linux' as const, arch: 'x64', probe: async () => false, probeManaged: async () => false, probePath: async () => ({ ok: false }), exists: async () => false });

  it('deduplicates one family and serializes another behind the global lock', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x'))); const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const install = vi.fn(async (_dataDir: string, family: string) => { order.push(`start:${family}`); if (family === 'codex') await first; order.push(`end:${family}`); return family; });
    const codexA = installFamily(root, 'codex', { ...deps(catalog), install: install as never });
    const codexB = installFamily(root, 'codex', { ...deps(catalog), install: install as never });
    const claude = installFamily(root, 'claude', { ...deps(catalog), install: install as never });
    await vi.waitFor(() => expect(order).toEqual(['start:codex'])); release();
    await Promise.all([codexA, codexB, claude]);
    expect(install).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['start:codex', 'end:codex', 'start:claude', 'end:claude']);
  }, 30_000);

  it('reports managed, broken, external, missing, and degrades off-matrix to PATH', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x')));
    let mode: 'managed' | 'broken' | 'external' | 'missing' = 'managed';
    const status = () => runtimeStatus(root, {
      catalog, platform: 'linux', arch: 'x64', probe: async () => mode === 'managed', probeManaged: async () => mode === 'managed',
      exists: async () => mode === 'broken', probePath: async () => ({ ok: mode === 'external' }),
    });
    expect((await status())[0]!.state).toBe('managed'); mode = 'broken'; expect((await status())[0]!.state).toBe('broken');
    mode = 'external'; clearRuntimeResolutionCache(); expect((await status())[0]!.state).toBe('external');
    mode = 'missing'; clearRuntimeResolutionCache(); expect((await status())[0]!.state).toBe('missing');
    clearRuntimeResolutionCache();
    const offMatrix = await runtimeStatus(root, { catalog, platform: 'aix', arch: 'ppc64', probePath: async () => ({ ok: true }) });
    expect(offMatrix).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'external', canInstallManaged: false })]));
  });

  it('keeps the mutation outcome when post-mutation status fails', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x')));
    const install = vi.fn(async () => { throw new Error('install boom'); });
    const failing = {
      catalog, platform: 'linux' as const, arch: 'x64',
      probe: async () => { throw new Error('status boom'); }, probeManaged: async () => { throw new Error('status boom'); },
      probePath: async () => ({ ok: false }), exists: async () => false,
    };
    await expect(installFamily(root, 'codex', { ...failing, install: install as never })).rejects.toThrow('install boom');
  }, 30_000);

  it('queues a clear behind an in-flight install instead of joining it', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x')));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const install = vi.fn(async () => { await gate; return '/fixture/codex'; });
    const events: unknown[] = []; subscribeRuntimeChanges(() => events.push('changed'));
    const installing = installFamily(root, 'codex', { ...deps(catalog), install: install as never });
    const clearing = clearFamily(root, 'codex', deps(catalog));
    release();
    expect((await clearing) as unknown).toBeUndefined();
    await installing;
    expect(install).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
  }, 30_000);

  it('keeps self-provision disabled unless explicitly flagged and emits a safe changed event', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x'))); const install = vi.fn(async () => '/fixture/codex');
    delete process.env.MAT_SELF_PROVISION;
    maybeSelfProvision(root, { ...deps(catalog), install: install as never });
    await Promise.resolve(); expect(install).not.toHaveBeenCalled();
    const events: unknown[] = []; subscribeRuntimeChanges((event) => events.push(event));
    await installFamily(root, 'codex', { ...deps(catalog), install: install as never });
    expect(events).toEqual([{ family: 'codex', state: 'missing', managedVersion: '2.3.4' }]);
  });

  it('quietly self-provisions missing managed runtimes once and in dependency order for desktop startup', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x'))); const order: string[] = [];
    let releaseCodex!: () => void;
    const codexGate = new Promise<void>((resolve) => { releaseCodex = resolve; });
    const install = vi.fn(async (_dataDir: string, family: string) => {
      order.push(`start:${family}`);
      if (family === 'codex') await codexGate;
      order.push(`end:${family}`);
      return `/fixture/${family}`;
    });
    const previous = process.env.MAT_SELF_PROVISION;
    process.env.MAT_SELF_PROVISION = '1';
    try {
      maybeSelfProvision(root, { ...deps(catalog), install: install as never });
      maybeSelfProvision(root, { ...deps(catalog), install: install as never });
      await vi.waitFor(() => expect(order).toEqual(['start:codex']));
      releaseCodex();
      await vi.waitFor(() => expect(order).toEqual(['start:codex', 'end:codex', 'start:claude', 'end:claude']));
      expect(install).toHaveBeenCalledTimes(2);
      expect(install).toHaveBeenNthCalledWith(1, root, 'codex', expect.any(Object));
      expect(install).toHaveBeenNthCalledWith(2, root, 'claude', expect.any(Object));
    } finally {
      if (previous === undefined) delete process.env.MAT_SELF_PROVISION;
      else process.env.MAT_SELF_PROVISION = previous;
    }
  }, 30_000);

  it('does not overwrite a broken managed runtime during desktop self-provision', async () => {
    const root = tempRoot(); const catalog = catalogFor(integrity(Buffer.from('x')));
    const install = vi.fn(async (_dataDir: string, family: string) => `/fixture/${family}`);
    const previous = process.env.MAT_SELF_PROVISION;
    process.env.MAT_SELF_PROVISION = '1';
    try {
      maybeSelfProvision(root, {
        ...deps(catalog),
        exists: async (path) => path.includes('claude-agent-sdk'),
        install: install as never,
      });
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
      expect(install).toHaveBeenCalledWith(root, 'codex', expect.any(Object));
    } finally {
      if (previous === undefined) delete process.env.MAT_SELF_PROVISION;
      else process.env.MAT_SELF_PROVISION = previous;
    }
  }, 30_000);
});

describe('runtime install lifecycle', () => {
  it('uses the idempotence gate before downloading', async () => {
    const root = tempRoot();
    const catalog = catalogFor(integrity(Buffer.from('unused')));
    const binary = managedBinaryPath(root, 'claude', catalog, 'linux-x64', 'linux');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, 'fixture');
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await installRuntime(root, 'claude', { catalog, platform: 'linux', arch: 'x64', fetch, probe: async () => true })).toBe(binary);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it('aborts on integrity mismatch before gunzip or extraction', async () => {
    const root = tempRoot();
    const archive = Buffer.from('not gzip');
    const catalog = catalogFor(integrity(Buffer.from('different')));
    const fetch = vi.fn(async () => new Response(archive)) as typeof globalThis.fetch;
    await expect(installRuntime(root, 'claude', { catalog, platform: 'linux', arch: 'x64', fetch, probe: async () => false }))
      .rejects.toThrow(/integrity mismatch/i);
    expect(existsSync(join(root, 'runtimes', 'claude-agent-sdk', '1.2.3'))).toBe(false);
  }, 30_000);

  it('installs a single Claude binary and mirrors the Codex tree with exec-bit rules', async () => {
    const root = tempRoot();
    const claudeArchive = gzipSync(tar([{ path: 'package/claude', bytes: Buffer.from('claude'), mode: 0o755 }]));
    const prefix = 'package/vendor/x86_64-unknown-linux-musl/';
    const codexArchive = gzipSync(tar([
      { path: `${prefix}bin/codex`, bytes: Buffer.from('codex'), mode: 0o755 },
      { path: `${prefix}codex-path/rg`, bytes: Buffer.from('rg'), mode: 0o755 },
      { path: `${prefix}codex-package.json`, bytes: Buffer.from('{}'), mode: 0o644 },
    ]));
    const catalog = catalogFor(integrity(claudeArchive), integrity(codexArchive));
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(String(url).includes('openai') ? codexArchive : claudeArchive)) as typeof globalThis.fetch;
    const probe = async (path: string): Promise<boolean> => existsSync(path);
    const claude = await installRuntime(root, 'claude', { catalog, platform: 'linux', arch: 'x64', fetch, probe });
    const codex = await installRuntime(root, 'codex', { catalog, platform: 'linux', arch: 'x64', fetch, probe });
    expect(readFileSync(claude, 'utf8')).toBe('claude');
    expect(readFileSync(codex, 'utf8')).toBe('codex');
    expect(readFileSync(join(codex, '../../codex-path/rg'), 'utf8')).toBe('rg');
    expect(readFileSync(join(codex, '../../codex-package.json'), 'utf8')).toBe('{}');
    if (process.platform !== 'win32') {
      expect(statSync(join(codex, '../../codex-path/rg')).mode & 0o777).toBe(0o700);
      expect(statSync(join(codex, '../../codex-package.json')).mode & 0o111).toBe(0);
    }
  }, 30_000);

  it('extracts Node through system tar and keeps only the binary, license, and marker', async () => {
    const root = tempRoot();
    const archive = Buffer.from('node archive fixture');
    const catalog = catalogFor(integrity(Buffer.from('x')));
    catalog.node.platforms['linux-x64']!.sha256 = createHash('sha256').update(archive).digest('hex');
    const fetch = vi.fn(async () => new Response(archive)) as typeof globalThis.fetch;
    const runTar = vi.fn(async (_command: string, args: string[]) => {
      const extracted = args[args.indexOf('-C') + 1]!;
      const packageRoot = join(extracted, 'node-v24.0.0-linux-x64');
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin/node'), 'node');
      writeFileSync(join(packageRoot, 'LICENSE'), 'license');
      writeFileSync(join(packageRoot, 'README.md'), 'must not copy');
    });
    const binary = await installRuntime(root, 'node', {
      catalog, platform: 'linux', arch: 'x64', fetch, runTar, probe: async (path) => existsSync(path),
    });
    const finalDir = join(binary, '../..');
    expect(readFileSync(binary, 'utf8')).toBe('node');
    expect(readFileSync(join(finalDir, 'LICENSE'), 'utf8')).toBe('license');
    expect(readFileSync(join(finalDir, '.node-version'), 'utf8')).toBe('24.0.0\n');
    expect(existsSync(join(finalDir, 'README.md'))).toBe(false);
    expect(runTar).toHaveBeenCalledWith('tar', expect.arrayContaining(['-xf']), expect.any(String));
  }, 30_000);

  it('rejects a traversing Node exePath before download', async () => {
    const root = tempRoot();
    const catalog = catalogFor(integrity(Buffer.from('x')));
    catalog.node.platforms['linux-x64']!.exePath = '../node';
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(installRuntime(root, 'node', { catalog, platform: 'linux', arch: 'x64', fetch }))
      .rejects.toThrow(/unsafe.*executable path/i);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it('tries System32 tar.exe before plain tar on win32', async () => {
    const root = tempRoot();
    const archive = Buffer.from('node archive fixture');
    const catalog = catalogFor(integrity(Buffer.from('x')));
    catalog.node.platforms['win32-x64'] = {
      nodePlatform: 'win', nodeArch: 'x64', archiveExt: 'zip', exePath: 'node.exe',
      sha256: createHash('sha256').update(archive).digest('hex'),
    };
    const runTar = vi.fn(async (command: string, args: string[]) => {
      if (command.includes('System32')) throw new Error('unavailable');
      const extracted = args[args.indexOf('-C') + 1]!;
      const packageRoot = join(extracted, 'node-v24.0.0-win-x64');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'node.exe'), 'node');
      writeFileSync(join(packageRoot, 'LICENSE'), 'license');
    });
    await installRuntime(root, 'node', {
      catalog, platform: 'win32', arch: 'x64', fetch: vi.fn(async () => new Response(archive)) as typeof globalThis.fetch,
      runTar, probe: async (path) => existsSync(path),
    });
    expect(runTar.mock.calls.map(([command]) => command)).toEqual(['C:\\Windows\\System32\\tar.exe', 'tar']);
  }, 30_000);

  it('cleans staging and leaves no final directory after staged validation fails', async () => {
    const root = tempRoot();
    const archive = gzipSync(tar([{ path: 'package/claude', bytes: Buffer.from('bad') }]));
    const catalog = catalogFor(integrity(archive));
    const fetch = vi.fn(async () => new Response(archive)) as typeof globalThis.fetch;
    await expect(installRuntime(root, 'claude', { catalog, platform: 'linux', arch: 'x64', fetch, probe: async () => false }))
      .rejects.toThrow(/failed --version/i);
    expect(existsSync(join(root, 'runtimes', 'claude-agent-sdk', '1.2.3'))).toBe(false);
    const tmp = join(root, 'runtimes', '.tmp');
    expect(existsSync(tmp) ? readFileNames(tmp) : []).toEqual([]);
  }, 30_000);

  it('rolls back an existing final directory when the staged rename fails', async () => {
    const root = tempRoot();
    const finalDir = join(root, 'final');
    const staged = join(root, 'staged');
    await mkdir(finalDir); await mkdir(staged);
    await writeFile(join(finalDir, 'old'), 'old');
    await writeFile(join(staged, 'new'), 'new');
    let calls = 0;
    const injectedRename: typeof rename = async (from, to) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('injected'), { code: 'EACCES' });
      await rename(from, to);
    };
    await expect(replaceRuntimeDir(staged, finalDir, { rename: injectedRename, uuid: () => 'test' })).rejects.toThrow('injected');
    expect(await readFile(join(finalDir, 'old'), 'utf8')).toBe('old');
  }, 30_000);

  it('prunes non-pinned versions but keeps pinned and dot directories', async () => {
    const root = tempRoot();
    for (const name of ['old', 'pinned', '.tmp']) mkdirSync(join(root, name), { recursive: true });
    expect(await pruneStaleRuntimeVersions(root, 'pinned')).toBe(1);
    expect(readFileNames(root).sort()).toEqual(['.tmp', 'pinned']);
  }, 30_000);
});

describe('runtime resolution', () => {
  it('uses absolute env override before managed and PATH and rejects relative overrides', async () => {
    const root = tempRoot();
    const catalog = catalogFor(integrity(Buffer.from('x')));
    const managed = vi.fn(async () => true);
    const path = vi.fn(async () => ({ ok: true }));
    expect(await resolveRuntimeBinary(root, 'claude', { catalog, env: { MAT_CLAUDE_BIN: '/fixture/claude' }, probeManaged: managed, probePath: path })).toBe('/fixture/claude');
    expect(managed).not.toHaveBeenCalled(); expect(path).not.toHaveBeenCalled();
    await expect(resolveRuntimeBinary(root, 'claude', { catalog, env: { MAT_CLAUDE_BIN: 'relative' } })).rejects.toThrow(/absolute/i);
  });

  it('prefers managed, falls back to existing PATH discovery, and invalidates when managed appears', async () => {
    const root = tempRoot();
    const catalog = catalogFor(integrity(Buffer.from('x')));
    let appeared = false;
    const path = vi.fn(async () => ({ ok: true }));
    expect(await resolveRuntimeBinary(root, 'codex', { catalog, env: {}, probeManaged: async () => appeared, probePath: path, platform: 'linux', arch: 'x64' })).toBe('codex');
    appeared = true;
    const expected = managedBinaryPath(root, 'codex', catalog, 'linux-x64', 'linux');
    expect(await resolveRuntimeBinary(root, 'codex', { catalog, env: {}, probeManaged: async () => appeared, probePath: path, platform: 'linux', arch: 'x64' })).toBe(expected);
    expect(path).toHaveBeenCalledTimes(1);
  });

  it('drops a cached managed path when managed disappears and retries PATH discovery', async () => {
    const root = tempRoot();
    const catalog = catalogFor(integrity(Buffer.from('x')));
    let available = true;
    const path = vi.fn(async () => ({ ok: true }));
    const expected = managedBinaryPath(root, 'codex', catalog, 'linux-x64', 'linux');
    expect(await resolveRuntimeBinary(root, 'codex', { catalog, env: {}, probeManaged: async () => available, probePath: path, platform: 'linux', arch: 'x64' })).toBe(expected);
    available = false;
    expect(await resolveRuntimeBinary(root, 'codex', { catalog, env: {}, probeManaged: async () => available, probePath: path, platform: 'linux', arch: 'x64' })).toBe('codex');
    expect(path).toHaveBeenCalledTimes(1);
  });

  it('returns null when neither managed nor PATH candidate is ready', async () => {
    const catalog = catalogFor(integrity(Buffer.from('x')));
    expect(await resolveRuntimeBinary(tempRoot(), 'node', { catalog, env: {}, probeManaged: async () => false, probePath: async () => ({ ok: false }), platform: 'linux', arch: 'x64' })).toBeNull();
  });
});

function readFileNames(path: string): string[] {
  return readdirSync(path);
}
