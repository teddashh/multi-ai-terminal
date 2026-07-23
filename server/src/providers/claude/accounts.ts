import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeAccountIndexResponse } from '@mat/shared';
import { getDataDir } from '../../store/dataDir.js';

export function readClaudeAccountIndex(dataDir = getDataDir()): ClaudeAccountIndexResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, 'claude-accounts.json'), 'utf8'));
  } catch {
    return { accounts: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { accounts: [] };
  const source = parsed as Record<string, unknown>;
  const accounts = Array.isArray(source.accounts)
    ? source.accounts.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
      const account = entry as Record<string, unknown>;
      if (typeof account.id !== 'string' || typeof account.email !== 'string') return [];
      return [{
        id: account.id,
        email: account.email,
        ...(typeof account.subscriptionType === 'string' ? { subscriptionType: account.subscriptionType } : {}),
        ...(typeof account.isDefault === 'boolean' ? { isDefault: account.isDefault } : {}),
        ...(typeof account.createdAt === 'string' ? { createdAt: account.createdAt } : {}),
      }];
    })
    : [];
  return {
    accounts,
    ...(typeof source.activeAccountId === 'string' ? { activeAccountId: source.activeAccountId } : {}),
  };
}
