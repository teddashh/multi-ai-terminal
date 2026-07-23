import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeAccountIndex } from '../../src/providers/claude/accounts.js';

const roots: string[] = [];
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'mat-claude-accounts-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('readClaudeAccountIndex', () => {
  it('returns only approved account metadata and filters incomplete entries', () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'claude-accounts.json'), JSON.stringify({
      activeAccountId: 'account-1',
      unknownTopLevel: 'drop',
      accounts: [
        {
          id: 'account-1', email: 'one@example.test', subscriptionType: 'pro',
          isDefault: true, createdAt: '2026-07-22T00:00:00Z', credential: 'drop',
        },
        { id: 'account-2', subscriptionType: 'team' },
        null,
      ],
    }));
    expect(readClaudeAccountIndex(root)).toEqual({
      activeAccountId: 'account-1',
      accounts: [{
        id: 'account-1', email: 'one@example.test', subscriptionType: 'pro',
        isDefault: true, createdAt: '2026-07-22T00:00:00Z',
      }],
    });
  });

  it('returns an empty index when the file is missing', () => {
    expect(readClaudeAccountIndex(makeRoot())).toEqual({ accounts: [] });
  });
});
