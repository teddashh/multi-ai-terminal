import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter } from 'node:path';
import crossSpawn from 'cross-spawn';

export interface SpawnProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onTimeout?: () => void;
  shell?: boolean;
}
export interface ManagedProcess {
  child: ChildProcess;
  killGroup(signal?: NodeJS.Signals): void;
}

const KILL_ESCALATION_MS = 10_000;

interface EnvironmentOptions {
  platform?: NodeJS.Platform;
  delimiter?: string;
  homedir?: string;
}

function taskkillProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const killer = spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => undefined);
    killer.unref();
  } catch {
    // Process cleanup is always best-effort.
  }
}

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
  if (process.platform === 'win32') {
    taskkillProcessTree(pid);
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !signalProcessGroup(pid, 'SIGTERM')) return;
  const timer = setTimeout(() => { signalProcessGroup(pid, 'SIGKILL'); }, KILL_ESCALATION_MS);
  timer.unref();
}

export function sanitizedEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  options: EnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const delimiter = options.delimiter ?? pathDelimiter;
  const env = { ...process.env, ...overrides };
  delete env.LD_LIBRARY_PATH;

  const overridePathKey = Object.keys(overrides).find((key) => key.toLowerCase() === 'path');
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  const pathKey = platform === 'win32'
    ? (overridePathKey ?? inheritedPathKey ?? 'Path')
    : 'PATH';
  const pathValue = overridePathKey
    ? overrides[overridePathKey]
    : inheritedPathKey
      ? process.env[inheritedPathKey]
      : undefined;

  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
  }

  const additions = platform === 'win32'
    ? []
    : [`${options.homedir ?? homedir()}/.local/bin`, '/usr/local/bin'];
  const entries = (pathValue ?? '').split(delimiter).filter(Boolean);
  for (const addition of additions) {
    if (!entries.includes(addition)) entries.push(addition);
  }
  env[pathKey] = entries.join(delimiter);
  return env;
}

export function spawnManaged(options: SpawnProcessOptions): ManagedProcess {
  const windows = process.platform === 'win32';
  // cross-spawn's Windows ENOENT heuristic treats any shell exit code 1 as
  // command-not-found (parsed.file is never set when shell is true) and swallows
  // the real exit event. Shell commands need no .cmd/PATHEXT shim, so bypass it.
  const spawnImpl: typeof spawnChild = options.shell ? spawnChild : (crossSpawn as typeof spawnChild);
  const child = spawnImpl(options.command, options.args, {
    cwd: options.cwd,
    detached: !windows,
    windowsHide: windows,
    env: sanitizedEnvironment(options.env),
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    shell: options.shell ?? false,
  });

  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let sweptOnExit = false;
  let taskkillStarted = false;
  const clearTimeoutTimer = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    if (windows) {
      if (!taskkillStarted) {
        taskkillStarted = true;
        taskkillProcessTree(child.pid);
      }
      return;
    }
    signalProcessGroup(child.pid, signal);
  };

  const killGroup = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    signalGroup(signal);
    if (windows || signal !== 'SIGTERM' || escalationTimer || !child.pid) return;
    escalationTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_ESCALATION_MS);
    escalationTimer.unref();
  };

  child.once('exit', () => {
    if (child.pid && !escalationTimer) {
      sweptOnExit = true;
      if (windows) signalGroup('SIGTERM');
      else terminateProcessGroup(child.pid);
    }
  });

  child.once('close', () => {
    clearTimeoutTimer();
    if (child.pid && !escalationTimer && !sweptOnExit) {
      if (windows) signalGroup('SIGTERM');
      else terminateProcessGroup(child.pid);
    }
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
