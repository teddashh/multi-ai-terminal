import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, RunSnapshot, Workspace } from '@mat/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunReport } from '../../src/engine/report.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }))));

describe('run report', () => {
  it('renders deterministic evidence, handoffs, degraded gates, and failure logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-report-')); dirs.push(dir);
    const patch = join(dir, 'node.patch'); writeFileSync(patch, 'diff --git a/a b/a\n--- a/a\n+++ b/a\n+ok\n');
    const run: RunSnapshot = {
      runId: 'run-1', workspaceId: 'w', task: 'Ship evidence', status: 'done', createdAt: 1000, endedAt: 4000,
      workflow: {
        schemaVersion: 1, id: 'wf', name: 'Pipeline', description: '', maxParallel: 1, maxRetriesPerStage: 1,
        orchestrator: { enabled: true, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 },
        stages: [{ id: 'review', name: 'Review', isolation: 'none', join: 'all', timeoutSec: 60, stallSec: 30, gate: true, requireVerified: false, slots: [] }],
      },
      nodes: [{
        nodeRunId: 'review.r.0', stageId: 'review', slotId: 'r', instanceIndex: 0, agent: { provider: 'mock', model: 'ok', permission: 'safe' }, label: 'Reviewer', status: 'done', attempt: 2, cwd: dir,
        startedAt: 1500, endedAt: 3000, patchFile: patch, resultText: 'Needs one fix', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        verification: { status: 'failed', command: 'npm test', exitCode: 1, durationMs: 50, outputTail: 'assertion failed' },
        handoff: { priorNodeRunIds: ['implement.i.0'], orchestratorContext: true, retryAddendum: false },
      }],
      gateDecisions: [{ stageId: 'review', gateAttempt: 2, action: 'advance', degraded: true, rationale: 'budget exhausted', contextForNext: 'Fix tests', ts: 3500 }],
      providerVersions: { mock: 'mock/0' },
    };
    const workspace: Workspace = { id: 'w', name: 'Repo', path: dir, isGit: true };
    const events: AgentEvent[] = [{ id: 'e', seq: 1, runId: 'run-1', stageId: 'review', nodeRunId: 'review.r.0', attempt: 2, role: 'tool', kind: 'tool_use', text: 'test', ts: 2000 }];
    const report = buildRunReport(run, workspace, events);
    expect(buildRunReport(run, workspace, events)).toBe(report);
    expect(report).toContain('# Run report — Pipeline');
    expect(report).toContain('## Outcome');
    expect(report).toContain('degraded at stage Review');
    expect(report).toContain('Handoff: ← implement.i.0 + orchestrator context');
    expect(report).toContain('## Gate decisions');
    expect(report).toContain('## Verification logs');
    expect(report).toContain('assertion failed');
    expect(report).toContain('tool calls 1');
  });

  it('includes a bounded errorReason for failed nodes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat-report-auth-')); dirs.push(dir);
    const reason = `Sign in: ${'x'.repeat(240)}`;
    const run: RunSnapshot = {
      runId: 'run-auth', workspaceId: 'w', task: 'Auth', status: 'failed', createdAt: 1, endedAt: 2,
      workflow: { schemaVersion: 1, id: 'wf', name: 'Auth', description: '', maxParallel: 1, maxRetriesPerStage: 1, orchestrator: { enabled: false, agent: { provider: 'mock', permission: 'safe' }, gateTimeoutSec: 30 }, stages: [{ id: 's', name: 'S', slots: [], isolation: 'none', join: 'all', timeoutSec: 30, stallSec: 10, gate: false, requireVerified: false }] },
      nodes: [{ nodeRunId: 's.a.0', stageId: 's', slotId: 'a', instanceIndex: 0, agent: { provider: 'codex', permission: 'safe' }, label: 'A', status: 'failed', attempt: 1, cwd: dir, error: 'exit 1', errorReason: reason }], gateDecisions: [],
    };
    const report = buildRunReport(run, { id: 'w', name: 'W', path: dir, isGit: false }, []);
    const line = report.split('\n').find((value) => value.includes('  - Error:'))!;
    expect(line).toContain('Sign in:');
    expect(line).not.toContain('exit 1');
    expect(line.length).toBeLessThanOrEqual(213);
    expect(line.endsWith('…')).toBe(true);
  });
});
