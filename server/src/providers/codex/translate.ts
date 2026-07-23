import type { AdapterContentEvent, Usage } from '@mat/shared';
import { stringifyToolValue, truncateText } from '../../adapters/base.js';

type RecordValue = Record<string, unknown>;
export type CodexCommandOutputs = Map<string, string>;
export interface ParsedTokenUsage { total?: Usage & { cacheReadTokens?: number }; last?: Usage & { cacheReadTokens?: number }; contextWindow?: number }

const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const usageNumber = (value: unknown): number | undefined => {
  const parsed = number(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
};
const first = (value: RecordValue, keys: readonly string[]): unknown => keys.find((key) => value[key] !== undefined) ? value[keys.find((key) => value[key] !== undefined)!] : undefined;
export const stripAnsi = (value: string): string => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');

function usage(section: unknown): (Usage & { cacheReadTokens?: number }) | undefined {
  const value = record(section);
  if (!value) return undefined;
  const inputTokens = usageNumber(first(value, ['inputTokens', 'input_tokens', 'input']));
  const outputTokens = usageNumber(first(value, ['outputTokens', 'output_tokens', 'output']));
  const cacheReadTokens = usageNumber(first(value, ['cacheReadTokens', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_tokens']));
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}) };
}

export function parseTokenUsage(params: unknown): ParsedTokenUsage {
  const root = record(params) ?? {};
  const container = record(first(root, ['tokenUsage', 'token_usage', 'usage'])) ?? root;
  const cumulative = first(container, ['total', 'cumulative', 'totalTokenUsage', 'total_token_usage']) ?? container;
  const last = first(container, ['last', 'lastTokenUsage', 'last_token_usage']) ?? cumulative;
  const contextWindow = number(first(container, ['modelContextWindow', 'model_context_window'])) ?? number(first(root, ['modelContextWindow', 'model_context_window']));
  const totalUsage = usage(cumulative);
  const lastUsage = usage(last);
  return { ...(totalUsage ? { total: totalUsage } : {}), ...(lastUsage ? { last: lastUsage } : {}), ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}) };
}

function itemOf(params: RecordValue): RecordValue | undefined { return record(params.item) ?? record(record(params.params)?.item); }
function completedItemText(item: RecordValue, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.length > 0) return value;
    const nested = record(value);
    if (typeof nested?.text === 'string' && nested.text.length > 0) return nested.text;
  }
  return undefined;
}

function toolEvent(kind: 'tool_use' | 'tool_result', name: string, id: string | undefined, value: unknown, isError?: boolean): AdapterContentEvent {
  const rendered = kind === 'tool_use' ? stringifyToolValue(value) : truncateText(typeof value === 'string' ? value : stringifyToolValue(value));
  return { role: 'tool', kind, text: rendered, tool: { ...(id ? { toolCallId: id } : {}), name, ...(kind === 'tool_use' ? { input: rendered } : { output: rendered }), ...(isError !== undefined ? { isError } : {}) } };
}

export function translateNotification(method: string, params: unknown, outputs: CodexCommandOutputs = new Map()): AdapterContentEvent[] {
  const p = record(params);
  if (!p) return [];
  const item = itemOf(p);
  const id = string(item?.id);
  if (method === 'item/agentMessage/delta') return string(p.delta ?? p.text) !== undefined ? [{ role: 'agent', kind: 'message', text: string(p.delta ?? p.text)! }] : [];
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') return string(p.delta ?? p.text) !== undefined ? [{ role: 'thinking', kind: 'thinking', text: string(p.delta ?? p.text)! }] : [];
  if (method === 'item/commandExecution/outputDelta' && id) { outputs.set(id, `${outputs.get(id) ?? ''}${stripAnsi(string(p.delta ?? p.text) ?? '')}`); return []; }
  if (!item || (method !== 'item/started' && method !== 'item/completed')) return [];
  const type = string(item.type) ?? 'unknown';
  // userMessage is the prompt echo (the engine owns the sole persisted user
  // event). Completed assistant/reasoning frames are fallbacks: the manager
  // strips any prefix already observed through deltas.
  if (type === 'userMessage') return [];
  if (type === 'agentMessage') {
    const text = method === 'item/completed'
      ? completedItemText(item, ['text', 'content', 'message'])
      : undefined;
    return text ? [{ role: 'agent', kind: 'message', text, data: { completedFallback: true } }] : [];
  }
  if (type === 'reasoning') {
    const text = method === 'item/completed'
      ? completedItemText(item, ['summaryText', 'summary', 'text', 'content'])
      : undefined;
    return text ? [{ role: 'thinking', kind: 'thinking', text, data: { completedFallback: true } }] : [];
  }
  const started = method === 'item/started';
  if (type === 'commandExecution') {
    if (started) { outputs.set(id ?? '', ''); return [toolEvent('tool_use', 'Bash', id, { command: item.command, cwd: item.cwd })]; }
    const output = outputs.get(id ?? '') ?? string(item.output) ?? '';
    outputs.delete(id ?? '');
    const exitCode = number(item.exitCode ?? item.exit_code);
    return [toolEvent('tool_result', 'Bash', id, output, exitCode !== undefined && exitCode !== 0)];
  }
  if (type === 'fileChange') return [started
    ? toolEvent('tool_use', 'Edit', id, item.changes ?? item)
    : toolEvent('tool_result', 'Edit', id, string(item.summary) ?? string(item.status) ?? stringifyToolValue(item))];
  const toolName = type === 'webSearch' || type === 'web_search'
    ? 'WebSearch'
    : type === 'todoList' || type === 'todo_list'
      ? 'TodoWrite'
      : type;
  return [started ? toolEvent('tool_use', toolName, id, item) : toolEvent('tool_result', toolName, id, string(item.summary) ?? string(item.status) ?? item)];
}

export function turnOutcome(params: unknown): { status: 'completed' | 'interrupted' | 'failed'; usage?: Usage } | undefined {
  const p = record(params); const turn = record(p?.turn) ?? p;
  const raw = string(turn?.status);
  if (!raw) return undefined;
  const status = raw === 'completed' ? 'completed' : (raw === 'interrupted' || raw === 'aborted') ? 'interrupted' : 'failed';
  const parsed = parseTokenUsage(turn?.usage ?? turn);
  const section = parsed.last ?? parsed.total;
  // MAT's shared Usage schema is strict; the codex-only cacheReadTokens field
  // must not leak into it.
  const usageOut: Usage | undefined = section ? { ...(section.inputTokens !== undefined ? { inputTokens: section.inputTokens } : {}), ...(section.outputTokens !== undefined ? { outputTokens: section.outputTokens } : {}) } : undefined;
  return { status, ...(usageOut && (usageOut.inputTokens !== undefined || usageOut.outputTokens !== undefined) ? { usage: usageOut } : {}) };
}
