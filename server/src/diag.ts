import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactDiagnosticValue, redactEnvironmentValues } from './redact.js';
import { getDataDir } from './store/dataDir.js';

const ROTATE_BYTES = 5 * 1024 * 1024;
let reportedFailure = false;

function pathFor(runId: string | null): string {
  return runId === null ? join(getDataDir(), 'logs', 'server-diag.jsonl') : join(getDataDir(), 'runs', runId, 'diag.jsonl');
}

export function diag(runId: string | null, cat: string, data: Record<string, unknown>): void {
  try {
    const path = pathFor(runId);
    mkdirSync(dirname(path), { recursive: true });
    if (runId === null && existsSync(path) && statSync(path).size >= ROTATE_BYTES) {
      if (existsSync(`${path}.1`)) unlinkSync(`${path}.1`);
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), cat, ...data }, redactDiagnosticValue)}\n`, 'utf8');
  } catch (error) {
    if (reportedFailure) return;
    reportedFailure = true;
    console.error(`[mat] diagnostic journal write failed: ${redactEnvironmentValues(error instanceof Error ? (error.stack ?? error.message) : String(error))}`);
  }
}

export const serverDiagPath = (): string => pathFor(null);
