import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterContentEvent, AgentBinding } from '@mat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agyAdapter, buildAgyArgs, resolveAgyModel } from '../../src/adapters/agy.js';
import { ContentCoalescer, type Adapter, type ResolvedNodeSpec } from '../../src/adapters/base.js';
import { buildClaudeArgs, claudeAdapter } from '../../src/adapters/claude.js';
import { buildCodexArgs, codexAdapter } from '../../src/adapters/codex.js';
import { buildGrokArgs, grokAdapter } from '../../src/adapters/grok.js';
import { mockAdapter } from '../../src/adapters/mock.js';
import { createFakeExecutable, prependPath } from '../helpers/fakeExecutable.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
let fakeRoot = '';
let captureDir = '';
let originalPath: string | undefined;

beforeAll(() => {
  fakeRoot = mkdtempSync(join(tmpdir(), 'mat-adapter-tests-'));
  captureDir = join(fakeRoot, 'captures');
  for (const provider of ['claude', 'codex', 'grok', 'agy']) {
    createFakeExecutable(fakeRoot, provider, `
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const provider = ${JSON.stringify(provider)};
const captureDir = process.env.MAT_CAPTURE_DIR;
mkdirSync(captureDir, { recursive: true });

if (process.argv[2] === '--version') {
  console.log(provider + ' 1.0.0');
  process.exit(0);
}

function emitFixture() {
  if (provider === 'grok') {
    const index = process.argv.indexOf('--prompt-file');
    if (index >= 0 && process.argv[index + 1]) {
      const promptPath = process.argv[index + 1];
      writeFileSync(join(captureDir, 'grok.prompt-path'), promptPath);
      copyFileSync(promptPath, join(captureDir, 'grok.prompt'));
    }
  }
  if (provider === 'agy' && process.env.MAT_AGY_SIZED === '1') {
    process.stdout.write('a'.repeat(2048));
    setTimeout(() => process.stdout.write('b'), 20);
  } else if (process.env.MAT_FIXTURE) {
    process.stdout.write(readFileSync(process.env.MAT_FIXTURE));
  }
}

if (provider === 'claude' || provider === 'codex') {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    writeFileSync(join(captureDir, provider + '.stdin'), Buffer.concat(chunks));
    emitFixture();
  });
} else {
  emitFixture();
}
`);
  }
  originalPath = process.env.PATH;
  process.env.PATH = prependPath(fakeRoot, originalPath);
  process.env.MAT_CAPTURE_DIR = captureDir;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.MAT_CAPTURE_DIR;
  delete process.env.MAT_FIXTURE;
  delete process.env.MAT_AGY_SIZED;
  rmSync(fakeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const spec = (
  provider: AgentBinding['provider'],
  binding: Partial<AgentBinding> = {},
  promptText = 'fixture prompt',
): ResolvedNodeSpec => ({
  binding: { provider, permission: 'auto', ...binding },
  promptText,
  cwd: fakeRoot,
});

async function runFixture(adapter: Adapter, nodeSpec: ResolvedNodeSpec, name: string): Promise<{
  events: AdapterContentEvent[];
  raw: Array<{ line: string; stream: 'out' | 'err' }>;
  outcome: Awaited<ReturnType<Adapter['spawn']>['completion']>;
}> {
  process.env.MAT_FIXTURE = isAbsolute(name) ? name : fixture(name);
  const events: AdapterContentEvent[] = [];
  const raw: Array<{ line: string; stream: 'out' | 'err' }> = [];
  const spawned = adapter.spawn(nodeSpec, {
    onEvent: (event) => events.push(event),
    onRaw: (line, stream) => raw.push({ line, stream }),
  });
  return { events, raw, outcome: await spawned.completion };
}

describe('claude adapter', () => {
  it('normalizes the basic fixture and delivers the prompt through closed stdin', async () => {
    const result = await runFixture(claudeAdapter, spec('claude', { model: 'haiku' }, 'hello stdin'), 'claude.jsonl');
    expect(result.events).toEqual([
      { role: 'thinking', kind: 'thinking', text: 'The user is asking me to reply with exactly "ok". This is a simple request for confirmation. I should respond with exactly that word.' },
      { role: 'agent', kind: 'message', text: 'ok' },
    ]);
    expect(result.outcome).toEqual({
      exitCode: 0,
      sessionRef: 'e0702857-2eb6-4742-99bc-857d352ab37b',
      usage: { inputTokens: 10, outputTokens: 40, costUsd: 0.0171698 },
      resultText: 'ok',
    });
    expect(readFileSync(join(captureDir, 'claude.stdin'), 'utf8')).toBe('hello stdin');
    expect(result.raw).toHaveLength(9);
  }, 30_000);

  it('normalizes thinking, tool use/result, and final message exactly', async () => {
    const { events, outcome } = await runFixture(claudeAdapter, spec('claude'), 'claude-tool.jsonl');
    expect(events.map(({ role, kind, text, tool }) => ({ role, kind, text, tool }))).toEqual([
      { role: 'thinking', kind: 'thinking', text: 'The user wants me to run a bash command `echo hello-mat` and report its output. This is straightforward - I just need to use the Bash tool to execute the command.', tool: undefined },
      { role: 'tool', kind: 'tool_use', text: 'Bash', tool: { toolCallId: 'toolu_01KxZv4YNqWBrc3wkxTdt3jt', name: 'Bash', input: '{"command":"echo hello-mat","description":"Echo the string hello-mat"}' } },
      { role: 'tool', kind: 'tool_result', text: 'hello-mat', tool: { toolCallId: 'toolu_01KxZv4YNqWBrc3wkxTdt3jt', name: 'Bash', output: 'hello-mat', isError: false } },
      { role: 'thinking', kind: 'thinking', text: 'The command ran successfully and output "hello-mat". I should report this to the user.', tool: undefined },
      { role: 'agent', kind: 'message', text: 'The command executed successfully. The output is:\n\n```\nhello-mat\n```', tool: undefined },
    ]);
    expect(outcome).toMatchObject({
      exitCode: 0,
      sessionRef: '1ae8d0b3-9ee0-4281-9a4c-223405cd8720',
      usage: { inputTokens: 18, outputTokens: 171, costUsd: 0.0123488 },
      resultText: 'The command executed successfully. The output is:\n\n```\nhello-mat\n```',
    });
  }, 30_000);

  it('maps permission, max-turn, system prompt, and resume flags', () => {
    expect(buildClaudeArgs({
      ...spec('claude', { model: 'opus', permission: 'full', maxTurns: 7, systemPromptAppend: 'extra' }),
      resumeSessionRef: 'session-1',
    })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus',
      '--dangerously-skip-permissions', '--max-turns', '7', '--append-system-prompt', 'extra',
      '--resume', 'session-1',
    ]);
  }, 30_000);
});

describe('codex adapter', () => {
  it('normalizes the basic fixture and camel-cases usage', async () => {
    const { events, outcome } = await runFixture(codexAdapter, spec('codex'), 'codex.jsonl');
    expect(events).toEqual([{ role: 'agent', kind: 'message', text: 'ok' }]);
    expect(outcome).toEqual({
      exitCode: 0,
      sessionRef: '019f74a6-0e92-7360-8ac9-ed1e40d47aa7',
      usage: { inputTokens: 13158, outputTokens: 5 },
      resultText: 'ok',
    });
  }, 30_000);

  it('normalizes command lifecycle and keeps the last agent message as resultText', async () => {
    const { events, outcome } = await runFixture(codexAdapter, spec('codex'), 'codex-tool.jsonl');
    expect(events).toEqual([
      { role: 'agent', kind: 'message', text: 'I’ll run that exact command and report what it prints.' },
      { role: 'tool', kind: 'tool_use', text: "/bin/bash -lc 'echo hello-mat .'", tool: { toolCallId: 'item_1', name: 'shell', input: "/bin/bash -lc 'echo hello-mat .'" } },
      { role: 'tool', kind: 'tool_result', text: 'hello-mat .\n', tool: { toolCallId: 'item_1', name: 'shell', output: 'hello-mat .\n', isError: false } },
      { role: 'agent', kind: 'message', text: '`hello-mat .`' },
    ]);
    expect(outcome).toMatchObject({
      exitCode: 0,
      sessionRef: '019f74ad-caa0-79b2-8d0e-1260deb3a761',
      usage: { inputTokens: 26436, outputTokens: 83 },
      resultText: '`hello-mat .`',
    });
  }, 30_000);

  it('raw-logs but skips dirty non-JSON stdout', async () => {
    const { events, raw } = await runFixture(codexAdapter, spec('codex'), 'codex.dirty.jsonl');
    expect(events).toEqual([{ role: 'agent', kind: 'message', text: 'ok' }]);
    expect(raw[0]).toEqual({ line: 'Reading additional input from stdin...', stream: 'out' });
    expect(raw).toHaveLength(5);
  }, 30_000);

  it('delivers stdin and explicitly re-passes every setting on resume', async () => {
    const resumed = {
      ...spec('codex', { model: 'gpt-5.6-sol', effort: 'xhigh', permission: 'safe' }, 'codex stdin'),
      resumeSessionRef: 'thread-1',
    };
    await runFixture(codexAdapter, resumed, 'codex.jsonl');
    expect(readFileSync(join(captureDir, 'codex.stdin'), 'utf8')).toBe('codex stdin');
    expect(buildCodexArgs(resumed)).toEqual([
      'exec', '--json', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=xhigh',
      '--cd', fakeRoot, '--sandbox', 'read-only', '--skip-git-repo-check',
      'resume', 'thread-1', '-',
    ]);
  }, 30_000);

  it('maps reasoning and forward-compatible unknown item types', async () => {
    const customFixture = join(fakeRoot, 'codex-unknown.jsonl');
    writeFileSync(customFixture, [
      JSON.stringify({ type: 'item.completed', item: { id: 'reason-1', type: 'reasoning', text: 'checking' } }),
      JSON.stringify({ type: 'item.started', item: { id: 'future-1', type: 'future_item', value: 1 } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'future-1', type: 'future_item', value: 2 } }),
    ].join('\n'));
    const { events } = await runFixture(codexAdapter, spec('codex'), customFixture);
    expect(events).toEqual([
      { role: 'thinking', kind: 'thinking', text: 'checking' },
      { role: 'tool', kind: 'tool_use', text: 'future_item', tool: { toolCallId: 'future-1', name: 'future_item', input: '{"id":"future-1","type":"future_item","value":1}' } },
      { role: 'tool', kind: 'tool_result', text: 'future_item', tool: { toolCallId: 'future-1', name: 'future_item', output: '{"id":"future-1","type":"future_item","value":2}' } },
    ]);
  }, 30_000);
});

describe('grok adapter', () => {
  it('coalesces thought/text on kind change and captures the session', async () => {
    const { events, outcome } = await runFixture(grokAdapter, spec('grok'), 'grok.jsonl');
    expect(events).toEqual([
      { role: 'thinking', kind: 'thinking', text: 'The user wants me to reply with exactly "ok". This is a simple request with no tools needed.' },
      { role: 'agent', kind: 'message', text: 'ok' },
    ]);
    expect(outcome).toEqual({
      exitCode: 0,
      sessionRef: '019f74a6-104f-7320-8f58-48cf907c2920',
      resultText: 'ok',
    });
  }, 30_000);

  it('emits no tool rows for the probe-confirmed tool fixture', async () => {
    const { events, outcome } = await runFixture(grokAdapter, spec('grok'), 'grok-tool.jsonl');
    expect(events.map((event) => event.kind)).toEqual(['thinking', 'message']);
    expect(events.some((event) => event.role === 'tool')).toBe(false);
    expect(outcome).toMatchObject({
      exitCode: 0,
      sessionRef: '019f74ad-cbba-7372-b0ba-2837c5158a02',
      resultText: '**Command:** `echo hello-mat`  \n**Exit code:** 0  \n\n**Output:**\n```\nhello-mat\n```',
    });
  }, 30_000);

  it('uses a private prompt file and removes it after completion', async () => {
    await runFixture(grokAdapter, spec('grok', { effort: 'high' }, 'file prompt'), 'grok.jsonl');
    const promptPath = readFileSync(join(captureDir, 'grok.prompt-path'), 'utf8');
    expect(readFileSync(join(captureDir, 'grok.prompt'), 'utf8')).toBe('file prompt');
    expect(existsSync(promptPath)).toBe(false);
    expect(buildGrokArgs(spec('grok', { effort: 'high' }), join(tmpdir(), 'prompt'))).toContain('--reasoning-effort');
  }, 30_000);
});

describe('coalescing and agy plain output', () => {
  it('flushes at 2 KB and marks subsequent same-kind events continued without timers', () => {
    const events: AdapterContentEvent[] = [];
    const coalescer = new ContentCoalescer((event) => events.push(event));
    coalescer.push('thinking', 'thinking', 'a'.repeat(2048));
    coalescer.push('thinking', 'thinking', 'b');
    coalescer.push('agent', 'message', 'answer');
    coalescer.end();
    expect(events).toEqual([
      { role: 'thinking', kind: 'thinking', text: 'a'.repeat(2048) },
      { role: 'thinking', kind: 'thinking', text: 'b', data: { continued: true } },
      { role: 'agent', kind: 'message', text: 'answer' },
    ]);
  }, 30_000);

  it('starts a fresh continuation block for thinking after a message block', () => {
    const events: AdapterContentEvent[] = [];
    const coalescer = new ContentCoalescer((event) => events.push(event));
    coalescer.push('thinking', 'thinking', 'first thought');
    coalescer.push('agent', 'message', 'answer');
    coalescer.push('thinking', 'thinking', 'second thought');
    coalescer.end();
    expect(events).toEqual([
      { role: 'thinking', kind: 'thinking', text: 'first thought' },
      { role: 'agent', kind: 'message', text: 'answer' },
      { role: 'thinking', kind: 'thinking', text: 'second thought' },
    ]);
  }, 30_000);

  it('streams and coalesces agy stdout while preserving full resultText', async () => {
    process.env.MAT_AGY_SIZED = '1';
    delete process.env.MAT_FIXTURE;
    const events: AdapterContentEvent[] = [];
    const spawned = agyAdapter.spawn(spec('agy'), { onEvent: (event) => events.push(event), onRaw: () => undefined });
    const outcome = await spawned.completion;
    delete process.env.MAT_AGY_SIZED;
    expect(events).toEqual([
      { role: 'agent', kind: 'message', text: 'a'.repeat(2048) },
      { role: 'agent', kind: 'message', text: 'b', data: { continued: true } },
    ]);
    expect(outcome).toEqual({ exitCode: 0, resultText: `${'a'.repeat(2048)}b` });
  }, 30_000);

  it('normalizes the vendored plain-output fixture', async () => {
    const { events, raw, outcome } = await runFixture(agyAdapter, spec('agy'), 'agy.log');
    expect(events).toEqual([{ role: 'agent', kind: 'message', text: 'ok\n' }]);
    expect(raw).toEqual([{ line: 'ok', stream: 'out' }]);
    expect(outcome).toEqual({ exitCode: 0, resultText: 'ok\n' });
  }, 30_000);

  it('maps display-name effort variants and safe/full permissions', () => {
    expect(resolveAgyModel('Gemini 3.1 Pro (Low)', 'high')).toBe('Gemini 3.1 Pro (High)');
    expect(resolveAgyModel('Claude Sonnet 4.6 (Thinking)', 'low')).toBe('Claude Sonnet 4.6 (Thinking)');
    expect(buildAgyArgs(spec('agy', { permission: 'safe' }, 'inspect'))[1]).toContain('Read-only mode:');
    expect(buildAgyArgs(spec('agy', { permission: 'full' }))).toContain('--dangerously-skip-permissions');
  }, 30_000);

  it('rejects prompts over the 200 KB argv cap without spawning', async () => {
    const raw: string[] = [];
    const spawned = agyAdapter.spawn(spec('agy', {}, 'x'.repeat(200 * 1024 + 1)), {
      onEvent: () => undefined,
      onRaw: (line) => raw.push(line),
    });
    await expect(spawned.completion).resolves.toMatchObject({ exitCode: null, error: expect.stringContaining('200 KB') });
    expect(raw).toEqual([expect.stringContaining('200 KB')]);
  }, 30_000);
});

describe('registry-facing metadata and mock echo', () => {
  it('probes each installed command with --version and exposes defaults', async () => {
    for (const adapter of [claudeAdapter, codexAdapter, grokAdapter, agyAdapter]) {
      await expect(adapter.available()).resolves.toEqual({ ok: true, version: `${adapter.id} 1.0.0` });
    }
    expect([claudeAdapter.defaultModel, codexAdapter.defaultModel, grokAdapter.defaultModel, agyAdapter.defaultModel])
      .toEqual(['sonnet', 'gpt-5.6-sol', 'grok-4.5', 'Gemini 3.1 Pro (High)']);
  }, 30_000);

  it('uses everything after MOCK_REPLY as the final message and result', async () => {
    const events: AdapterContentEvent[] = [];
    const spawned = mockAdapter.spawn(spec('mock', {}, 'brief\nMOCK_REPLY: {"action":"advance"}'), {
      onEvent: (event) => events.push(event), onRaw: () => undefined,
    });
    await expect(spawned.completion).resolves.toMatchObject({ resultText: '{"action":"advance"}' });
    expect(events.at(-1)?.text).toBe('{"action":"advance"}');
  }, 30_000);
});
