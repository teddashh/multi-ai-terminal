import { expect, test } from 'vitest';
import { artifactSignature, isValidBeforeAudit, isValidLaunchReceipt } from '../audit-model.mjs';

const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const valid = {
  schemaVersion: 1,
  contractVersion: '1.0.0',
  command: 'audit',
  phase: 'before',
  generatedAt: '2026-07-21T00:00:00.000Z',
  root,
  checks: [],
  artifacts: [],
};

test('after-audit comparison accepts only the matching before receipt', () => {
  expect(isValidBeforeAudit(valid, '1.0.0', root)).toBe(true);
  expect(isValidBeforeAudit({ ...valid, command: 'status' }, '1.0.0', root)).toBe(false);
  expect(isValidBeforeAudit({ ...valid, phase: 'after' }, '1.0.0', root)).toBe(false);
  expect(isValidBeforeAudit({ ...valid, contractVersion: '2.0.0' }, '1.0.0', root)).toBe(false);
  expect(isValidBeforeAudit({ ...valid, root: `${root}-other` }, '1.0.0', root)).toBe(false);
  expect(isValidBeforeAudit({ ...valid, generatedAt: 'not-a-date' }, '1.0.0', root)).toBe(false);
});

test('artifact signature includes evidence probes', () => {
  const base = {
    exists: true,
    kind: 'directory',
    size: 0,
    modifiedAt: '2026-07-21T00:00:00.000Z',
    evidence: [{ path: 'server/dist/index.js', exists: true, size: 1 }],
  };
  expect(artifactSignature(base)).not.toBe(artifactSignature({
    ...base,
    evidence: [{ path: 'server/dist/index.js', exists: true, size: 2 }],
  }));
  expect(artifactSignature(base)).toBe(artifactSignature({ ...base }));
});

test('audit accepts only a same-contract same-repository launch receipt', () => {
  const receipt = {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    outcome: 'accepted',
    root,
    startedAt: '2026-07-21T00:00:00.000Z',
    process: {
      pid: 42,
      stateFile: '.agent-runtime/mat-server.json',
      logFile: '.agent-runtime/mat-server.log',
    },
    steps: {},
    declaredRepositoryEffects: [],
    declaredUserCacheEffects: [],
    hostChangesByScript: [],
  };
  expect(isValidLaunchReceipt(receipt, '1.0.0', root)).toBe(true);
  expect(isValidLaunchReceipt({ ...receipt, root: `${root}-other` }, '1.0.0', root)).toBe(false);
  expect(isValidLaunchReceipt({ ...receipt, contractVersion: '2.0.0' }, '1.0.0', root)).toBe(false);
  expect(isValidLaunchReceipt({ ...receipt, process: { ...receipt.process, pid: 0 } }, '1.0.0', root)).toBe(false);
  expect(isValidLaunchReceipt({
    ...receipt,
    process: { ...receipt.process, stateFile: '.agent-runtime/other.json' },
  }, '1.0.0', root)).toBe(false);
});
