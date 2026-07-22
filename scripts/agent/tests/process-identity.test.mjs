import { expect, test } from 'vitest';
import { commandLineMatchesRunner, processKillErrorMeansAlive, processMatchesAgentScript } from '../process-identity.mjs';

test('runner identity requires both runner path and exact token text', () => {
  const token = '123e4567-e89b-12d3-a456-426614174000';
  expect(commandLineMatchesRunner(`node C:\\repo\\scripts\\agent\\runner.mjs ${token} node server/dist/index.js`, token)).toBe(true);
  expect(commandLineMatchesRunner(`/usr/bin/node /repo/scripts/agent/runner.mjs ${token} node server/dist/index.js`, token)).toBe(true);
  expect(commandLineMatchesRunner('node C:\\repo\\scripts\\agent\\runner.mjs wrong-token', token)).toBe(false);
  expect(commandLineMatchesRunner(`node C:\\repo\\scripts\\agent\\other.mjs ${token}`, token)).toBe(false);
  expect(commandLineMatchesRunner(undefined, token)).toBe(false);
  expect(commandLineMatchesRunner('node runner.mjs', '')).toBe(false);
});

test('EPERM from signal zero still means the process exists', () => {
  expect(processKillErrorMeansAlive({ code: 'EPERM' })).toBe(true);
  expect(processKillErrorMeansAlive({ code: 'ESRCH' })).toBe(false);
  expect(processKillErrorMeansAlive(undefined)).toBe(false);
});

test('agent-script ownership checks reject invalid PIDs and script names', () => {
  expect(processMatchesAgentScript(0, 'launch.mjs')).toBe(false);
  expect(processMatchesAgentScript(-1, 'launch.mjs')).toBe(false);
  expect(processMatchesAgentScript(process.pid, 'bad name!.mjs')).toBe(false);
});
