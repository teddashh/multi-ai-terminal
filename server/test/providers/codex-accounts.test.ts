import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureCurrent, deriveAccountId, markActiveNeedsLogin, markActiveValid, readAccountIndex,
  readAuthIdentity, removeAccount, switchAccount, syncActiveFromSharedHome,
} from '../../src/providers/codex/accounts.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mat-codex-accounts-')); roots.push(root);
  const dataDir = join(root, 'data');
  const codexHome = join(root, 'home');
  mkdirSync(codexHome, { recursive: true });
  return { root, dataDir, codexHome };
}
const auth = (home: string, value: unknown) => writeFileSync(join(home, 'auth.json'), JSON.stringify(value));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('codex account store', () => {
  it('captures, switches only auth.json, and removes without touching the shared home', () => {
    const options = fixture();
    auth(options.codexHome, { account_id: 'first', email: 'first@example.test' });
    const first = captureCurrent(options);
    expect(first.ok).toBe(true);
    auth(options.codexHome, { account_id: 'second', email: 'second@example.test' });
    expect(captureCurrent(options).ok).toBe(true);
    writeFileSync(join(options.codexHome, 'config.toml'), 'survive');
    expect(switchAccount('first', options).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(options.codexHome, 'auth.json'), 'utf8')).account_id).toBe('first');
    expect(readFileSync(join(options.codexHome, 'config.toml'), 'utf8')).toBe('survive');
    expect(removeAccount('first', options)).toEqual({ ok: true, removed: true });
    expect(existsSync(join(options.dataDir, 'codex-accounts', 'first'))).toBe(false);
    expect(readFileSync(join(options.codexHome, 'config.toml'), 'utf8')).toBe('survive');
  });

  it('refuses unknown, missing-auth, and needs-login switches', () => {
    const options = fixture();
    expect(switchAccount('missing', options)).toMatchObject({ ok: false, error: 'Unknown codex account: missing' });
    auth(options.codexHome, { account_id: 'one' });
    captureCurrent(options);
    auth(options.codexHome, { account_id: 'two' });
    captureCurrent(options);
    rmSync(join(options.dataDir, 'codex-accounts', 'one', 'auth.json'));
    expect(switchAccount('one', options)).toMatchObject({ ok: false, error: expect.stringContaining('is missing') });
    markActiveNeedsLogin('expired', options);
    // needs-login wins even over the same-target re-capture path.
    expect(switchAccount('two', options)).toMatchObject({ ok: false, error: expect.stringContaining('needs login before it can be used again') });
  });

  it('derives identity in account-id, email, then seed priority including a fake JWT', () => {
    const options = fixture();
    const token = `fake.${Buffer.from(JSON.stringify({ email: 'x@y.z' })).toString('base64url')}.fake`;
    auth(options.codexHome, { tokens: { id_token: token } });
    expect(readAuthIdentity(join(options.codexHome, 'auth.json'))).toEqual({ email: 'x@y.z' });
    expect(deriveAccountId({ accountId: 'acct-1', email: 'x@y.z' }, 'seed')).toBe('acct-1');
    expect(deriveAccountId({ email: 'x@y.z' }, 'seed')).toMatch(/^[a-f0-9]{12}$/);
    expect(deriveAccountId({}, 'seed')).toMatch(/^[a-f0-9]{12}$/);
    expect(deriveAccountId({ email: 'x@y.z' }, 'seed')).not.toBe(deriveAccountId({}, 'seed'));
  });

  it('normalizes empty ids, booleans, and stale active ids', () => {
    const options = fixture();
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(join(options.dataDir, 'codex-accounts.json'), JSON.stringify({
      schemaVersion: 0, migrated: false, activeAccountId: 'stale',
      accounts: [{ id: '', label: 'drop', createdAt: 'x' }, { id: 'keep', label: 'Keep', createdAt: 'x' }],
    }));
    expect(readAccountIndex(options)).toEqual({
      schemaVersion: 1, migrated: false,
      accounts: [{ id: 'keep', label: 'Keep', createdAt: 'x', needsLogin: false }],
    });
  });

  it('does not rewrite no-op validity marks and syncs both shared-home branches', async () => {
    const options = fixture();
    auth(options.codexHome, { account_id: 'one' });
    captureCurrent(options);
    markActiveNeedsLogin('expired', options);
    const indexPath = join(options.dataDir, 'codex-accounts.json');
    const before = readFileSync(indexPath, 'utf8');
    const beforeMtime = statSync(indexPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 15));
    markActiveNeedsLogin('expired', options);
    expect(readFileSync(indexPath, 'utf8')).toBe(before);
    expect(statSync(indexPath).mtimeMs).toBe(beforeMtime);
    markActiveValid(options);
    const valid = readFileSync(indexPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 15));
    markActiveValid(options);
    expect(readFileSync(indexPath, 'utf8')).toBe(valid);
    expect(syncActiveFromSharedHome(options).ok).toBe(true);
    rmSync(join(options.codexHome, 'auth.json'));
    expect(syncActiveFromSharedHome(options).ok).toBe(true);
    expect(readAccountIndex(options).activeAccountId).toBeUndefined();
  });

  it('refuses path-escaping account ids and hashes unsafe auth account_ids', () => {
    const options = fixture();
    for (const evil of ['../escape', '..', 'a/b', 'a\\b', `x${'y'.repeat(200)}`]) {
      expect(switchAccount(evil, options)).toMatchObject({ ok: false, error: 'Invalid codex account id.' });
      expect(removeAccount(evil, options)).toMatchObject({ ok: false, error: 'Invalid codex account id.' });
    }
    auth(options.codexHome, { account_id: '../../escape', email: 'evil@example.test' });
    const captured = captureCurrent(options);
    expect(captured.ok).toBe(true);
    const id = readAccountIndex(options).activeAccountId!;
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(existsSync(join(options.dataDir, 'codex-accounts', id, 'auth.json'))).toBe(true);
    expect(existsSync(join(options.dataDir, 'escape'))).toBe(false);
    expect(existsSync(join(options.root, 'escape'))).toBe(false);
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(join(options.dataDir, 'codex-accounts.json'), JSON.stringify({
      schemaVersion: 1, migrated: false, activeAccountId: '../evil',
      accounts: [{ id: '../evil', label: 'drop', createdAt: 'x' }],
    }));
    expect(readAccountIndex(options).accounts).toEqual([]);
  });

  it('re-snapshots the outgoing account on switch and re-captures a same-target switch', () => {
    const options = fixture();
    auth(options.codexHome, { account_id: 'one', token: 'one-original' });
    captureCurrent(options);
    auth(options.codexHome, { account_id: 'two', token: 'two-original' });
    captureCurrent(options);
    // Shared home rotates two's token after the snapshot aged.
    auth(options.codexHome, { account_id: 'two', token: 'two-rotated' });
    expect(switchAccount('one', options).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(options.dataDir, 'codex-accounts', 'two', 'auth.json'), 'utf8')).token).toBe('two-rotated');
    expect(JSON.parse(readFileSync(join(options.codexHome, 'auth.json'), 'utf8')).token).toBe('one-original');
    // Same-target switch must not restore a stale snapshot over fresh tokens.
    auth(options.codexHome, { account_id: 'one', token: 'one-rotated' });
    expect(switchAccount('one', options).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(options.codexHome, 'auth.json'), 'utf8')).token).toBe('one-rotated');
    expect(JSON.parse(readFileSync(join(options.dataDir, 'codex-accounts', 'one', 'auth.json'), 'utf8')).token).toBe('one-rotated');
  });

  it('protects copied auth files with mode 0600', () => {
    const options = fixture();
    auth(options.codexHome, { account_id: 'one' });
    chmodSync(join(options.codexHome, 'auth.json'), 0o644);
    captureCurrent(options);
    if (process.platform !== 'win32') {
      expect(statSync(join(options.dataDir, 'codex-accounts', 'one', 'auth.json')).mode & 0o777).toBe(0o600);
    }
  });
});
