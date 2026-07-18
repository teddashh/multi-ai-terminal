import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createLineBuffer } from '../../src/adapters/base.js';
import { sanitizedEnvironment, spawnManaged } from '../../src/spawn.js';

const testRoot = mkdtempSync(join(tmpdir(), 'mat-spawn-tests-'));
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

async function firstLine(stream: Readable): Promise<string> {
  let output = '';
  for await (const chunk of stream) {
    output += chunk.toString();
    const newline = output.indexOf('\n');
    if (newline >= 0) return output.slice(0, newline).trim();
  }
  return output.trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isAlive(pid)).toBe(false);
}

const sleepingGrandchild = `setInterval(() => undefined, 1_000);`;
const parentWithGrandchild = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleepingGrandchild)}], { stdio: 'ignore' });
console.log(child.pid);
setInterval(() => undefined, 1_000);
`;

describe('spawnManaged', () => {
  it('sanitizes Unix PATH values with injectable platform inputs', () => {
    const env = sanitizedEnvironment(
      { LD_LIBRARY_PATH: '/bad/appimage', PATH: '/bin' },
      { platform: 'linux', delimiter: ':', homedir: '/home/tester' },
    );
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.PATH?.split(':')).toEqual(['/bin', '/home/tester/.local/bin', '/usr/local/bin']);
  });

  it('preserves the Windows PATH key casing and delimiter without Unix additions', () => {
    const env = sanitizedEnvironment(
      { LD_LIBRARY_PATH: 'bad', Path: String.raw`C:\Windows;C:\Tools` },
      { platform: 'win32', delimiter: ';', homedir: String.raw`C:\Users\tester` },
    );
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.Path).toBe(String.raw`C:\Windows;C:\Tools`);
    expect(env.PATH).toBeUndefined();
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['Path']);
  });

  it('passes the sanitized environment to the spawned process', async () => {
    const managed = spawnManaged({
      command: process.execPath,
      args: ['-e', "console.log(JSON.stringify({ library: process.env.LD_LIBRARY_PATH, path: process.env.PATH ?? process.env.Path }))"],
      cwd: testRoot,
      env: { LD_LIBRARY_PATH: '/bad/appimage' },
    });
    const closed = once(managed.child, 'close');
    const output = await firstLine(managed.child.stdout!);
    await closed;
    const parsed = JSON.parse(output) as { library?: string; path?: string };
    expect(parsed.library).toBeUndefined();
    expect(parsed.path?.split(delimiter).filter(Boolean).length).toBeGreaterThan(0);
  });

  it('pipes stdin then closes it, with stdout available incrementally', async () => {
    const script = `let value = ''; process.stdin.on('data', (chunk) => value += chunk); process.stdin.on('end', () => console.log('got:' + value.trim()));`;
    const managed = spawnManaged({ command: process.execPath, args: ['-e', script], cwd: testRoot, stdin: 'hello\n' });
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    managed.child.stdout?.on('data', (chunk: Buffer) => buffer.push(chunk));
    const [code] = await once(managed.child, 'close');
    buffer.end();
    expect(code).toBe(0);
    expect(lines).toEqual(['got:hello']);
  });

  it('kills the process tree, including a spawned grandchild', async () => {
    const managed = spawnManaged({ command: process.execPath, args: ['-e', parentWithGrandchild], cwd: testRoot });
    const grandchildPid = Number(await firstLine(managed.child.stdout!));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    const closed = once(managed.child, 'close');
    managed.killGroup();
    const [code, signal] = await closed;
    if (process.platform === 'win32') expect(code).not.toBe(0);
    else expect(signal).toBe('SIGTERM');
    await waitForDeath(grandchildPid);
  });

  it('invokes the timeout hook and terminates the group', async () => {
    let timedOut = false;
    const managed = spawnManaged({
      command: process.execPath,
      args: ['-e', sleepingGrandchild],
      cwd: testRoot,
      timeoutMs: 20,
      onTimeout: () => { timedOut = true; },
    });
    await once(managed.child, 'close');
    expect(timedOut).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('sweeps background descendants when the direct child exits naturally', async () => {
    const parentThatExits = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleepingGrandchild)}], { stdio: 'ignore' });
child.unref();
console.log(child.pid);
`;
    const managed = spawnManaged({ command: process.execPath, args: ['-e', parentThatExits], cwd: testRoot });
    const closed = once(managed.child, 'close');
    const descendantPid = Number(await firstLine(managed.child.stdout!));
    await closed;
    expect(Number.isInteger(descendantPid)).toBe(true);
    await waitForDeath(descendantPid);
  });
});
