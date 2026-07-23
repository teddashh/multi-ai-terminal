import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, win32 } from 'node:path';
import crossSpawn from 'cross-spawn';

export interface SpawnProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  /** Keep stdin piped and open for later writes instead of ignore/auto-end. */
  stdinOpen?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Remove inherited variables from the final child environment. */
  unsetEnv?: string[];
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
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

let cachedPathAdditions: string[] | undefined;

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

export function augmentedPathEnv(options: EnvironmentOptions = {}): NodeJS.ProcessEnv {
  const cacheable = Object.keys(options).length === 0;
  const platform = options.platform ?? process.platform;
  const delimiter = options.delimiter ?? pathDelimiter;
  const source = options.env ?? process.env;
  const env = { ...source };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? (platform === 'win32' ? 'Path' : 'PATH');
  const entries = (env[pathKey] ?? '').split(delimiter).filter(Boolean);
  const exists = options.exists ?? existsSync;
  const additions = cacheable && cachedPathAdditions
    ? cachedPathAdditions
    : (platform === 'win32'
      ? [
        environmentValue(env, 'LOCALAPPDATA')
          ? win32.join(environmentValue(env, 'LOCALAPPDATA')!, 'Programs', 'OpenAI', 'Codex', 'bin')
          : undefined,
        environmentValue(env, 'LOCALAPPDATA') ? win32.join(environmentValue(env, 'LOCALAPPDATA')!, 'Antigravity') : undefined,
        environmentValue(env, 'APPDATA') ? win32.join(environmentValue(env, 'APPDATA')!, 'npm') : undefined,
        environmentValue(env, 'USERPROFILE') ? win32.join(environmentValue(env, 'USERPROFILE')!, '.local', 'bin') : undefined,
      ]
      : [`${options.homedir ?? homedir()}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin']).filter((addition): addition is string => addition !== undefined && exists(addition));
  if (cacheable && !cachedPathAdditions) cachedPathAdditions = [...additions];
  for (const addition of additions) {
    const normalized = platform === 'win32' ? addition.toLowerCase() : addition;
    if (!entries.some((entry) => (platform === 'win32' ? entry.toLowerCase() : entry) === normalized)) entries.push(addition);
  }
  env[pathKey] = entries.join(delimiter);
  return env;
}

export function clearAugmentedPathCache(): void {
  cachedPathAdditions = undefined;
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
  const env = { ...(options.env ?? process.env), ...overrides };
  delete env.LD_LIBRARY_PATH;

  const overridePathKey = Object.keys(overrides).find((key) => key.toLowerCase() === 'path');
  const inheritedPathKey = Object.keys(options.env ?? process.env).find((key) => key.toLowerCase() === 'path');
  const pathKey = platform === 'win32'
    ? (overridePathKey ?? inheritedPathKey ?? 'Path')
    : 'PATH';
  const pathValue = overridePathKey
    ? overrides[overridePathKey]
    : inheritedPathKey
      ? (options.env ?? process.env)[inheritedPathKey]
      : undefined;

  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
  }

  if (pathValue !== undefined) env[pathKey] = pathValue;
  return env;
}

export function spawnManaged(options: SpawnProcessOptions): ManagedProcess {
  const windows = process.platform === 'win32';
  // cross-spawn's Windows ENOENT heuristic treats any shell exit code 1 as
  // command-not-found (parsed.file is never set when shell is true) and swallows
  // the real exit event. Shell commands need no .cmd/PATHEXT shim, so bypass it.
  const spawnImpl: typeof spawnChild = options.shell ? spawnChild : (crossSpawn as typeof spawnChild);
  const baseEnv = augmentedPathEnv();
  const explicitPathKey = Object.keys(options.env ?? {}).find((key) => key.toLowerCase() === 'path');
  if (explicitPathKey) for (const key of Object.keys(baseEnv)) if (key.toLowerCase() === 'path') delete baseEnv[key];
  const childEnv = sanitizedEnvironment({ ...baseEnv, ...options.env });
  for (const key of options.unsetEnv ?? []) delete childEnv[key];
  const child = spawnImpl(options.command, options.args, {
    cwd: options.cwd,
    detached: !windows,
    windowsHide: windows,
    env: childEnv,
    stdio: [options.stdin === undefined && options.stdinOpen !== true ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
