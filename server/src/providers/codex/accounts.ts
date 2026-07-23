import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_ACCOUNT_ID_PATTERN, type CodexAccount, type CodexAccountIndex } from '@mat/shared';
import { redactEnvironmentValues } from '../../redact.js';
import { getDataDir } from '../../store/dataDir.js';

export interface CodexAccountStoreOptions {
  dataDir?: string;
  codexHome?: string;
}

export interface AuthIdentity { email?: string; accountId?: string }
export type AccountOperationResponse = { ok: true; account?: CodexAccount; removed?: boolean } | { ok: false; error: string };

export function sharedCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex');
}

function paths(options: CodexAccountStoreOptions = {}) {
  const dataDir = options.dataDir ?? getDataDir();
  const codexHome = options.codexHome ?? sharedCodexHome();
  return {
    dataDir, codexHome,
    index: join(dataDir, 'codex-accounts.json'),
    sharedAuth: join(codexHome, 'auth.json'),
    accountDir: (id: string) => join(dataDir, 'codex-accounts', id),
    accountAuth: (id: string) => join(dataDir, 'codex-accounts', id, 'auth.json'),
  };
}

const emptyIndex = (): CodexAccountIndex => ({ schemaVersion: 1, migrated: false, accounts: [] });
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

function normalizeIndex(value: unknown): CodexAccountIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyIndex();
  const raw = value as Record<string, unknown>;
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.flatMap((entry): CodexAccount[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const id = optionalString(item.id);
    if (!id || !CODEX_ACCOUNT_ID_PATTERN.test(id)) return [];
    return [{
      id,
      ...(optionalString(item.email) ? { email: optionalString(item.email) } : {}),
      ...(optionalString(item.accountId) ? { accountId: optionalString(item.accountId) } : {}),
      label: optionalString(item.label) ?? id,
      ...(optionalString(item.sourceHome) ? { sourceHome: optionalString(item.sourceHome) } : {}),
      createdAt: optionalString(item.createdAt) ?? new Date(0).toISOString(),
      needsLogin: item.needsLogin === true,
      ...(optionalString(item.lastValidatedAt) ? { lastValidatedAt: optionalString(item.lastValidatedAt) } : {}),
      ...(optionalString(item.lastInvalidatedAt) ? { lastInvalidatedAt: optionalString(item.lastInvalidatedAt) } : {}),
      ...(optionalString(item.lastAuthError) ? { lastAuthError: optionalString(item.lastAuthError) } : {}),
    }];
  }) : [];
  const active = optionalString(raw.activeAccountId);
  return {
    schemaVersion: 1,
    migrated: raw.migrated === true,
    ...(active && accounts.some((account) => account.id === active) ? { activeAccountId: active } : {}),
    accounts,
  };
}

export function readAccountIndex(options: CodexAccountStoreOptions = {}): CodexAccountIndex {
  try {
    return normalizeIndex(JSON.parse(readFileSync(paths(options).index, 'utf8')));
  } catch {
    return emptyIndex();
  }
}

function atomicWrite(path: string, contents: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, contents, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
  if (mode !== undefined) chmodSync(path, mode);
}

function writeIndex(options: CodexAccountStoreOptions, index: CodexAccountIndex): void {
  atomicWrite(paths(options).index, `${JSON.stringify(normalizeIndex(index), null, 2)}\n`);
}

function copyAuth(from: string, to: string): void {
  atomicWrite(to, readFileSync(from, 'utf8'), 0o600);
}

function jwtEmail(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return optionalString(claims.email);
  } catch {
    return undefined;
  }
}

export function readAuthIdentity(authJsonPath: string): AuthIdentity {
  try {
    const value = JSON.parse(readFileSync(authJsonPath, 'utf8')) as Record<string, unknown>;
    const tokens = value.tokens && typeof value.tokens === 'object' && !Array.isArray(value.tokens)
      ? value.tokens as Record<string, unknown> : {};
    const email = optionalString(value.email) ?? optionalString(tokens.email)
      ?? (typeof tokens.id_token === 'string' ? jwtEmail(tokens.id_token) : undefined);
    const accountId = optionalString(value.account_id) ?? optionalString(tokens.account_id);
    return { ...(email ? { email } : {}), ...(accountId ? { accountId } : {}) };
  } catch {
    return {};
  }
}

const hash12 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);
// Account ids become path segments under <dataDir>/codex-accounts/, so anything
// outside the shared alphabet (auth.json account_id is attacker-writable) must
// be hashed or refused before it can reach join().
export const isSafeAccountId = (value: string): boolean => CODEX_ACCOUNT_ID_PATTERN.test(value);
export function deriveAccountId(identity: AuthIdentity, fallbackSeed: string): string {
  const fromAuth = identity.accountId?.trim();
  if (fromAuth) return isSafeAccountId(fromAuth) ? fromAuth : hash12(fromAuth);
  return hash12(identity.email?.trim() || fallbackSeed);
}

function failure(error: unknown): AccountOperationResponse {
  return { ok: false, error: redactEnvironmentValues(error instanceof Error ? error.message : String(error)) };
}
const refusal = (error: string): AccountOperationResponse => ({ ok: false, error: redactEnvironmentValues(error) });

export function captureCurrent(options: CodexAccountStoreOptions = {}): AccountOperationResponse {
  try {
    const p = paths(options);
    if (!existsSync(p.sharedAuth)) return refusal('No auth.json in codex home to capture.');
    const identity = readAuthIdentity(p.sharedAuth);
    const id = deriveAccountId(identity, p.codexHome);
    copyAuth(p.sharedAuth, p.accountAuth(id));
    const index = readAccountIndex(options);
    const now = new Date().toISOString();
    let account = index.accounts.find((item) => item.id === id);
    if (account) {
      account = {
        ...account, ...identity, label: account.label || identity.email || id,
        sourceHome: p.codexHome, needsLogin: false, lastValidatedAt: now,
      };
      delete account.lastInvalidatedAt;
      delete account.lastAuthError;
      index.accounts[index.accounts.findIndex((item) => item.id === id)] = account;
    } else {
      account = {
        id, ...identity, label: identity.email ?? id, sourceHome: p.codexHome,
        createdAt: now, needsLogin: false, lastValidatedAt: now,
      };
      index.accounts.push(account);
    }
    index.activeAccountId = id;
    writeIndex(options, index);
    return { ok: true, account };
  } catch (error) { return failure(error); }
}

export function switchAccount(id: string, options: CodexAccountStoreOptions = {}): AccountOperationResponse {
  try {
    if (!isSafeAccountId(id)) return refusal('Invalid codex account id.');
    const p = paths(options);
    const index = readAccountIndex(options);
    const account = index.accounts.find((item) => item.id === id);
    if (!account) return refusal(`Unknown codex account: ${id}`);
    if (account.needsLogin) return refusal(`Codex account ${id} needs login before it can be used again.`);
    // Refresh tokens rotate in the shared home while store snapshots age, so
    // switching to the active account re-captures instead of restoring a stale
    // copy, and switching away re-snapshots the outgoing account first.
    if (index.activeAccountId === id && existsSync(p.sharedAuth)) return captureCurrent(options);
    if (!existsSync(p.accountAuth(id))) return refusal(`auth.json for codex account ${id} is missing; not switching.`);
    const outgoing = index.activeAccountId;
    if (outgoing && outgoing !== id && existsSync(p.sharedAuth) && index.accounts.some((item) => item.id === outgoing)) {
      copyAuth(p.sharedAuth, p.accountAuth(outgoing));
    }
    copyAuth(p.accountAuth(id), p.sharedAuth);
    index.activeAccountId = id;
    writeIndex(options, index);
    return { ok: true, account };
  } catch (error) { return failure(error); }
}

export function removeAccount(id: string, options: CodexAccountStoreOptions = {}): AccountOperationResponse {
  try {
    if (!isSafeAccountId(id)) return refusal('Invalid codex account id.');
    const p = paths(options);
    const index = readAccountIndex(options);
    const found = index.accounts.some((item) => item.id === id);
    if (found) rmSync(p.accountDir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    index.accounts = index.accounts.filter((item) => item.id !== id);
    if (index.activeAccountId === id) delete index.activeAccountId;
    if (found) writeIndex(options, index);
    return { ok: true, removed: found };
  } catch (error) { return failure(error); }
}

export function syncActiveFromSharedHome(options: CodexAccountStoreOptions = {}): AccountOperationResponse {
  const p = paths(options);
  if (existsSync(p.sharedAuth)) return captureCurrent(options);
  try {
    const index = readAccountIndex(options);
    if (index.activeAccountId !== undefined) {
      delete index.activeAccountId;
      writeIndex(options, index);
    }
    return { ok: true };
  } catch (error) { return failure(error); }
}

export function markActiveNeedsLogin(reason: string, options: CodexAccountStoreOptions = {}): AccountOperationResponse {
  try {
    const index = readAccountIndex(options);
    const account = index.accounts.find((item) => item.id === index.activeAccountId);
    if (!account) return { ok: true };
    const cleanReason = redactEnvironmentValues(reason);
    if (account.needsLogin && account.lastAuthError === cleanReason) return { ok: true, account };
    account.needsLogin = true;
    account.lastInvalidatedAt = new Date().toISOString();
    account.lastAuthError = cleanReason;
    writeIndex(options, index);
    return { ok: true, account };
  } catch (error) { return failure(error); }
}

export function markActiveValid(options: CodexAccountStoreOptions = {}): AccountOperationResponse {
  try {
    const index = readAccountIndex(options);
    const account = index.accounts.find((item) => item.id === index.activeAccountId);
    if (!account) return { ok: true };
    if (!account.needsLogin && account.lastInvalidatedAt === undefined && account.lastAuthError === undefined) return { ok: true, account };
    account.needsLogin = false;
    account.lastValidatedAt = new Date().toISOString();
    delete account.lastInvalidatedAt;
    delete account.lastAuthError;
    writeIndex(options, index);
    return { ok: true, account };
  } catch (error) { return failure(error); }
}
