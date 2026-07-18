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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // Process cleanup is always best-effort; permission and recycled-process
    // failures must not crash the server.
    return false;
  }
}

export function terminateProcessGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || !signalProcessGroup(pid, 'SIGTERM')) return;
  const timer = setTimeout(() => { signalProcessGroup(pid, 'SIGKILL'); }, KILL_ESCALATION_MS);
  timer.unref();
}

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
  let sweptOnExit = false;
  const clearTimeoutTimer = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    signalProcessGroup(child.pid, signal);
  };

  const killGroup = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    signalGroup(signal);
    if (signal !== 'SIGTERM' || escalationTimer || !child.pid) return;
    escalationTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_ESCALATION_MS);
    escalationTimer.unref();
  };

  child.once('exit', () => {
    if (child.pid && !escalationTimer) {
      sweptOnExit = true;
      terminateProcessGroup(child.pid);
    }
  });

  child.once('close', () => {
    clearTimeoutTimer();
    if (child.pid && !escalationTimer && !sweptOnExit) terminateProcessGroup(child.pid);
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
