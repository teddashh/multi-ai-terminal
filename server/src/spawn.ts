import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

export interface SpawnProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onTimeout?: () => void;
}
export interface ManagedProcess {
  child: ChildProcess;
  killGroup(signal?: NodeJS.Signals): void;
}

const KILL_ESCALATION_MS = 10_000;

export function sanitizedEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.LD_LIBRARY_PATH;

  const additions = [`${homedir()}/.local/bin`, '/usr/local/bin'];
  const entries = (env.PATH ?? '').split(':').filter(Boolean);
  for (const addition of additions) {
    if (!entries.includes(addition)) entries.push(addition);
  }
  env.PATH = entries.join(':');
  return env;
}

export function spawnManaged(options: SpawnProcessOptions): ManagedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: true,
    env: sanitizedEnvironment(options.env),
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });

  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const clearTimers = (): void => {
    if (escalationTimer) clearTimeout(escalationTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    escalationTimer = undefined;
    timeoutTimer = undefined;
  };

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid || closed) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw error;
    }
  };

  const killGroup = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    signalGroup(signal);
    if (signal !== 'SIGTERM' || closed || escalationTimer) return;
    escalationTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_ESCALATION_MS);
    escalationTimer.unref();
  };

  child.once('close', () => {
    closed = true;
    clearTimers();
  });

  if (options.stdin !== undefined) {
    // A CLI that exits before consuming its prompt can close the pipe while Node is
    // still flushing it. The process exit/error remains the authoritative outcome.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin);
  }

  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      options.onTimeout?.();
      killGroup('SIGTERM');
    }, options.timeoutMs);
    timeoutTimer.unref();
  }

  return { child, killGroup };
}
