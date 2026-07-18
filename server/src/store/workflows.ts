import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowDefSchema, type WorkflowDef } from '@mat/shared';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import planningJson from '../../../shared/src/presets/planning.json' with { type: 'json' };
import buildJson from '../../../shared/src/presets/build.json' with { type: 'json' };
import reviewJson from '../../../shared/src/presets/review.json' with { type: 'json' };
import { resolveDataDir } from './dataDir.js';

export class WorkflowStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_DATA', message: string) {
    super(message);
    this.name = 'WorkflowStoreError';
  }
}

const builtinWorkflows = [planningJson, buildJson, reviewJson].map((value) =>
  WorkflowDefSchema.parse({ ...value, builtin: true }) as WorkflowDef,
);
const builtinIds = new Set(builtinWorkflows.map((workflow) => workflow.id));
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
let dataDir: string | undefined;
let mutationQueue: Promise<void> = Promise.resolve();

export function configureWorkflowStore(nextDataDir: string): void {
  dataDir = nextDataDir;
}

export async function listWorkflows(): Promise<WorkflowDef[]> {
  await mutationQueue;
  const custom = await readCustomWorkflows();
  return [...cloneBuiltins(), ...custom];
}

export async function getWorkflow(id: string): Promise<WorkflowDef> {
  const workflow = (await listWorkflows()).find((candidate) => candidate.id === id);
  if (!workflow) throw new WorkflowStoreError('NOT_FOUND', `Workflow not found: ${id}`);
  return workflow;
}

export async function createWorkflow(workflow: WorkflowDef): Promise<WorkflowDef> {
  assertCustomId(workflow.id);
  const parsed = parseCustom({ ...workflow, builtin: undefined });
  await enqueue(async () => {
    if ((await listCustomIds()).has(parsed.id) || builtinIds.has(parsed.id)) {
      throw new WorkflowStoreError('CONFLICT', `Workflow already exists: ${parsed.id}`);
    }
    await atomicWrite(parsed);
  });
  return parsed;
}

export async function updateWorkflow(id: string, workflow: Partial<WorkflowDef>): Promise<WorkflowDef> {
  if (builtinIds.has(id)) throw new WorkflowStoreError('CONFLICT', `Builtin workflow is immutable: ${id}`);
  assertCustomId(id);
  let updated: WorkflowDef | undefined;
  await enqueue(async () => {
    const current = await readCustom(id);
    if (workflow.id !== undefined && workflow.id !== id) {
      throw new WorkflowStoreError('CONFLICT', 'A workflow id cannot be changed');
    }
    updated = parseCustom({ ...current, ...workflow, id, builtin: undefined });
    await atomicWrite(updated);
  });
  return updated!;
}

export async function deleteWorkflow(id: string): Promise<void> {
  if (builtinIds.has(id)) throw new WorkflowStoreError('CONFLICT', `Builtin workflow is immutable: ${id}`);
  assertCustomId(id);
  await enqueue(async () => {
    try {
      await unlink(workflowPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowStoreError('NOT_FOUND', `Workflow not found: ${id}`);
      throw error;
    }
  });
}

export async function duplicateWorkflow(id: string): Promise<WorkflowDef> {
  const source = await getWorkflow(id);
  const ids = new Set((await listWorkflows()).map((workflow) => workflow.id));
  let duplicateId = `${source.id}-copy`;
  let suffix = 2;
  while (ids.has(duplicateId)) duplicateId = `${source.id}-copy-${suffix++}`;
  const { builtin: _builtin, ...custom } = structuredClone(source);
  return createWorkflow({ ...custom, id: duplicateId, name: `${source.name} Copy` });
}

function cloneBuiltins(): WorkflowDef[] {
  return structuredClone(builtinWorkflows);
}

function assertCustomId(id: string): void {
  if (!safeId.test(id)) throw new WorkflowStoreError('INVALID_DATA', 'Workflow id must contain only letters, numbers, dots, underscores, and hyphens');
}

function parseCustom(value: unknown): WorkflowDef {
  try {
    const parsed = WorkflowDefSchema.parse(value) as WorkflowDef;
    if (parsed.builtin !== undefined) {
      const { builtin: _builtin, ...custom } = parsed;
      return custom;
    }
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) throw new WorkflowStoreError('INVALID_DATA', error.issues[0]?.message ?? 'Invalid workflow');
    throw error;
  }
}

function workflowsDir(): string {
  return join(dataDir ?? resolveDataDir(), 'workflows');
}

function workflowPath(id: string): string {
  return join(workflowsDir(), `${id}.json`);
}

async function listCustomIds(): Promise<Set<string>> {
  try {
    return new Set((await readdir(workflowsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

async function readCustomWorkflows(): Promise<WorkflowDef[]> {
  const ids = [...await listCustomIds()].sort();
  return Promise.all(ids.map(readCustom));
}

async function readCustom(id: string): Promise<WorkflowDef> {
  assertCustomId(id);
  try {
    const workflow = parseCustom(JSON.parse(await readFile(workflowPath(id), 'utf8')));
    if (workflow.id !== id) throw new WorkflowStoreError('INVALID_DATA', `Workflow id does not match its filename: ${id}`);
    return workflow;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowStoreError('NOT_FOUND', `Workflow not found: ${id}`);
    if (error instanceof SyntaxError) throw new WorkflowStoreError('INVALID_DATA', `Workflow file is invalid JSON: ${id}`);
    throw error;
  }
}

async function atomicWrite(workflow: WorkflowDef): Promise<void> {
  await mkdir(workflowsDir(), { recursive: true });
  const path = workflowPath(workflow.id);
  const temporary = `${path}.${process.pid}.${nanoid()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(WorkflowDefSchema.parse(workflow), null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function enqueue(operation: () => Promise<void>): Promise<void> {
  const pending = mutationQueue.then(operation);
  mutationQueue = pending.catch(() => undefined);
  return pending;
}
