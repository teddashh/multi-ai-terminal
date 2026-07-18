import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { RunSnapshotSchema, type RunSnapshot } from '@mat/shared';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { resolveDataDir } from './dataDir.js';
import { updateWorkspaceLastRun } from './workspaces.js';

const TERMINAL_RUN_STATUSES = new Set<RunSnapshot['status']>(['done', 'failed', 'aborted']);
const safeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type RunSubscriber = (run: RunSnapshot) => void;
export type RunCleanup = (runId: string, run: RunSnapshot) => Promise<void>;

export class RunStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_DATA', message: string) {
    super(message);
    this.name = 'RunStoreError';
  }
}

let dataDir: string | undefined;
let cleanupRun: RunCleanup | undefined;
let mutationQueue: Promise<void> = Promise.resolve();
const subscribers = new Set<RunSubscriber>();

export function configureRunStore(nextDataDir: string, options: { cleanupRun?: RunCleanup } = {}): void {
  dataDir = nextDataDir;
  cleanupRun = options.cleanupRun;
}

export function getRunStoreDataDir(): string {
  return dataDir ?? resolveDataDir();
}

export function subscribeRunChanges(subscriber: RunSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export async function saveRun(run: RunSnapshot): Promise<void> {
  const parsed = parseRun(run);
  assertRunId(parsed.runId);
  await enqueue(async () => {
    await atomicWrite(parsed);
    await pruneWorkspaceRuns(parsed.workspaceId);
  });
  await updateWorkspaceLastRun(parsed.workspaceId, {
    runId: parsed.runId,
    workflowName: parsed.workflow.name,
    status: parsed.status,
    at: parsed.endedAt ?? parsed.createdAt,
  });
  for (const subscriber of [...subscribers]) {
    try { subscriber(structuredClone(parsed)); } catch { /* A listener cannot invalidate a durable run save. */ }
  }
}

export async function getRun(runId: string): Promise<RunSnapshot> {
  assertRunId(runId);
  await mutationQueue;
  try {
    return parseRun(JSON.parse(await readFile(runPath(runId), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunStoreError('NOT_FOUND', `Run not found: ${runId}`);
    if (error instanceof SyntaxError) throw new RunStoreError('INVALID_DATA', `Run snapshot is invalid JSON: ${runId}`);
    throw error;
  }
}

export async function listRuns(workspaceId?: string, limit = 50, before?: number): Promise<RunSnapshot[]> {
  await mutationQueue;
  if (!Number.isInteger(limit) || limit < 1) throw new RunStoreError('INVALID_DATA', 'limit must be a positive integer');
  const entries = await listRunIds();
  const snapshots = (await Promise.all(entries.map(async (runId) => {
    try { return await readRunDirect(runId); } catch (error) {
      if (error instanceof RunStoreError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }))).filter((run): run is RunSnapshot => run !== undefined);
  return snapshots
    .filter((run) => workspaceId === undefined || run.workspaceId === workspaceId)
    .filter((run) => before === undefined || run.createdAt < before)
    .sort((left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId))
    .slice(0, limit);
}

export async function readRunPatch(runId: string, nodeRunId: string): Promise<string> {
  assertRunId(runId);
  const run = await getRun(runId);
  const node = run.nodes.find((candidate) => candidate.nodeRunId === nodeRunId);
  if (!node) throw new RunStoreError('NOT_FOUND', `Node not found: ${nodeRunId}`);
  const fallback = join('artifacts', `${node.nodeRunId}.a${node.attempt}.patch`);
  const selected = node.patchFile ?? fallback;
  const runRoot = resolve(runsDir(), runId);
  const path = isAbsolute(selected) ? resolve(selected) : resolve(runRoot, selected);
  const rel = relative(runRoot, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new RunStoreError('INVALID_DATA', 'Patch path escapes the run directory');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunStoreError('NOT_FOUND', `Patch not found for node: ${nodeRunId}`);
    throw error;
  }
}

export async function deleteRun(runId: string): Promise<void> {
  assertRunId(runId);
  await enqueue(async () => {
    const run = await readRunDirect(runId);
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new RunStoreError('CONFLICT', `Run ${runId} is not terminal; abort it before deleting`);
    }
    await cleanupAndRemove(runId, run);
  });
}

async function pruneWorkspaceRuns(workspaceId: string): Promise<void> {
  const runs = await listRunsDirect(workspaceId);
  let excess = runs.length - 100;
  if (excess <= 0) return;
  for (const run of [...runs].reverse()) {
    if (excess <= 0) break;
    if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
    await cleanupAndRemove(run.runId, run);
    excess -= 1;
  }
}

async function cleanupAndRemove(runId: string, run: RunSnapshot): Promise<void> {
  if (cleanupRun) await cleanupRun(runId, run);
  await rm(join(runsDir(), runId), { recursive: true, force: true });
}

async function listRunsDirect(workspaceId: string): Promise<RunSnapshot[]> {
  const entries = await listRunIds();
  const runs = (await Promise.all(entries.map(async (id) => {
    try { return await readRunDirect(id); } catch (error) {
      if (error instanceof RunStoreError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }))).filter((run): run is RunSnapshot => run !== undefined && run.workspaceId === workspaceId);
  return runs.sort((left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId));
}

async function listRunIds(): Promise<string[]> {
  try {
    return (await readdir(runsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeRunId.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readRunDirect(runId: string): Promise<RunSnapshot> {
  try {
    return parseRun(JSON.parse(await readFile(runPath(runId), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunStoreError('NOT_FOUND', `Run not found: ${runId}`);
    if (error instanceof SyntaxError) throw new RunStoreError('INVALID_DATA', `Run snapshot is invalid JSON: ${runId}`);
    throw error;
  }
}

function parseRun(value: unknown): RunSnapshot {
  try { return RunSnapshotSchema.parse(value) as RunSnapshot; }
  catch (error) {
    if (error instanceof z.ZodError) throw new RunStoreError('INVALID_DATA', error.issues[0]?.message ?? 'Invalid run snapshot');
    throw error;
  }
}

function assertRunId(runId: string): void {
  if (!safeRunId.test(runId)) throw new RunStoreError('INVALID_DATA', 'Run id must contain only letters, numbers, dots, underscores, and hyphens');
}

function runsDir(): string {
  return join(getRunStoreDataDir(), 'runs');
}

function runPath(runId: string): string {
  return join(runsDir(), runId, 'run.json');
}

async function atomicWrite(run: RunSnapshot): Promise<void> {
  const path = runPath(run.runId);
  await mkdir(join(runsDir(), run.runId), { recursive: true });
  const temporary = `${path}.${process.pid}.${nanoid()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(RunSnapshotSchema.parse(run), null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function enqueue(operation: () => Promise<void>): Promise<void> {
  const pending = mutationQueue.then(operation);
  mutationQueue = pending.catch(() => undefined);
  return pending;
}
