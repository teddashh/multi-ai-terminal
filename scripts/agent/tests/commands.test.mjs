import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { contractVersion, launchLockPath, root, statePath } from '../contract.mjs';

// Each test spawns real node processes; Windows CI needs headroom over the 5s default.
const SPAWN_TIMEOUT = 60_000;

test('doctor emits the versioned JSON contract', () => {
  const result = runScript('doctor.mjs', ['--json']);
  expect([0, 1], result.stderr).toContain(result.status);
  const payload = JSON.parse(result.stdout);
  expect(payload.schemaVersion).toBe(1);
  expect(payload.contractVersion).toBe(contractVersion);
  expect(payload.command).toBe('doctor');
  expect(payload.root).toBe(root);
  expect(Array.isArray(payload.checks)).toBe(true);
  expect(payload.ok).toBe(payload.checks.every((check) => check.ok));
}, SPAWN_TIMEOUT);

test('launch dry-run reports a plan without changing runtime state', () => {
  const beforeState = fileSnapshot(statePath);
  const beforeLock = fileSnapshot(launchLockPath);
  const result = runScript('launch.mjs', ['--dry-run', '--json']);
  const afterState = fileSnapshot(statePath);
  const afterLock = fileSnapshot(launchLockPath);

  expect([0, 1], result.stderr).toContain(result.status);
  expect(afterState).toEqual(beforeState);
  expect(afterLock).toEqual(beforeLock);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('launch');
  expect(payload.outcome).toBe('dry_run');
  expect(payload.writesPerformed).toEqual([]);
  expect(payload.plan.length).toBeGreaterThan(0);
  if (payload.prerequisitesOk) {
    // Another agent-lane instance may already be live on a dev machine.
    expect(['would_start', 'already_running', 'would_wait_for_existing', 'refused']).toContain(payload.predictedOutcome);
    if (payload.predictedOutcome === 'would_start') {
      expect(payload.plan.some((step) => step.disposition === 'would_start')).toBe(true);
      expect(payload.plan.some((step) => step.action === 'npm run build')).toBe(true);
    }
  } else {
    expect(payload.predictedOutcome).toBe('blocked');
    expect(payload.plan).toEqual([{ action: 'prerequisite gate', disposition: 'would_block' }]);
  }
}, SPAWN_TIMEOUT);

test('audit current is read-only and emits declared effects', () => {
  const beforeState = fileSnapshot(statePath);
  const result = runScript('audit.mjs', ['--phase', 'current', '--json']);
  const afterState = fileSnapshot(statePath);

  expect(result.status, result.stderr).toBe(0);
  expect(afterState).toEqual(beforeState);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('audit');
  expect(payload.phase).toBe('current');
  expect(Array.isArray(payload.artifacts)).toBe(true);
  expect(payload.artifacts.every((artifact) => Array.isArray(artifact.evidence) && artifact.evidence.length > 0)).toBe(true);
  expect(payload.declaredSideEffects.hostConfigurationByScripts.startsWith('none')).toBe(true);
  expect(payload.comparison).toBeNull();
}, SPAWN_TIMEOUT);

test('status reports a declared state and never a launch URL it cannot prove', () => {
  const result = runScript('status.mjs', ['--json', '--lines', '5']);
  expect([0, 1], result.stderr).toContain(result.status);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('status');
  expect(['not_started', 'building', 'ready', 'failed', 'exited', 'invalid_state', 'foreign_process']).toContain(payload.state);
  expect(payload.ok).toBe(payload.state === 'building' || payload.state === 'ready');
  // A URL may only come from a run segment that actually printed the marker.
  if (payload.url !== null) expect(['ready', 'exited']).toContain(payload.state);
}, SPAWN_TIMEOUT);

test('commands reject invalid usage with exit code 2', () => {
  const attempts = [
    runScript('doctor.mjs', ['--json', '--unknown']),
    runScript('launch.mjs', ['--json', '--dry-run', '--wait']),
    runScript('launch.mjs', ['--json', '--port', '65536']),
    runScript('status.mjs', ['--json', '--lines', '0']),
    runScript('audit.mjs', ['--json', '--write']),
    runScript('stop.mjs', ['--json', '--unknown']),
  ];
  for (const result of attempts) {
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }
}, SPAWN_TIMEOUT);

function runScript(name, args) {
  return spawnSync(process.execPath, [`scripts/agent/${name}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function fileSnapshot(filePath) {
  return existsSync(filePath) ? { exists: true, content: readFileSync(filePath, 'utf8') } : { exists: false };
}
