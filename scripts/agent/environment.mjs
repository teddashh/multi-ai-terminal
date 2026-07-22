import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root } from './contract.mjs';
import { windowsShellCommand } from './windows-command.mjs';

// The source-web lane runs entirely on Node.js: it builds the workspaces and
// serves the web UI from the Fastify server. It deliberately checks for no
// Rust, WebView, or desktop-session prerequisites.
export function collectEnvironmentChecks() {
  return [
    {
      name: 'repository',
      ok: ['package.json', 'package-lock.json', 'shared/package.json', 'server/package.json', 'web/package.json']
        .every((relative) => existsSync(path.join(root, relative))),
      detail: root,
    },
    {
      name: 'node',
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      detail: process.version,
    },
    commandCheck('npm', ['--version']),
  ];
}

export function commandCheck(command, args, name = command) {
  const windowsCommand = process.platform === 'win32' ? windowsShellCommand(command, args) : undefined;
  if (process.platform === 'win32' && !windowsCommand) {
    return { name, ok: false, detail: 'unsafe Windows command token' };
  }
  const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command;
  const executableArgs = process.platform === 'win32'
    ? ['/d', '/v:off', '/s', '/c', windowsCommand]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = String(result.stdout || result.stderr || result.error?.message || '').trim().split(/\r?\n/, 1)[0];
  const detail = output || (result.status === 0 ? 'available' : 'not found');
  return { name, ok: result.status === 0, detail };
}
