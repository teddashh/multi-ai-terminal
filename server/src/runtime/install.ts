import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { currentPlatformKey, loadRuntimeCatalog, platformEntry, runtimeVersion, type RuntimeCatalog, type RuntimeFamily } from './catalog.js';
import { readTarEntry, tarEntriesUnder } from './tar.js';

export interface InstallDependencies {
  fetch?: typeof fetch;
  probe?: (path: string, timeoutMs: number) => Promise<boolean>;
  rename?: typeof rename;
  uuid?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  catalog?: RuntimeCatalog;
  runTar?: (command: string, args: string[], cwd: string) => Promise<void>;
}

const FAMILY_DIR = { claude: 'claude-agent-sdk', codex: 'codex', node: 'node' } as const;
const exeName = (name: string, platform = process.platform): string => platform === 'win32' ? `${name}.exe` : name;

function nodeExeSegments(exePath: string): string[] {
  const segments = exePath.split('/');
  if (!exePath || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error(`Unsafe Node runtime executable path: ${exePath}`);
  }
  return segments;
}

export async function download(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'multi-ai-terminal-runtime-installer' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Runtime download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function verifyDigest(bytes: Uint8Array, algorithm: string, expected: Buffer, message: string): void {
  let actual: Buffer;
  try { actual = createHash(algorithm).update(bytes).digest(); } catch { throw new Error(`Unsupported integrity algorithm: ${algorithm}`); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error(message);
}

export function verifySriSha512(bytes: Uint8Array, integrity: string): void {
  const dash = integrity.indexOf('-');
  if (dash < 1 || dash === integrity.length - 1) throw new Error('Missing runtime package integrity');
  const algorithm = integrity.slice(0, dash);
  const encoded = integrity.slice(dash + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) {
    throw new Error('Malformed runtime package integrity');
  }
  const expected = Buffer.from(encoded, 'base64');
  if (!expected.length) throw new Error('Malformed runtime package integrity');
  verifyDigest(bytes, algorithm, expected, 'Runtime package integrity mismatch');
}

export function verifySha256Hex(bytes: Uint8Array, hex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Malformed runtime sha256');
  verifyDigest(bytes, 'sha256', Buffer.from(hex, 'hex'), 'Runtime archive sha256 mismatch');
}

export function codexTargetTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const triples: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
    'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const triple = triples[`${platform}-${arch}`];
  if (!triple) throw new Error(`Codex managed runtime is unsupported on ${platform}-${arch}`);
  return triple;
}

export function managedRuntimeDir(dataDir: string, family: RuntimeFamily, catalog = loadRuntimeCatalog(), key = currentPlatformKey()): string {
  return resolve(dataDir, 'runtimes', FAMILY_DIR[family], runtimeVersion(family, catalog), key);
}

export function managedBinaryPath(dataDir: string, family: RuntimeFamily, catalog = loadRuntimeCatalog(), key = currentPlatformKey(), platform = process.platform): string {
  const root = managedRuntimeDir(dataDir, family, catalog, key);
  if (family === 'codex') return join(root, 'bin', exeName('codex', platform));
  if (family === 'node') return join(root, ...nodeExeSegments(platformEntry('node', key, catalog).exePath));
  return join(root, exeName('claude', platform));
}

export async function probeRuntime(path: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return await new Promise<boolean>((done) => {
      const child = spawn(path, ['--version'], { stdio: 'ignore', windowsHide: true });
      let settled = false;
      const finish = (ok: boolean): void => { if (!settled) { settled = true; clearTimeout(timer); done(ok); } };
      const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
      timer.unref();
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
  } catch { return false; }
}

export async function replaceRuntimeDir(tmpFinal: string, finalDir: string, deps: Pick<InstallDependencies, 'rename' | 'uuid'> = {}): Promise<void> {
  const renameImpl = deps.rename ?? rename;
  await mkdir(dirname(finalDir), { recursive: true, mode: 0o700 });
  const backup = join(dirname(finalDir), `.${basename(finalDir)}.backup-${(deps.uuid ?? randomUUID)()}`);
  let hadExisting = false;
  try { await access(finalDir); await renameImpl(finalDir, backup); hadExisting = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await renameImpl(tmpFinal, finalDir);
    if (hadExisting) await rm(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  } catch (error) {
    if (hadExisting) {
      try { await renameImpl(backup, finalDir); } catch (rollbackError) {
        const installMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${installMessage}; rollback failed: ${rollbackMessage}. Existing runtime remains in backup directory ${backup}`);
      }
    }
    throw error;
  }
}

export async function pruneStaleRuntimeVersions(familyRoot: string, pinned: string): Promise<number> {
  let entries;
  try { entries = await readdir(familyRoot, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === pinned) continue;
    try { await rm(join(familyRoot, entry.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); removed += 1; } catch { /* best effort */ }
  }
  return removed;
}

async function systemTar(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`tar exited with code ${String(code)}`)));
  });
}

function assertContained(root: string, target: string): void {
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    throw new Error('Runtime path escaped staging directory');
  }
}

export async function installRuntime(dataDir: string, family: RuntimeFamily, dependencies: InstallDependencies = {}): Promise<string> {
  const catalog = dependencies.catalog ?? loadRuntimeCatalog();
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const key = `${platform}-${arch}`;
  const entry = platformEntry(family, key, catalog);
  const version = runtimeVersion(family, catalog);
  const finalDir = managedRuntimeDir(dataDir, family, catalog, key);
  const finalPath = managedBinaryPath(dataDir, family, catalog, key, platform);
  const probe = dependencies.probe ?? probeRuntime;
  if (await probe(finalPath, 5_000)) return finalPath;

  const runtimes = resolve(dataDir, 'runtimes');
  const tmpRoot = join(runtimes, '.tmp', `${FAMILY_DIR[family]}-${(dependencies.uuid ?? randomUUID)()}`);
  const tmpFinal = join(tmpRoot, 'final');
  assertContained(runtimes, tmpRoot);
  try {
    let stagedBinary: string;
    if (family === 'claude') {
      const claude = entry as RuntimeCatalog['claude']['platforms'][string];
      const url = `https://registry.npmjs.org/@anthropic-ai/${claude.packageName}/-/${claude.packageName}-${version}.tgz`;
      const archive = await download(url, 60_000, dependencies.fetch);
      verifySriSha512(archive, claude.integrity);
      const bytes = readTarEntry(gunzipSync(archive), `package/${exeName('claude', platform)}`);
      if (!bytes) throw new Error('Claude native package is missing its binary');
      await mkdir(tmpFinal, { recursive: true, mode: 0o700 });
      stagedBinary = join(tmpFinal, exeName('claude', platform));
      await writeFile(stagedBinary, bytes, { mode: 0o700 });
      if (platform !== 'win32') await chmod(stagedBinary, 0o700);
    } else if (family === 'codex') {
      const codex = entry as RuntimeCatalog['codex']['platforms'][string];
      const url = `https://registry.npmjs.org/@openai/codex/-/codex-${codex.npmVersion}.tgz`;
      const archive = await download(url, 120_000, dependencies.fetch);
      verifySriSha512(archive, codex.integrity);
      const prefix = `package/vendor/${codexTargetTriple(platform, arch)}/`;
      const entries = tarEntriesUnder(gunzipSync(archive), prefix);
      if (!entries.length) throw new Error(`Codex native package has no files under ${prefix}`);
      for (const item of entries) {
        const destination = join(tmpFinal, ...item.path.split('/'));
        assertContained(tmpFinal, destination);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, item.bytes);
        if (platform !== 'win32' && (item.mode & 0o111) !== 0) await chmod(destination, 0o700);
      }
      stagedBinary = join(tmpFinal, 'bin', exeName('codex', platform));
    } else {
      const node = entry as RuntimeCatalog['node']['platforms'][string];
      const archiveName = `node-v${version}-${node.nodePlatform}-${node.nodeArch}.${node.archiveExt}`;
      const archive = await download(`https://nodejs.org/dist/v${version}/${archiveName}`, 60_000, dependencies.fetch);
      verifySha256Hex(archive, node.sha256);
      await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
      const archivePath = join(tmpRoot, archiveName);
      const extracted = join(tmpRoot, 'extracted');
      await mkdir(extracted, { recursive: true, mode: 0o700 });
      await writeFile(archivePath, archive);
      const tarCommand = platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
      try { await (dependencies.runTar ?? systemTar)(tarCommand, ['-xf', archivePath, '-C', extracted], tmpRoot); }
      catch (error) {
        if (platform !== 'win32') throw error;
        await (dependencies.runTar ?? systemTar)('tar', ['-xf', archivePath, '-C', extracted], tmpRoot);
      }
      const archiveRoot = join(extracted, `node-v${version}-${node.nodePlatform}-${node.nodeArch}`);
      const exeSegments = nodeExeSegments(node.exePath);
      const sourceBinary = join(archiveRoot, ...exeSegments);
      stagedBinary = join(tmpFinal, ...exeSegments);
      assertContained(tmpFinal, stagedBinary);
      await mkdir(dirname(stagedBinary), { recursive: true, mode: 0o700 });
      await copyFile(sourceBinary, stagedBinary);
      if (platform !== 'win32') await chmod(stagedBinary, 0o700);
      await copyFile(join(archiveRoot, 'LICENSE'), join(tmpFinal, 'LICENSE'));
      await writeFile(join(tmpFinal, '.node-version'), `${version}\n`);
    }
    if (!await probe(stagedBinary, 5_000)) throw new Error(`Installed ${family} binary failed --version check`);
    await replaceRuntimeDir(tmpFinal, finalDir, dependencies);
    await pruneStaleRuntimeVersions(join(runtimes, FAMILY_DIR[family]), version);
    return finalPath;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
}
