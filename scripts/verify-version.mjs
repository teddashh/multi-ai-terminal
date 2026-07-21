#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function cargoVersion(text) {
  const marker = /^\[package\]\s*$/m.exec(text);
  if (!marker || marker.index === undefined) return undefined;
  const remainder = text.slice(marker.index + marker[0].length);
  const nextSection = /^\[/m.exec(remainder);
  const packageBlock = nextSection?.index === undefined ? remainder : remainder.slice(0, nextSection.index);
  return /^version\s*=\s*"([^"]+)"\s*$/m.exec(packageBlock)?.[1];
}

function sourceVersion(text) {
  return /\bVERSION\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1];
}

export function readVersionState(root = DEFAULT_ROOT) {
  const packageJson = readJson(join(root, 'package.json'));
  const serverPackage = readJson(join(root, 'server', 'package.json'));
  const webPackage = readJson(join(root, 'web', 'package.json'));
  const tauriConfig = readJson(join(root, 'desktop', 'src-tauri', 'tauri.conf.json'));
  const cargoToml = readFileSync(join(root, 'desktop', 'src-tauri', 'Cargo.toml'), 'utf8');
  const versionSource = readFileSync(join(root, 'server', 'src', 'version.ts'), 'utf8');
  const packageLock = readJson(join(root, 'package-lock.json'));

  return {
    authoritative: {
      'package.json': packageJson.version,
      'server/package.json': serverPackage.version,
      'web/package.json': webPackage.version,
      'desktop/src-tauri/tauri.conf.json': tauriConfig.version,
      'desktop/src-tauri/Cargo.toml': cargoVersion(cargoToml),
      'server/src/version.ts': sourceVersion(versionSource),
    },
    lock: {
      'package-lock.json': packageLock.version,
      'package-lock.json packages[""]': packageLock.packages?.['']?.version,
      'package-lock.json packages["server"]': packageLock.packages?.server?.version,
      'package-lock.json packages["web"]': packageLock.packages?.web?.version,
    },
  };
}

export function verifyVersionSync({ root = DEFAULT_ROOT, tag } = {}) {
  const state = readVersionState(root);
  const expected = state.authoritative['package.json'];
  const failures = [];

  if (typeof expected !== 'string' || !SEMVER.test(expected)) {
    failures.push(`package.json has an invalid product version: ${JSON.stringify(expected)}`);
  }
  for (const [file, version] of Object.entries({ ...state.authoritative, ...state.lock })) {
    if (version !== expected) failures.push(`${file} is ${JSON.stringify(version)}; expected ${JSON.stringify(expected)}`);
  }
  if (tag !== undefined && tag !== `v${expected}`) {
    failures.push(`release tag is ${JSON.stringify(tag)}; expected ${JSON.stringify(`v${expected}`)}`);
  }
  if (failures.length > 0) throw new Error(`Version synchronization failed:\n- ${failures.join('\n- ')}`);
  return expected;
}

function parseCli(argv) {
  let tag = process.env.MAT_EXPECT_TAG;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--tag' && argv[index + 1]) {
      tag = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return { tag };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  try {
    const version = verifyVersionSync(parseCli(process.argv.slice(2)));
    console.log(`[verify-version] PASS: all manifests and lock metadata report ${version}`);
  } catch (error) {
    console.error(`[verify-version] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
