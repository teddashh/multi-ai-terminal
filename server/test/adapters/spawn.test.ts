import { once } from 'node:events';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createLineBuffer } from '../../src/adapters/base.js';
import { sanitizedEnvironment, spawnManaged } from '../../src/spawn.js';

describe('spawnManaged', () => {
  it('removes LD_LIBRARY_PATH and appends required PATH entries', async () => {
    const env = sanitizedEnvironment({ LD_LIBRARY_PATH: '/bad/appimage', PATH: '/bin' });
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.PATH?.split(':')).toEqual(['/bin', `${homedir()}/.local/bin`, '/usr/local/bin']);

    const managed = spawnManaged({
      command: '/bin/sh',
      args: ['-c', 'printf "%s\\n%s\\n" "${LD_LIBRARY_PATH-unset}" "$PATH"'],
      cwd: '/tmp',
      env: { LD_LIBRARY_PATH: '/bad/appimage', PATH: '/bin' },
    });
    let output = '';
    managed.child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    await once(managed.child, 'close');
    expect(output.trim().split('\n')).toEqual(['unset', `/bin:${homedir()}/.local/bin:/usr/local/bin`]);
  });

  it('pipes stdin then closes it, with stdout available incrementally', async () => {
    const managed = spawnManaged({ command: '/bin/sh', args: ['-c', 'read value; printf "got:%s\\n" "$value"'], cwd: '/tmp', stdin: 'hello\n' });
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    managed.child.stdout?.on('data', (chunk: Buffer) => buffer.push(chunk));
    const [code] = await once(managed.child, 'close');
    buffer.end();
    expect(code).toBe(0);
    expect(lines).toEqual(['got:hello']);
  });

  it('kills the detached process group, including a spawned child', async () => {
    const managed = spawnManaged({ command: '/bin/sh', args: ['-c', 'sleep 30 & child=$!; echo $child; wait'], cwd: '/tmp' });
    let output = '';
    managed.child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    while (!output.includes('\n')) await once(managed.child.stdout!, 'data');
    const childPid = Number(output.trim());
    managed.killGroup();
    const [, signal] = await once(managed.child, 'close');
    expect(signal).toBe('SIGTERM');
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('invokes the timeout hook and terminates the group', async () => {
    let timedOut = false;
    const managed = spawnManaged({
      command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: '/tmp', timeoutMs: 20,
      onTimeout: () => { timedOut = true; },
    });
    await once(managed.child, 'close');
    expect(timedOut).toBe(true);
  });
});
