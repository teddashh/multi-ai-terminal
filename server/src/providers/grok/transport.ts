import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnManaged } from '../../spawn.js';
import {
  ContentCoalescer,
  createLineBuffer,
  parseJsonObject,
  stringifyToolValue,
  type Adapter,
  type NodeOutcome,
  type ResolvedNodeSpec,
  type SpawnedNode,
} from '../../adapters/base.js';

const permissionArgs = (permission: ResolvedNodeSpec['binding']['permission']): string[] => {
  if (permission === 'safe') return ['--permission-mode', 'plan'];
  if (permission === 'full') return ['--permission-mode', 'bypassPermissions'];
  return ['--permission-mode', 'acceptEdits'];
};

export function buildGrokArgs(spec: ResolvedNodeSpec, promptFile: string): string[] {
  const args = [
    ...(spec.resumeSessionRef ? ['-r', spec.resumeSessionRef] : []),
    // grok >= 0.2.93: `-p/--single` demands an inline prompt value; --prompt-file alone selects headless mode.
    '--prompt-file', promptFile,
    '--output-format', 'streaming-json',
    '-m', spec.binding.model ?? 'grok-4.5',
  ];
  if (spec.binding.effort) args.push('--reasoning-effort', spec.binding.effort);
  args.push('--cwd', spec.cwd, ...permissionArgs(spec.binding.permission));
  if (spec.binding.maxTurns !== undefined) args.push('--max-turns', String(spec.binding.maxTurns));
  if (spec.binding.systemPromptAppend) args.push('--rules', spec.binding.systemPromptAppend);
  return args;
}

const removePromptDir = (promptDir: string): string | undefined => {
  try {
    rmSync(promptDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

export function spawnGrokTransport(spec: ResolvedNodeSpec, io: Parameters<Adapter['spawn']>[1]): SpawnedNode {
  const promptDir = mkdtempSync(join(tmpdir(), 'mat-grok-'));
  const promptFile = join(promptDir, 'prompt.txt');

  let managed: ReturnType<typeof spawnManaged>;
  try {
    writeFileSync(promptFile, spec.promptText, { encoding: 'utf8', mode: 0o600 });
    managed = spawnManaged({
      command: spec.runtimeCommand ?? 'grok',
      args: buildGrokArgs(spec, promptFile),
      cwd: spec.cwd,
    });
  } catch (error) {
    removePromptDir(promptDir);
    throw error;
  }

  const { child } = managed;
  let sessionRef: string | undefined;
  let resultText = '';
  let reportedError: string | undefined;
  const coalescer = new ContentCoalescer(io.onEvent);

  const handleRecord = (record: Record<string, unknown>): void => {
    const type = typeof record.type === 'string' ? record.type : 'unknown';
    if (type === 'thought') {
      coalescer.push('thinking', 'thinking', typeof record.data === 'string' ? record.data : '');
      return;
    }
    if (type === 'text') {
      const text = typeof record.data === 'string' ? record.data : '';
      resultText += text;
      coalescer.push('agent', 'message', text);
      return;
    }
    if (type === 'end') {
      coalescer.flush();
      if (typeof record.sessionId === 'string') sessionRef = record.sessionId;
      return;
    }

    coalescer.flush();
    io.onEvent({
      role: 'tool',
      kind: 'tool_use',
      text: type,
      tool: { name: type, input: stringifyToolValue(record) },
    });
  };

  const stdout = createLineBuffer((line) => {
    io.onRaw(line, 'out');
    const record = parseJsonObject(line);
    if (record) handleRecord(record);
  });
  const stderrTail: string[] = [];
  const stderr = createLineBuffer((line) => {
    io.onRaw(line, 'err');
    stderrTail.push(line);
    while (Buffer.byteLength(stderrTail.join('\n')) > 4096 && stderrTail.length > 1) stderrTail.shift();
  });
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  const completion = new Promise<NodeOutcome>((resolve) => {
    child.once('error', (error) => { reportedError = error.message; });
    child.once('close', (code, signal) => {
      stdout.end();
      stderr.end();
      coalescer.end();
      const cleanupError = removePromptDir(promptDir);
      const exitError = code ? stderrTail.join('\n') || `Grok exited ${code}` : undefined;
      const error = reportedError ?? exitError ?? cleanupError;
      resolve({
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(sessionRef ? { sessionRef } : {}),
        ...(resultText ? { resultText } : {}),
        ...(error ? { error } : {}),
      });
    });
  });

  return { pid: child.pid ?? -1, kill: managed.killGroup, completion };
}
