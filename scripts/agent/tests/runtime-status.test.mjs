import { expect, test } from 'vitest';
import { readyMarker } from '../contract.mjs';
import { classifyRuntime, logSegmentForRun, readinessWaitDecision, readyUrl, recentLogLines, stripAnsi } from '../runtime-status.mjs';

const readyLine = '[MAT_AGENT] READY url=http://127.0.0.1:34023/';

test('a READY marker from an earlier run cannot satisfy a new run', () => {
  const oldStartedAt = '2026-07-01T00:00:00.000Z';
  const newStartedAt = '2026-07-02T00:00:00.000Z';
  const log = [
    `[${oldStartedAt}] Launch requested by repository skill`,
    readyLine,
    `[${newStartedAt}] Launch requested by repository skill`,
    '[mat] booting',
  ].join('\n');
  const runLog = logSegmentForRun(log, newStartedAt);

  expect(runLog).not.toContain(readyMarker);
  expect(classifyRuntime({ running: true, identityMatches: true, runLog })).toBe('building');
});

test('current-run marker proves server readiness and carries the URL', () => {
  const startedAt = '2026-07-02T00:00:00.000Z';
  const runLog = logSegmentForRun([
    `[${startedAt}] Launch requested by repository skill`,
    readyLine,
  ].join('\n'), startedAt);

  expect(classifyRuntime({ running: true, identityMatches: true, runLog })).toBe('ready');
  expect(readyUrl(runLog)).toBe('http://127.0.0.1:34023/');
  expect(readyUrl('')).toBeUndefined();
});

test('dead launch distinguishes failure from a normal post-ready exit', () => {
  for (const failureLine of [
    'npm ERR! code ELIFECYCLE',
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:7788',
    'error TS2345: Argument of type foo',
    'build failed with 3 errors',
  ]) {
    expect(classifyRuntime({ running: false, identityMatches: false, runLog: failureLine })).toBe('failed');
  }
  expect(classifyRuntime({
    running: false,
    identityMatches: false,
    runLog: `${readyLine}\n[MAT_AGENT] EXIT code=0 signal=none`,
  })).toBe('exited');
});

test('a live PID with the wrong runner identity is foreign', () => {
  expect(classifyRuntime({ running: true, identityMatches: false, runLog: '' })).toBe('foreign_process');
});

test('readiness wait is bound to one launch and treats missing state as failure', () => {
  const expected = '2026-07-02T00:00:00.000Z';
  expect(readinessWaitDecision({ state: 'not_started' }, expected, false)).toEqual({
    kind: 'failed',
    error: 'The runtime state disappeared before the server became ready.',
  });
  expect(readinessWaitDecision({
    state: 'ready',
    startedAt: '2026-07-03T00:00:00.000Z',
  }, expected, true)).toEqual({
    kind: 'refused',
    error: 'Runtime state was replaced by a different launch.',
  });
  expect(readinessWaitDecision({ state: 'ready', startedAt: expected }, expected, true)).toEqual({ kind: 'ready' });
  expect(readinessWaitDecision({ state: 'building', startedAt: expected }, expected, false)).toEqual({ kind: 'pending' });
  expect(readinessWaitDecision({ state: 'foreign_process', startedAt: expected }, expected, false)).toEqual({ kind: 'pending' });
  expect(readinessWaitDecision({ state: 'foreign_process', startedAt: expected }, expected, true)).toEqual({
    kind: 'refused',
    error: 'The recorded PID no longer matches this repository launcher.',
  });
  expect(readinessWaitDecision({
    state: 'failed',
    startedAt: expected,
    lastError: 'npm ERR! code ELIFECYCLE',
  }, expected, false)).toEqual({ kind: 'failed', error: 'npm ERR! code ELIFECYCLE' });
});

test('log helpers strip color codes and bound the reported tail', () => {
  expect(stripAnsi('\u001b[32mready\u001b[0m')).toBe('ready');
  expect(recentLogLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
  expect(recentLogLines('', 5)).toEqual([]);
});
