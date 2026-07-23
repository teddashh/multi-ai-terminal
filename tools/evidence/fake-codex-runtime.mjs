#!/usr/bin/env node
// Deterministic codex app-server stand-in for the independent runtime-contract
// evidence instrument. It uses only Node core, performs no network or file
// access beyond the caller-provided safe record, and records credential
// presence booleans only — never environment values.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Deliberately duplicated in the harness instead of reading the environment:
// this proves sink redaction without ever loading or recording a credential.
const REDACTION_CANARY = 'mat-openrouter-evidence-sentinel-7f0ed38b';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.144.5-evidence');
  process.exit(0);
}

if (!process.argv.includes('app-server')) {
  console.error('fake codex runtime accepts only --version or app-server');
  process.exit(2);
}

const recordPath = process.env.MAT_EVIDENCE_RUNTIME_RECORD;
const appendRecord = (record) => {
  if (!recordPath) return;
  appendFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf8');
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => {
  appendRecord({ kind: 'outbound', method });
  send({ method, params });
};

appendRecord({
  kind: 'environment',
  openRouterApiKeyPresent: process.env.OPENROUTER_API_KEY !== undefined,
  openAiApiKeyPresent: process.env.OPENAI_API_KEY !== undefined,
  codexApiKeyPresent: process.env.CODEX_API_KEY !== undefined,
  codexAccessTokenPresent: process.env.CODEX_ACCESS_TOKEN !== undefined,
  unexpectedSensitiveNames: Object.keys(process.env)
    .filter((name) => /(?:access[_-]?key|api[_-]?key|auth|cookie|credential|oauth|passw|private[_-]?key|secret|session|token|(?:^|[_-])pat(?:$|[_-]))/i.test(name))
    .filter((name) => name !== 'OPENROUTER_API_KEY')
    .sort(),
});
process.stderr.write(`fake runtime stderr canary: ${REDACTION_CANARY}\n`);

let threadSequence = 0;
let turnSequence = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  const method = typeof message.method === 'string' ? message.method : undefined;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? message.params
    : {};
  appendRecord({
    kind: 'inbound',
    method: method ?? null,
    hasId: Object.hasOwn(message, 'id'),
    ...(method === 'thread/start' || method === 'thread/resume'
      ? {
          model: typeof params.model === 'string' ? params.model : null,
          modelProvider: typeof params.modelProvider === 'string' ? params.modelProvider : null,
        }
      : {}),
    ...(method === 'turn/start'
      ? {
          model: typeof params.model === 'string' ? params.model : null,
          modelProviderPresent: Object.hasOwn(params, 'modelProvider'),
        }
      : {}),
  });

  if (method === 'initialize' && Object.hasOwn(message, 'id')) {
    send({ id: message.id, result: { server: 'mat-evidence-fake-codex' } });
    return;
  }
  if (method === 'initialized' && !Object.hasOwn(message, 'id')) return;
  if (!method || !Object.hasOwn(message, 'id')) return;

  if (method === 'thread/start') {
    threadSequence += 1;
    send({ id: message.id, result: { thread: { id: `thread-fixture-${threadSequence}` } } });
    return;
  }
  if (method === 'thread/resume') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : 'thread-fixture-resumed';
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (method === 'turn/start') {
    turnSequence += 1;
    const threadId = typeof params.threadId === 'string' ? params.threadId : 'thread-fixture-unknown';
    const turnId = `turn-fixture-${turnSequence}`;
    const toolId = `tool-fixture-${turnSequence}`;
    send({ id: message.id, result: { turn: { id: turnId } } });

    const frames = [
      ['turn/started', { threadId, turn: { id: turnId } }],
      ['item/reasoning/summaryTextDelta', { threadId, turnId, delta: `mapped thinking ${REDACTION_CANARY}` }],
      ['item/started', {
        threadId,
        turnId,
        item: {
          id: toolId,
          type: 'commandExecution',
          command: 'printf runtime-contract',
          cwd: '/evidence-workspace',
        },
      }],
      ['item/commandExecution/outputDelta', {
        threadId,
        turnId,
        item: { id: toolId },
        delta: `tool output ${REDACTION_CANARY}`,
      }],
      ['item/completed', {
        threadId,
        turnId,
        item: { id: toolId, type: 'commandExecution', exitCode: 0 },
      }],
      ['item/agentMessage/delta', { threadId, turnId, delta: `mapped OpenRouter answer ${REDACTION_CANARY}` }],
      ['thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: { inputTokens: 13, outputTokens: 5 },
          last: { inputTokens: 13, outputTokens: 5 },
          modelContextWindow: 128_000,
        },
      }],
      ['turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'completed',
          usage: { input_tokens: 13, output_tokens: 5 },
        },
      }],
    ];
    // Keep notifications ordered and give the consuming app-server manager one
    // event-loop turn between frames. Millisecond-spaced independent timers can
    // expire together under suite load and exercise transport chunk reentrancy
    // instead of the provider-event contract this fixture is meant to prove.
    const emitFrames = async () => {
      for (const [eventMethod, eventParams] of frames) {
        notify(eventMethod, eventParams);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    setTimeout(() => { void emitFrames(); }, 250);
    return;
  }
  if (method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    const threadId = typeof params.threadId === 'string' ? params.threadId : 'thread-fixture-unknown';
    const turnId = typeof params.turnId === 'string' ? params.turnId : 'turn-fixture-unknown';
    setTimeout(() => notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'interrupted' },
    }), 5);
    return;
  }
  if (method === 'account/rateLimits/read') {
    send({ id: message.id, result: {} });
    return;
  }

  send({ id: message.id, error: { code: -32601, message: `unsupported method: ${method}` } });
});

process.on('SIGTERM', () => process.exit(0));
