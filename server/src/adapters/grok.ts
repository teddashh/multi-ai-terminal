import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnManaged } from '../spawn.js';
import {
  ContentCoalescer,
  createLineBuffer,
  parseJsonObject,
  probeVersion,
  stringifyToolValue,
  type Adapter,
  type NodeOutcome,
  type ResolvedNodeSpec,
  type SpawnedNode,
} from './base.js';

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

export function spawnGrok(spec: ResolvedNodeSpec, io: Parameters<Adapter['spawn']>[1]): SpawnedNode {
  const promptDir = mkdtempSync(join(tmpdir(), 'mat-grok-'));
  const promptFile = join(promptDir, 'prompt.txt');
  writeFileSync(promptFile, spec.promptText, { encoding: 'utf8', mode: 0o600 });

  let managed: ReturnType<typeof spawnManaged>;
  try {
    managed = spawnManaged({ command: 'grok', args: buildGrokArgs(spec, promptFile), cwd: spec.cwd });
  } catch (error) {
    rmSync(promptDir, { recursive: true, force: true });
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
      role: 'tool', kind: 'tool_use', text: type,
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
      rmSync(promptDir, { recursive: true, force: true });
      const error = reportedError ?? (code ? stderrTail.join('\n') || `Grok exited ${code}` : undefined);
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

export const grokAdapter: Adapter = {
  id: 'grok',
  tier: 'rich',
  models: ['grok-4.5'],
  defaultModel: 'grok-4.5',
  available: () => probeVersion('grok'),
  spawn: spawnGrok,
};

export default grokAdapter;
