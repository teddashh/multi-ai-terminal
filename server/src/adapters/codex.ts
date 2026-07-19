import { spawnManaged } from '../spawn.js';
import {
  createLineBuffer,
  humanizeError,
  parseJsonObject,
  probeVersion,
  stringifyToolValue,
  type Adapter,
  type NodeOutcome,
  type ResolvedNodeSpec,
  type SpawnedNode,
} from './base.js';

const sandboxMode = (permission: ResolvedNodeSpec['binding']['permission']): string => {
  if (permission === 'safe') return 'read-only';
  if (permission === 'full') return 'danger-full-access';
  return 'workspace-write';
};

export function buildCodexArgs(spec: ResolvedNodeSpec): string[] {
  const model = spec.binding.model ?? 'gpt-5.6-sol';
  const common = [
    '--json', '-m', model,
    ...(spec.binding.effort ? ['-c', `model_reasoning_effort=${spec.binding.effort}`] : []),
    '--cd', spec.cwd,
    '--sandbox', sandboxMode(spec.binding.permission),
    '--skip-git-repo-check',
  ];

  if (spec.resumeSessionRef) {
    // codex-cli 0.144's resume subcommand help omits --cd/--sandbox. Supplying those
    // parent options before `resume` preserves the complete, explicit configuration.
    return ['exec', ...common, 'resume', spec.resumeSessionRef, '-'];
  }
  return ['exec', ...common, '-'];
}

const stringField = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === 'string' ? record[key] : undefined;

const itemText = (item: Record<string, unknown>): string => {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.summary === 'string') return item.summary;
  if (Array.isArray(item.summary)) return item.summary.filter((part): part is string => typeof part === 'string').join('');
  if (typeof item.aggregated_output === 'string') return item.aggregated_output;
  return '';
};

export function spawnCodex(spec: ResolvedNodeSpec, io: Parameters<Adapter['spawn']>[1]): SpawnedNode {
  const managed = spawnManaged({ command: 'codex', args: buildCodexArgs(spec), cwd: spec.cwd, stdin: spec.promptText });
  const { child } = managed;
  let sessionRef: string | undefined;
  let usage: NodeOutcome['usage'];
  let resultText = '';
  let reportedError: string | undefined;

  const handleItem = (eventType: string, item: Record<string, unknown>): void => {
    const itemType = stringField(item, 'type') ?? 'unknown';
    const id = stringField(item, 'id');
    if (itemType === 'command_execution') {
      const command = stringField(item, 'command') ?? '';
      if (eventType === 'item.started') {
        io.onEvent({
          role: 'tool', kind: 'tool_use', text: command,
          tool: { ...(id ? { toolCallId: id } : {}), name: 'shell', input: stringifyToolValue(command) },
        });
      } else if (eventType === 'item.completed') {
        const output = stringField(item, 'aggregated_output') ?? '';
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        io.onEvent({
          role: 'tool', kind: 'tool_result', text: output,
          tool: {
            ...(id ? { toolCallId: id } : {}), name: 'shell', output: stringifyToolValue(output),
            ...(exitCode !== undefined ? { isError: exitCode !== 0 } : {}),
          },
        });
      }
      return;
    }
    if (itemType === 'agent_message') {
      if (eventType !== 'item.completed') return;
      const text = itemText(item);
      resultText = text;
      io.onEvent({ role: 'agent', kind: 'message', text });
      return;
    }
    if (itemType === 'reasoning') {
      if (eventType !== 'item.completed') return;
      const text = itemText(item);
      if (text) io.onEvent({ role: 'thinking', kind: 'thinking', text });
      return;
    }

    const serialized = stringifyToolValue(item);
    if (eventType === 'item.started') {
      io.onEvent({
        role: 'tool', kind: 'tool_use', text: itemType,
        tool: { ...(id ? { toolCallId: id } : {}), name: itemType, input: serialized },
      });
    } else if (eventType === 'item.completed') {
      io.onEvent({
        role: 'tool', kind: 'tool_result', text: itemType,
        tool: { ...(id ? { toolCallId: id } : {}), name: itemType, output: serialized },
      });
    }
  };

  const handleRecord = (record: Record<string, unknown>): void => {
    const type = stringField(record, 'type');
    if (type === 'thread.started') {
      sessionRef = stringField(record, 'thread_id');
      return;
    }
    if (type === 'item.started' || type === 'item.completed') {
      const rawItem = record.item;
      if (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)) {
        handleItem(type, rawItem as Record<string, unknown>);
      }
      return;
    }
    if (type === 'turn.completed') {
      const rawUsage = record.usage;
      if (rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)) {
        const value = rawUsage as Record<string, unknown>;
        usage = {
          ...(typeof value.input_tokens === 'number' ? { inputTokens: value.input_tokens } : {}),
          ...(typeof value.output_tokens === 'number' ? { outputTokens: value.output_tokens } : {}),
        };
      }
      return;
    }
    if (type === 'turn.failed' || type === 'error') {
      reportedError = humanizeError(
        stringField(record, 'message') ?? (record.error === undefined ? `${type}` : record.error),
        'codex',
      );
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
      const error = spawnError ? humanizeError(spawnError, 'codex') : (reportedError ?? (code ? humanizeError(`Codex exited ${code}`, 'codex') : undefined));
      resolve({
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(sessionRef ? { sessionRef } : {}),
        ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
        ...(resultText ? { resultText } : {}),
        ...(error ? { error } : {}),
      });
    });
  });

  return { pid: child.pid ?? -1, kill: managed.killGroup, completion };
}

export const codexAdapter: Adapter = {
  id: 'codex',
  tier: 'rich',
  models: ['gpt-5.6-sol'],
  defaultModel: 'gpt-5.6-sol',
  available: () => probeVersion('codex'),
  spawn: spawnCodex,
};

export default codexAdapter;
