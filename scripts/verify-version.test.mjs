import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyVersionSync } from './verify-version.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fixture(version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'mat-version-'));
  dirs.push(root);
  for (const path of ['server/src', 'web', 'desktop/src-tauri']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'server/package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'web/package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'desktop/src-tauri/tauri.conf.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'desktop/src-tauri/Cargo.toml'), `[package]\nname = "mat"\nversion = "${version}"\n\n[dependencies]\ntauri = "2"\n`);
  writeFileSync(join(root, 'server/src/version.ts'), `export const VERSION = '${version}';\n`);
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    version, packages: { '': { version }, server: { version }, web: { version } },
  }));
  return root;
}

describe('version synchronization verifier', () => {
  it('accepts six matching authoritative versions, lock metadata, and tag', () => {
    expect(verifyVersionSync({ root: fixture(), tag: 'v1.2.3' })).toBe('1.2.3');
  });

  it('reports every mismatched lock or manifest value', () => {
    const root = fixture();
    writeFileSync(join(root, 'web/package.json'), JSON.stringify({ version: '1.2.4' }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      version: '1.2.2', packages: { '': { version: '1.2.3' }, server: { version: '1.2.3' }, web: { version: '1.2.2' } },
    }));
    expect(() => verifyVersionSync({ root, tag: 'v9.9.9' })).toThrow(/web\/package\.json[\s\S]*package-lock\.json[\s\S]*release tag/);
  });

  it('rejects a non-semver root version', () => {
    expect(() => verifyVersionSync({ root: fixture('next') })).toThrow('invalid product version');
  });
});
