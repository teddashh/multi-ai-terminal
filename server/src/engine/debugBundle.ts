import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { platform, arch } from 'node:process';
import type { AgentEvent, RunSnapshot, Workspace } from '@mat/shared';
import { ZipFile } from 'yazl';
import { VERSION } from '../version.js';
import { serverDiagPath } from '../diag.js';
import { buildRunReport } from './report.js';
import { runDirectory } from './worktree.js';

const TAIL_BYTES = 512 * 1024;

export function readTail(path: string, bytes = TAIL_BYTES): Buffer {
  const content = readFileSync(path);
  return content.subarray(Math.max(0, content.length - bytes));
}

function addDirectory(zip: ZipFile, root: string, archiveRoot: string): number {
  if (!existsSync(root) || !statSync(root).isDirectory()) return 0;
  let count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const child = relative(root, path).split(sep).join('/');
        zip.addFile(path, `${archiveRoot}/${child}`);
        count += 1;
      }
    }
  };
  visit(root);
  return count;
}

export function buildDebugBundle(run: RunSnapshot, workspace: Workspace, events: AgentEvent[]): ZipFile {
  const zip = new ZipFile();
  const root = runDirectory(run.runId);
  const missing: string[] = [];
  zip.addBuffer(Buffer.from(`${JSON.stringify(run, null, 2)}\n`), 'run.json');
  zip.addBuffer(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')), 'events.jsonl');
  const diagPath = join(root, 'diag.jsonl');
  if (existsSync(diagPath)) zip.addFile(diagPath, 'diag.jsonl'); else missing.push('diag.jsonl');
  zip.addBuffer(Buffer.from(buildRunReport(run, workspace, events)), 'report.md');
  if (addDirectory(zip, join(root, 'raw'), 'raw') === 0) missing.push('raw/');
  if (addDirectory(zip, join(root, 'artifacts'), 'artifacts') === 0) missing.push('artifacts/');
  const serverPath = serverDiagPath();
  if (existsSync(serverPath)) zip.addBuffer(readTail(serverPath), 'server-diag.jsonl'); else missing.push('server-diag.jsonl');
  const manifest = {
    bundleVersion: 1,
    generatedAt: Date.now(),
    appVersion: VERSION,
    platform,
    arch,
    nodeVersion: process.version,
    runId: run.runId,
    workspace: {
      name: workspace.name, path: workspace.path, isGit: workspace.isGit,
      ...(workspace.verifyCommand ? { verifyCommand: workspace.verifyCommand } : {}),
      ...(workspace.verifyTimeoutSec ? { verifyTimeoutSec: workspace.verifyTimeoutSec } : {}),
    },
    ...(run.providerVersions ? { providerVersions: run.providerVersions } : {}),
    missing,
  };
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 'manifest.json');
  zip.end();
  return zip;
}
