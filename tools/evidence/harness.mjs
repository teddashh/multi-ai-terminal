import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const closedChildren = new WeakSet();

/**
 * Build the minimal environment used by a black-box server child.
 *
 * The evidence lane is POSIX-only. Provider commands are deterministic failing
 * stubs; git and node are the only host tools exposed to product subprocesses.
 */
export function isolatedServerEnvironment({
  harnessRoot,
  dataDir,
  port = 0,
}) {
  const home = join(harnessRoot, 'home');
  const bin = join(harnessRoot, 'bin');
  for (const directory of [
    dataDir,
    home,
    bin,
    join(home, 'codex-home'),
    join(home, 'xdg-cache'),
    join(home, 'xdg-config'),
    join(home, 'xdg-data'),
  ]) mkdirSync(directory, { recursive: true });

  for (const command of ['git', 'which']) {
    const resolved = execFileSync('which', [command], { encoding: 'utf8' }).trim();
    symlinkSync(resolved, join(bin, command));
  }
  symlinkSync(process.execPath, join(bin, 'node'));
  const unavailable = join(bin, 'provider-unavailable');
  writeFileSync(
    unavailable,
    '#!/bin/sh\necho deterministic-provider-unavailable >&2\nexit 7\n',
    { encoding: 'utf8', mode: 0o755 },
  );
  chmodSync(unavailable, 0o755);
  for (const command of ['agy', 'claude', 'codex', 'grok']) {
    symlinkSync(unavailable, join(bin, command));
  }

  return {
    HOME: home,
    CODEX_HOME: join(home, 'codex-home'),
    XDG_CACHE_HOME: join(home, 'xdg-cache'),
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    PATH: bin,
    MAT_PORT: String(port),
    MAT_HOST: '127.0.0.1',
    MAT_DATA_DIR: dataDir,
    MAT_SELF_PROVISION: '0',
    MAT_CLAUDE_BIN: unavailable,
    MAT_CODEX_BIN: unavailable,
    MAT_NODE_BIN: process.execPath,
  };
}

export async function fetchWithTimeout(url, init, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function waitForClose(child, timeoutMs) {
  if (closedChildren.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

async function stopProcessTree(child, timeoutMs = 5_000) {
  if (!child || closedChildren.has(child)) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForClose(child, timeoutMs)) return;
  signalProcessTree(child, 'SIGKILL');
  if (!await waitForClose(child, 2_000)) {
    throw new Error(`server process tree ${String(child.pid)} did not close after SIGKILL`);
  }
}

/**
 * Spawn one server in a private process group. `ready` resolves only from this
 * child's stdout marker, never from an unrelated service on the requested port.
 */
export function launchEvidenceServer({
  root,
  env,
  onOutput = () => undefined,
  readyTimeoutMs = 15_000,
}) {
  const child = spawn(process.execPath, [join(root, 'server', 'dist', 'index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.once('close', () => closedChildren.add(child));
  let stdout = '';
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(
      `server exited before READY (${signal ? `signal ${signal}` : `code ${String(code)}`})`,
    ));
    const timer = setTimeout(
      () => finish(new Error('timeout waiting for this server child READY marker')),
      readyTimeoutMs,
    );
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput(text);
      const marker = /\[MAT_AGENT\] READY url=(http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (marker) finish(undefined, marker[1].replace(/\/$/, ''));
    });
    child.stderr.on('data', (chunk) => onOutput(chunk.toString()));
  });
  return {
    child,
    ready,
    stop: () => stopProcessTree(child),
  };
}
