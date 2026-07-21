import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NodeRun, VerificationResult, Workspace } from '@mat/shared';
import { nanoid } from 'nanoid';
import { humanizeError } from '../adapters/base.js';
import { spawnManaged } from '../spawn.js';
import { appendEvent } from '../store/eventLog.js';
import { runDirectory } from './worktree.js';
import { diag } from '../diag.js';
import { redactEnvironmentValues } from '../redact.js';

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
  }, { trustedData: true });
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
  // Execute the configured command verbatim, but never persist an environment
  // value that may have been interpolated into the command or its output.
  const persistedCommand = redactEnvironmentValues(command);
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
    const result: VerificationResult = { status: 'error', reason: redactEnvironmentValues(humanizeError(error)) };
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
    text: `Verification started: ${persistedCommand}`,
    data: { detail: 'verify-start' },
  }, { trustedData: true });

  const startedAt = Date.now();
  const timeoutSec = workspace.verifyTimeoutSec ?? 600;
  diag(runId, 'verify-start', { nodeRunId: node.nodeRunId, attempt: node.attempt, command: persistedCommand, cwd: node.cwd, timeoutSec });
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
      timeoutMs: timeoutSec * 1000,
      onTimeout: () => { timedOut = true; },
    });
    managed.child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    managed.child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const outcome = await new Promise<{ code: number | null; error?: unknown }>((resolve) => {
      let settled = false;
      let runtimeError: unknown;
      const finish = (value: { code: number | null; error?: unknown }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      managed.child.once('error', (error) => {
        // A post-spawn 'error' (kill failure, spurious emitter noise) must not
        // preempt the real exit code; only a spawn that never started ends here.
        if (managed.child.pid === undefined) finish({ code: null, error });
        else runtimeError = error;
      });
      managed.child.once('close', (code) => finish({ code, error: code === null ? runtimeError : undefined }));
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const persistedOutput = redactEnvironmentValues(output);
    await writeLog(logFile, persistedOutput);
    const common = { command: persistedCommand, exitCode: outcome.code, durationMs, outputTail: tail(persistedOutput), logFile };
    const result: VerificationResult = timedOut
      ? { status: 'error', ...common, reason: 'timeout' }
      : outcome.error
        ? { status: 'error', ...common, reason: redactEnvironmentValues(humanizeError(outcome.error)) }
        : outcome.code === 0
          ? { status: 'passed', ...common }
          : { status: 'failed', ...common };
    emitResult(node, runId, result);
    diag(runId, 'verify-result', {
      nodeRunId: node.nodeRunId, attempt: node.attempt, status: result.status,
      exitCode: result.exitCode, durationMs: result.durationMs, ...(result.reason ? { reason: result.reason } : {}),
    });
    return result;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const persistedOutput = redactEnvironmentValues(output);
    try { await writeLog(logFile, persistedOutput); } catch { /* The execution error remains the primary evidence. */ }
    const result: VerificationResult = {
      status: 'error', command: persistedCommand, exitCode: null, durationMs, outputTail: tail(persistedOutput),
      reason: timedOut ? 'timeout' : redactEnvironmentValues(humanizeError(error)), logFile,
    };
    emitResult(node, runId, result);
    diag(runId, 'verify-result', {
      nodeRunId: node.nodeRunId, attempt: node.attempt, status: result.status,
      exitCode: result.exitCode, durationMs: result.durationMs, reason: result.reason,
    });
    return result;
  }
}
