import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { platform, arch } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { AgentEvent, RunSnapshot, Workspace } from '@mat/shared';
import { ZipFile } from 'yazl';
import { VERSION } from '../version.js';
import { serverDiagPath } from '../diag.js';
import { environmentRedactionTokens, redactDiagnosticValue, redactEnvironmentValues, redactJsonValue } from '../redact.js';
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
        addRedactedFile(zip, path, `${archiveRoot}/${child}`);
        count += 1;
      }
    }
  };
  visit(root);
  return count;
}

function redactedBuffer(value: Buffer | string): Buffer {
  return Buffer.from(redactEnvironmentValues(Buffer.isBuffer(value) ? value.toString('utf8') : value));
}

function redactedJsonLines(value: Buffer): Buffer {
  const lines = value.toString('utf8').split('\n');
  const redacted = lines.map((line) => {
    if (!line) return '';
    try { return JSON.stringify(JSON.parse(line), redactDiagnosticValue); }
    catch { return redactEnvironmentValues(line); }
  });
  return Buffer.from(redacted.join('\n'));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redacts literal env values without materializing a complete artifact. */
class EnvironmentRedactionTransform extends Transform {
  readonly #decoder = new StringDecoder('utf8');
  readonly #tokens = environmentRedactionTokens();
  readonly #pattern = this.#tokens.length > 0 ? new RegExp(this.#tokens.map(escapeRegExp).join('|'), 'g') : undefined;
  readonly #maxTokenLength = this.#tokens[0]?.length ?? 0;
  #pending = '';

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#pending += this.#decoder.write(chunk);
    this.#flushSafePrefix();
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.#pending += this.#decoder.end();
    this.push(this.#replace(this.#pending));
    this.#pending = '';
    callback();
  }

  #replace(value: string): string {
    if (!this.#pattern) return value;
    this.#pattern.lastIndex = 0;
    return value.replace(this.#pattern, '[REDACTED_ENV]');
  }

  #flushSafePrefix(): void {
    if (!this.#pattern || this.#maxTokenLength === 0) {
      this.push(this.#pending);
      this.#pending = '';
      return;
    }
    const cutoff = this.#pending.length - this.#maxTokenLength + 1;
    if (cutoff <= 0) return;
    this.#pattern.lastIndex = 0;
    let cursor = 0;
    let carryFrom = cutoff;
    let output = '';
    for (let match = this.#pattern.exec(this.#pending); match; match = this.#pattern.exec(this.#pending)) {
      const end = match.index + match[0].length;
      if (end > cutoff) {
        carryFrom = Math.min(carryFrom, match.index);
        break;
      }
      output += `${this.#pending.slice(cursor, match.index)}[REDACTED_ENV]`;
      cursor = end;
    }
    output += this.#pending.slice(cursor, carryFrom);
    if (output) this.push(output);
    this.#pending = this.#pending.slice(carryFrom);
  }
}

export function createRedactedFileStream(path: string): Transform {
  const source = createReadStream(path);
  const transform = new EnvironmentRedactionTransform();
  source.once('error', (error) => transform.destroy(error));
  source.pipe(transform);
  return transform;
}

function addRedactedFile(zip: ZipFile, path: string, archivePath: string): void {
  zip.addReadStreamLazy(archivePath, (callback) => {
    const stream = createRedactedFileStream(path);
    stream.once('error', (error) => zip.emit('error', error));
    callback(null, stream);
  });
}

function redactedBinding(binding: RunSnapshot['nodes'][number]['agent']): RunSnapshot['nodes'][number]['agent'] {
  return {
    ...binding,
    ...(binding.model !== undefined ? { model: redactEnvironmentValues(binding.model) } : {}),
    ...(binding.systemPromptAppend !== undefined ? { systemPromptAppend: redactEnvironmentValues(binding.systemPromptAppend) } : {}),
  };
}

function redactedRunSnapshot(run: RunSnapshot): RunSnapshot {
  return {
    ...run,
    ...(run.workspaceSnapshot ? { workspaceSnapshot: {
      ...run.workspaceSnapshot,
      name: redactEnvironmentValues(run.workspaceSnapshot.name),
      path: redactEnvironmentValues(run.workspaceSnapshot.path),
      ...(run.workspaceSnapshot.verifyCommand !== undefined ? { verifyCommand: redactEnvironmentValues(run.workspaceSnapshot.verifyCommand) } : {}),
    } } : {}),
    workflow: {
      ...run.workflow,
      name: redactEnvironmentValues(run.workflow.name),
      description: redactEnvironmentValues(run.workflow.description),
      orchestrator: { ...run.workflow.orchestrator, agent: redactedBinding(run.workflow.orchestrator.agent) },
      stages: run.workflow.stages.map((stage) => ({
        ...stage,
        name: redactEnvironmentValues(stage.name),
        slots: stage.slots.map((slot) => ({
          ...slot,
          label: redactEnvironmentValues(slot.label),
          promptTemplate: redactEnvironmentValues(slot.promptTemplate),
          agent: redactedBinding(slot.agent),
        })),
      })),
    },
    task: redactEnvironmentValues(run.task),
    nodes: run.nodes.map((node) => ({
      ...node,
      agent: redactedBinding(node.agent),
      label: redactEnvironmentValues(node.label),
      cwd: redactEnvironmentValues(node.cwd),
      ...(node.sessionRef !== undefined ? { sessionRef: redactEnvironmentValues(node.sessionRef) } : {}),
      ...(node.resultText !== undefined ? { resultText: redactEnvironmentValues(node.resultText) } : {}),
      ...(node.error !== undefined ? { error: redactEnvironmentValues(node.error) } : {}),
      ...(node.errorReason !== undefined ? { errorReason: redactEnvironmentValues(node.errorReason) } : {}),
      ...(node.patchFile !== undefined ? { patchFile: redactEnvironmentValues(node.patchFile) } : {}),
      ...(node.baseCommit !== undefined ? { baseCommit: redactEnvironmentValues(node.baseCommit) } : {}),
      ...(node.verification ? { verification: {
        ...node.verification,
        ...(node.verification.command !== undefined ? { command: redactEnvironmentValues(node.verification.command) } : {}),
        ...(node.verification.outputTail !== undefined ? { outputTail: redactEnvironmentValues(node.verification.outputTail) } : {}),
        ...(node.verification.reason !== undefined ? { reason: redactEnvironmentValues(node.verification.reason) } : {}),
        ...(node.verification.logFile !== undefined ? { logFile: redactEnvironmentValues(node.verification.logFile) } : {}),
      } } : {}),
    })),
    gateDecisions: run.gateDecisions.map((decision) => ({
      ...decision,
      ...(decision.promptAddendum !== undefined ? { promptAddendum: redactEnvironmentValues(decision.promptAddendum) } : {}),
      ...(decision.contextForNext !== undefined ? { contextForNext: redactEnvironmentValues(decision.contextForNext) } : {}),
      rationale: redactEnvironmentValues(decision.rationale),
      ...(decision.raw !== undefined ? { raw: redactEnvironmentValues(decision.raw) } : {}),
    })),
    ...(run.steers ? { steers: run.steers.map((steer) => ({ ...steer, text: redactEnvironmentValues(steer.text) })) } : {}),
    ...(run.providerVersions ? { providerVersions: Object.fromEntries(Object.entries(run.providerVersions).map(([provider, version]) => [provider, redactEnvironmentValues(version)])) } : {}),
  };
}

function redactedEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    text: redactEnvironmentValues(event.text),
    ...(event.tool ? { tool: {
      ...event.tool,
      name: redactEnvironmentValues(event.tool.name),
      ...(event.tool.toolCallId !== undefined ? { toolCallId: redactEnvironmentValues(event.tool.toolCallId) } : {}),
      ...(event.tool.input !== undefined ? { input: redactEnvironmentValues(event.tool.input) } : {}),
      ...(event.tool.output !== undefined ? { output: redactEnvironmentValues(event.tool.output) } : {}),
    } } : {}),
    ...(event.data ? { data: redactJsonValue(event.data) } : {}),
  };
}

export function buildDebugBundle(run: RunSnapshot, workspace: Workspace, events: AgentEvent[]): ZipFile {
  const zip = new ZipFile();
  zip.on('error', (error) => (zip.outputStream as Readable).destroy(error));
  const root = runDirectory(run.runId);
  const missing: string[] = [];
  zip.addBuffer(Buffer.from(`${JSON.stringify(redactedRunSnapshot(run), null, 2)}\n`), 'run.json');
  zip.addBuffer(Buffer.from(events.map((event) => JSON.stringify(redactedEvent(event))).join('\n') + (events.length ? '\n' : '')), 'events.jsonl');
  const diagPath = join(root, 'diag.jsonl');
  if (existsSync(diagPath)) addRedactedFile(zip, diagPath, 'diag.jsonl'); else missing.push('diag.jsonl');
  zip.addBuffer(redactedBuffer(buildRunReport(run, workspace, events)), 'report.md');
  if (addDirectory(zip, join(root, 'raw'), 'raw') === 0) missing.push('raw/');
  if (addDirectory(zip, join(root, 'artifacts'), 'artifacts') === 0) missing.push('artifacts/');
  const serverPath = serverDiagPath();
  if (existsSync(serverPath)) zip.addBuffer(redactedJsonLines(readTail(serverPath)), 'server-diag.jsonl'); else missing.push('server-diag.jsonl');
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
  const safeManifest = {
    ...manifest,
    workspace: {
      ...manifest.workspace,
      name: redactEnvironmentValues(manifest.workspace.name),
      path: redactEnvironmentValues(manifest.workspace.path),
      ...(manifest.workspace.verifyCommand !== undefined ? { verifyCommand: redactEnvironmentValues(manifest.workspace.verifyCommand) } : {}),
    },
    ...(run.providerVersions ? { providerVersions: Object.fromEntries(Object.entries(run.providerVersions).map(([provider, version]) => [provider, redactEnvironmentValues(version)])) } : {}),
  };
  zip.addBuffer(Buffer.from(`${JSON.stringify(safeManifest, null, 2)}\n`), 'manifest.json');
  zip.end();
  return zip;
}
