import { spawnManaged } from '../../spawn.js';
import {
  ContentCoalescer,
  createLineBuffer,
  truncateText,
  type Adapter,
  type NodeOutcome,
  type ResolvedNodeSpec,
  type SpawnedNode,
} from '../../adapters/base.js';

export const AGY_MODELS = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
];

const PROMPT_LIMIT_BYTES = 200 * 1024;
const SAFE_INSTRUCTION = 'Read-only mode: inspect and explain, but do not modify files or execute mutating commands.\n\n';

export function resolveAgyModel(model: string | undefined, effort: ResolvedNodeSpec['binding']['effort']): string {
  const selected = model ?? 'Gemini 3.1 Pro (High)';
  if (!effort) return selected;
  const match = /^(.*) \((Low|Medium|High)\)$/.exec(selected);
  if (!match) return selected;
  const desired = effort === 'low' ? 'Low' : effort === 'medium' ? 'Medium' : 'High';
  const candidate = `${match[1]} (${desired})`;
  return AGY_MODELS.includes(candidate) ? candidate : selected;
}

export function buildAgyArgs(spec: ResolvedNodeSpec): string[] {
  const prompt = spec.binding.permission === 'safe' ? `${SAFE_INSTRUCTION}${spec.promptText}` : spec.promptText;
  const args = ['-p', prompt, '--model', resolveAgyModel(spec.binding.model, spec.binding.effort), '--print-timeout', '45m'];
  if (spec.binding.permission === 'full') args.push('--dangerously-skip-permissions');
  return args;
}

const failedSpawn = (message: string, io: Parameters<Adapter['spawn']>[1]): SpawnedNode => {
  io.onRaw(message, 'err');
  return {
    pid: process.pid,
    kill: () => undefined,
    completion: Promise.resolve({ exitCode: 1, error: message }),
  };
};

export function spawnAgyTransport(spec: ResolvedNodeSpec, io: Parameters<Adapter['spawn']>[1]): SpawnedNode {
  const args = buildAgyArgs(spec);
  const prompt = args[1] ?? '';
  if (Buffer.byteLength(prompt) > PROMPT_LIMIT_BYTES) {
    return failedSpawn(`agy prompt exceeds the 200 KB argv limit (${Buffer.byteLength(prompt)} bytes)`, io);
  }

  const managed = spawnManaged({ command: spec.runtimeCommand ?? 'agy', args, cwd: spec.cwd });
  const { child } = managed;
  let resultText = '';
  let spawnError: string | undefined;
  const stderrChunks: string[] = [];
  const coalescer = new ContentCoalescer(io.onEvent);
  const stdoutRaw = createLineBuffer((line) => io.onRaw(line, 'out'));
  const stderrRaw = createLineBuffer((line) => io.onRaw(line, 'err'));

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    resultText += text;
    stdoutRaw.push(text);
    coalescer.push('agent', 'message', text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrRaw.push(text);
    stderrChunks.push(text);
    while (Buffer.byteLength(stderrChunks.join('')) > 4096 && stderrChunks.length > 1) stderrChunks.shift();
  });

  const completion = new Promise<NodeOutcome>((resolve) => {
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (code, signal) => {
      stdoutRaw.end();
      stderrRaw.end();
      coalescer.end();
      const stderrTail = truncateText(stderrChunks.join(''), 4096).trim();
      const error = spawnError ?? (code ? stderrTail || `agy exited ${code}` : undefined);
      resolve({
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(resultText ? { resultText } : {}),
        ...(error ? { error } : {}),
      });
    });
  });

  return { pid: child.pid ?? -1, kill: managed.killGroup, completion };
}
