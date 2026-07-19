import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NodeRun, VerificationResult, Workspace } from '@mat/shared';
import { nanoid } from 'nanoid';
import { humanizeError } from '../adapters/base.js';
import { spawnManaged } from '../spawn.js';
import { appendEvent } from '../store/eventLog.js';
import { runDirectory } from './worktree.js';

const OUTPUT_TAIL_LIMIT = 2000;

function tail(value: string): string {
  return value.slice(-OUTPUT_TAIL_LIMIT);
}

function emitResult(node: NodeRun, runId: string, result: VerificationResult): void {
  if (result.status === 'skipped' && result.reason === 'no-verify-command') return;
  const seconds = result.durationMs === undefined ? undefined : (result.durationMs / 1000).toFixed(1);
  const kind = result.status === 'passed' || result.status === 'skipped' ? 'status' : 'error';
  const text = result.status === 'passed'
    ? `Verification passed (${result.command}, ${seconds}s)`
    : result.status === 'skipped'
      ? `Verification skipped (${result.reason ?? 'unknown'})`
      : result.status === 'failed'
        ? `Verification failed (exit ${String(result.exitCode)}): ${tail(result.outputTail ?? '').slice(0, 400)}`
        : `Verification failed (exit ${String(result.exitCode ?? null)}): ${(result.outputTail || result.reason || 'unknown error').slice(0, 400)}`;
  appendEvent(runId, {
    runId,
    stageId: node.stageId,
    nodeRunId: node.nodeRunId,
    attempt: node.attempt,
    role: 'system',
    kind,
    text,
    data: { detail: 'verify-result', verification: result },
  });
}

async function writeLog(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}.${nanoid()}.verify.tmp`);
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

export async function verifyCandidate(node: NodeRun, workspace: Workspace, runId: string): Promise<NodeRun['verification']> {
  const command = workspace.verifyCommand?.trim();
  if (!command) return { status: 'skipped', reason: 'no-verify-command' };
  if (node.status !== 'done') {
    const result: VerificationResult = { status: 'skipped', reason: 'node-not-done' };
    emitResult(node, runId, result);
    return result;
  }
  try {
    const patch = node.patchFile ? await readFile(node.patchFile, 'utf8') : '';
    if (!patch.trim()) {
      const result: VerificationResult = { status: 'skipped', reason: 'no-changes' };
      emitResult(node, runId, result);
      return result;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const result: VerificationResult = { status: 'skipped', reason: 'no-changes' };
      emitResult(node, runId, result);
      return result;
    }
    const result: VerificationResult = { status: 'error', reason: humanizeError(error) };
    emitResult(node, runId, result);
    return result;
  }

  appendEvent(runId, {
    runId,
    stageId: node.stageId,
    nodeRunId: node.nodeRunId,
    attempt: node.attempt,
    role: 'system',
    kind: 'status',
    text: `Verification started: ${command}`,
    data: { detail: 'verify-start' },
  });

  const startedAt = Date.now();
  const logFile = join(runDirectory(runId), 'artifacts', `${node.nodeRunId}.a${node.attempt}.verify.log`);
  let output = '';
  let timedOut = false;
  try {
    const managed = spawnManaged({
      command,
      args: [],
      cwd: node.cwd,
      env: process.env,
      shell: true,
      timeoutMs: (workspace.verifyTimeoutSec ?? 600) * 1000,
      onTimeout: () => { timedOut = true; },
    });
    managed.child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    managed.child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const outcome = await new Promise<{ code: number | null; error?: unknown }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error?: unknown }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      managed.child.once('error', (error) => finish({ code: null, error }));
      managed.child.once('close', (code) => finish({ code }));
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    await writeLog(logFile, output);
    const common = { command, exitCode: outcome.code, durationMs, outputTail: tail(output), logFile };
    const result: VerificationResult = timedOut
      ? { status: 'error', ...common, reason: 'timeout' }
      : outcome.error
        ? { status: 'error', ...common, reason: humanizeError(outcome.error) }
        : outcome.code === 0
          ? { status: 'passed', ...common }
          : { status: 'failed', ...common };
    emitResult(node, runId, result);
    return result;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    try { await writeLog(logFile, output); } catch { /* The execution error remains the primary evidence. */ }
    const result: VerificationResult = {
      status: 'error', command, exitCode: null, durationMs, outputTail: tail(output),
      reason: timedOut ? 'timeout' : humanizeError(error), logFile,
    };
    emitResult(node, runId, result);
    return result;
  }
}
