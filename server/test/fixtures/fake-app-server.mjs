import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = JSON.parse(process.env.MAT_FAKE_APPSERVER_SCENARIO ?? '{}');
let spawnIndex = 1;
if (scenario.spawnMarkerFile) {
  try { spawnIndex = readFileSync(scenario.spawnMarkerFile, 'utf8').trim().split('\n').filter(Boolean).length + 1; } catch {}
  appendFileSync(scenario.spawnMarkerFile, `${process.pid}\n`);
}

const record = (direction, message) => {
  if (!scenario.recordFile) return;
  appendFileSync(scenario.recordFile, `${JSON.stringify({ direction, message, spawnIndex, apiKeyPresent: process.env.OPENAI_API_KEY !== undefined })}\n`);
};
const send = (message) => {
  record('out', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const later = (delayMs, fn) => setTimeout(fn, delayMs ?? 0);

let initialized = false;
const calls = new Map();
process.stdin.resume();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  record('in', message);

  if (message.method === 'initialize' && Object.hasOwn(message, 'id')) {
    later(scenario.initializeDelayMs, () => send({ id: message.id, result: { ok: true } }));
    return;
  }
  if (message.method === 'initialized' && !Object.hasOwn(message, 'id')) {
    initialized = true;
    if (scenario.warningLine) process.stdout.write(`${scenario.warningLine}\n`);
    return;
  }
  if (!message.method || !Object.hasOwn(message, 'id')) return;

  const raw = scenario.responses?.[message.method] ?? {};
  const count = calls.get(message.method) ?? 0;
  calls.set(message.method, count + 1);
  const action = Array.isArray(raw) ? (raw[count] ?? raw.at(-1) ?? {}) : raw;
  if (action.notification) later(action.notification.delayMs, () => send({ method: action.notification.method, params: action.notification.params }));
  if (action.serverRequest) later(action.serverRequest.delayMs, () => send({ method: action.serverRequest.method, id: action.serverRequest.id, params: action.serverRequest.params }));
  for (const entry of action.notifications ?? []) {
    if (entry.onSpawn !== undefined && entry.onSpawn !== spawnIndex) continue;
    later(entry.delayMs, () => send(entry.serverRequest
      ? { method: entry.serverRequest.method, id: entry.serverRequest.id, params: entry.serverRequest.params }
      : { method: entry.method, ...(entry.id !== undefined ? { id: entry.id } : {}), params: entry.params }));
  }
  const noReply = action.noReply === true || action.noReplyOnSpawn === spawnIndex;
  const result = action.resultBySpawn?.[spawnIndex] ?? action.result;
  if (!noReply) later(action.delayMs, () => send(action.error
    ? { id: message.id, error: action.error }
    : { id: message.id, result: action.echoParams ? message.params : result }));
  if (action.exitAfter && (!action.exitOnSpawn || action.exitOnSpawn === spawnIndex)) {
    later(action.exitAfter, () => process.exit(action.exitCode ?? 0));
  }
  if (action.requireInitialized && !initialized) process.exit(91);
});
