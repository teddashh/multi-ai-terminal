import type { AdapterContentEvent } from '@mat/shared';
import { spawnManaged } from '../spawn.js';
import { getDataDir } from '../store/dataDir.js';
import { resolveRuntimeBinary, runtimeBinaryForSpawn } from '../runtime/resolve.js';
import { claudeSessionRuntime } from '../providers/claude/runtime.js';
import {
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
  if (permission === 'full') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', permission === 'safe' ? 'plan' : 'acceptEdits'];
};

export function buildClaudeArgs(spec: ResolvedNodeSpec): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (spec.binding.model) args.push('--model', spec.binding.model);
  args.push(...permissionArgs(spec.binding.permission));
  if (spec.binding.maxTurns !== undefined) args.push('--max-turns', String(spec.binding.maxTurns));
  if (spec.binding.systemPromptAppend) args.push('--append-system-prompt', spec.binding.systemPromptAppend);
  if (spec.resumeSessionRef) args.push('--resume', spec.resumeSessionRef);
  return args;
}

const stringField = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === 'string' ? record[key] : undefined;

function spawnClaudeCommand(command: string, spec: ResolvedNodeSpec, io: Parameters<Adapter['spawn']>[1]): SpawnedNode {
  const managed = spawnManaged({ command, args: buildClaudeArgs(spec), cwd: spec.cwd, stdin: spec.promptText });
  const { child } = managed;
  let sessionRef: string | undefined;
  let usage: NodeOutcome['usage'];
  let terminalResult: string | undefined;
  let accumulatedText = '';
  let reportedError: string | undefined;
  const toolNames = new Map<string, string>();

  const handleRecord = (record: Record<string, unknown>): void => {
    const type = stringField(record, 'type');
    if (type === 'system' && record.subtype === 'init') {
      sessionRef = stringField(record, 'session_id');
      return;
    }
    if (type === 'assistant') {
      const message = record.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) return;
      for (const rawItem of content) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as Record<string, unknown>;
        const itemType = stringField(item, 'type');
        if (itemType === 'text') {
          const text = stringField(item, 'text') ?? '';
          accumulatedText += text;
          io.onEvent({ role: 'agent', kind: 'message', text });
        } else if (itemType === 'thinking') {
          const text = stringField(item, 'thinking') ?? '';
          io.onEvent({ role: 'thinking', kind: 'thinking', text });
        } else if (itemType === 'tool_use') {
          const id = stringField(item, 'id');
          const name = stringField(item, 'name') ?? 'tool';
          if (id) toolNames.set(id, name);
          const input = stringifyToolValue(item.input);
          io.onEvent({
            role: 'tool', kind: 'tool_use', text: name,
            tool: { ...(id ? { toolCallId: id } : {}), name, input },
          });
        }
      }
      return;
    }
    if (type === 'user') {
      const message = record.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) return;
      for (const rawItem of content) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as Record<string, unknown>;
        if (item.type !== 'tool_result') continue;
        const id = stringField(item, 'tool_use_id');
        const output = stringifyToolValue(item.content);
        const name = (id && toolNames.get(id)) ?? 'tool';
        io.onEvent({
          role: 'tool', kind: 'tool_result', text: output,
          tool: {
            ...(id ? { toolCallId: id } : {}), name, output,
            ...(typeof item.is_error === 'boolean' ? { isError: item.is_error } : {}),
          },
        });
      }
      return;
    }
    if (type === 'result') {
      terminalResult = stringField(record, 'result');
      sessionRef = stringField(record, 'session_id') ?? sessionRef;
      const rawUsage = record.usage;
      const usageRecord = rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
        ? rawUsage as Record<string, unknown>
        : undefined;
      usage = {
        ...(typeof usageRecord?.input_tokens === 'number' ? { inputTokens: usageRecord.input_tokens } : {}),
        ...(typeof usageRecord?.output_tokens === 'number' ? { outputTokens: usageRecord.output_tokens } : {}),
        ...(typeof record.total_cost_usd === 'number' ? { costUsd: record.total_cost_usd } : {}),
      };
      if (record.is_error === true) reportedError = terminalResult ?? 'Claude reported an error';
    }
  };

  const stdout = createLineBuffer((line) => {
    io.onRaw(line, 'out');
    const record = parseJsonObject(line);
    if (record) handleRecord(record);
  });
  const stderr = createLineBuffer((line) => io.onRaw(line, 'err'));
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  const completion = new Promise<NodeOutcome>((resolve) => {
    let spawnError: string | undefined;
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (code, signal) => {
      stdout.end();
      stderr.end();
      resolve({
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(sessionRef ? { sessionRef } : {}),
        ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
        ...((terminalResult ?? accumulatedText) ? { resultText: terminalResult ?? accumulatedText } : {}),
        ...((spawnError ?? reportedError ?? (code && `Claude exited ${code}`))
          ? { error: spawnError ?? reportedError ?? `Claude exited ${code}` }
          : {}),
      });
    });
  });

  return { pid: child.pid ?? -1, kill: managed.killGroup, completion };
}

export function spawnClaude(spec: ResolvedNodeSpec, io: Parameters<Adapter['spawn']>[1]): SpawnedNode {
  if (claudeRuntimeMode() === 'sdk') return claudeSessionRuntime().startRun(spec, io);
  return spawnClaudeCommand(spec.runtimeCommand ?? runtimeBinaryForSpawn(getDataDir(), 'claude'), spec, io);
}

export function claudeRuntimeMode(env = process.env): 'sdk' | 'cli' {
  return env.MAT_CLAUDE_RUNTIME === 'cli' ? 'cli' : 'sdk';
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  tier: 'rich',
  models: ['sonnet', 'opus', 'haiku'],
  defaultModel: 'sonnet',
  available: async () => { const command = await resolveRuntimeBinary(getDataDir(), 'claude'); return command ? probeVersion(command) : { ok: false }; },
  spawn: spawnClaude,
};

export default claudeAdapter;
