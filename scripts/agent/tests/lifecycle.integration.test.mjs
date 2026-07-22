import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { isValidLaunchReceipt } from '../audit-model.mjs';
import { contractVersion, receiptPath, root } from '../contract.mjs';
import { processAlive } from '../process-identity.mjs';

// The full cycle builds the workspaces and boots a real server, so it runs only
// in the dedicated `npm run test:agent` step (MAT_AGENT_IT=1), not inside the
// parallel main suite.
describe.runIf(process.env.MAT_AGENT_IT === '1')('agent lane end-to-end', () => {
  test('launch --wait reaches ready, serves the UI, and stop cleans up', async () => {
    const before = JSON.parse(runScript('status.mjs', ['--json']).stdout);
    expect(before.state, 'stop the agent-lane server before running this test').toBe('not_started');

    // A private data dir keeps the test from racing a real MAT instance's stores.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'mat-agent-it-'));
    let launchedPid;
    try {
      const auditBefore = runScript('audit.mjs', ['--phase', 'before', '--write', '--json']);
      expect(auditBefore.status, auditBefore.stderr).toBe(0);

      const launch = runScript('launch.mjs', ['--json', '--wait', '--timeout-ms', '480000'], {
        env: { ...process.env, MAT_DATA_DIR: dataDir },
      });
      const launchPayload = JSON.parse(launch.stdout || '{}');
      expect(launch.status, JSON.stringify(launchPayload, null, 2)).toBe(0);
      expect(launchPayload.outcome).toBe('ready');
      expect(launchPayload.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(launchPayload.runtime.identityVerified).toBe(true);
      launchedPid = launchPayload.runtime.pid;

      const health = await (await fetch(`${launchPayload.url}api/health`)).json();
      expect(health.ok).toBe(true);
      const home = await fetch(launchPayload.url);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('<div id="root">');

      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(isValidLaunchReceipt(receipt, contractVersion, root)).toBe(true);

      const relaunch = JSON.parse(runScript('launch.mjs', ['--json']).stdout);
      expect(relaunch.outcome).toBe('already_running');
      expect(relaunch.runtime.url).toBe(launchPayload.url);

      const stop = JSON.parse(runScript('stop.mjs', ['--json']).stdout);
      expect(stop.outcome).toBe('stopped');
      expect(stop.pid).toBe(launchedPid);
      expect(processAlive(launchedPid)).toBe(false);
      launchedPid = undefined;

      const after = runScript('status.mjs', ['--json']);
      expect(after.status).toBe(1);
      expect(JSON.parse(after.stdout).state).toBe('not_started');

      const auditAfter = runScript('audit.mjs', ['--phase', 'after', '--write', '--json']);
      expect(auditAfter.status, auditAfter.stderr).toBe(0);
      const auditPayload = JSON.parse(auditAfter.stdout);
      expect(auditPayload.comparison).not.toBeNull();
      expect(auditPayload.comparison.hostRollbackPerformed).toBe(false);
      expect(auditPayload.lastLaunchReceipt).not.toBeNull();
    } finally {
      if (launchedPid !== undefined) runScript('stop.mjs', ['--json']);
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 600_000);
});

function runScript(name, args, options = {}) {
  return spawnSync(process.execPath, [`scripts/agent/${name}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}
