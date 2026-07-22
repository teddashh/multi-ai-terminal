import { expect, test } from 'vitest';
import { windowsShellCommand } from '../windows-command.mjs';

test('Windows agent commands accept only shell-safe tokens', () => {
  expect(windowsShellCommand('npm', ['ci', '--no-audit', '--no-fund'])).toBe('npm ci --no-audit --no-fund');
  expect(windowsShellCommand('node', ['server/dist/index.js', '--port', '0', '--host', '127.0.0.1']))
    .toBe('node server/dist/index.js --port 0 --host 127.0.0.1');

  for (const unsafe of ['space value', 'value&whoami', '%PATH%', '"quoted"', 'line\nbreak', 'a|b', 'a>b']) {
    expect(windowsShellCommand('npm', [unsafe])).toBeUndefined();
  }
  expect(windowsShellCommand('bad tool', ['--version'])).toBeUndefined();
});
