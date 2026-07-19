import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWsHub } from '../../src/api/wsHub.js';
import { EventLog } from '../../src/store/eventLog.js';
import { configureRunStore, saveRun } from '../../src/store/runs.js';
import { configureWorkspaceStore, createWorkspace } from '../../src/store/workspaces.js';
import { runSnapshot } from './helpers.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createApp(token?: string): Promise<{ app: FastifyInstance; log: EventLog }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mat-ws-'));
  dirs.push(dataDir);
  configureRunStore(dataDir);
  configureWorkspaceStore(dataDir);
  const app = fastify();
  apps.push(app);
  await app.register(websocket);
  const log = new EventLog(dataDir);
  registerWsHub(app, log, token ? { token } : {});
  await app.ready();
  return { app, log };
}

const partial = (runId: string, text: string) => ({
  runId,
  stageId: null,
  nodeRunId: null,
  attempt: 0,
  role: 'system' as const,
  kind: 'status' as const,
  text,
});

const nextMessage = (socket: { once(event: string, listener: (value: unknown) => void): void }): Promise<Record<string, unknown>> =>
  new Promise((resolve) => socket.once('message', (value) => resolve(JSON.parse(String(value)) as Record<string, unknown>)));

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('WebSocket hub', () => {
  it('broadcasts subscribed events only after the durable append and honors unsub', async () => {
    const { app, log } = await createApp();
    const socket = await app.injectWS('/ws');
    socket.send(JSON.stringify({ type: 'sub', runId: 'run-1' }));
    await tick();

    const received = nextMessage(socket);
    const appended = log.appendEvent('run-1', partial('run-1', 'one'));
    const message = await received;
    expect(message).toMatchObject({ type: 'event', event: { id: appended.id, seq: 1, text: 'one' } });
    expect(readFileSync(log.pathFor('run-1'), 'utf8')).toContain(appended.id);

    socket.send(JSON.stringify({ type: 'unsub', runId: 'run-1' }));
    await tick();
    let receivedAfterUnsub = false;
    socket.once('message', () => { receivedAfterUnsub = true; });
    log.appendEvent('run-1', partial('run-1', 'two'));
    await tick();
    expect(receivedAfterUnsub).toBe(false);
    socket.close();
  });

  it('keeps subscriptions isolated by run id', async () => {
    const { app, log } = await createApp();
    const socket = await app.injectWS('/ws');
    socket.send(JSON.stringify({ type: 'sub', runId: 'wanted' }));
    await tick();
    let count = 0;
    socket.on('message', () => { count += 1; });
    log.appendEvent('other', partial('other', 'skip'));
    await tick();
    expect(count).toBe(0);
    const received = nextMessage(socket);
    log.appendEvent('wanted', partial('wanted', 'send'));
    await expect(received).resolves.toMatchObject({ type: 'event', event: { runId: 'wanted' } });
    socket.close();
  });

  it('requires the query token only when configured', async () => {
    const open = await createApp();
    const openSocket = await open.app.injectWS('/ws');
    expect(openSocket.readyState).toBe(openSocket.OPEN);
    openSocket.close();

    const guarded = await createApp('secret');
    await expect(guarded.app.injectWS('/ws')).rejects.toThrow(/401/);
    await expect(guarded.app.injectWS('/ws?token=wrong')).rejects.toThrow(/401/);
    const authenticated = await guarded.app.injectWS('/ws?token=secret');
    expect(authenticated.readyState).toBe(authenticated.OPEN);
    authenticated.close();
  });

  it('pushes durable run snapshots and workspace invalidation pings', async () => {
    const { app } = await createApp();
    const socket = await app.injectWS('/ws');
    const workspacePing = nextMessage(socket);
    const workspace = await createWorkspace({ name: 'Temp', path: dirs.at(-1)! });
    await expect(workspacePing).resolves.toEqual({ type: 'workspaces' });

    socket.send(JSON.stringify({ type: 'sub', runId: 'run-1' }));
    await tick();
    const messages = new Promise<Record<string, unknown>[]>((resolve) => {
      const received: Record<string, unknown>[] = [];
      const listener = (value: unknown) => {
        received.push(JSON.parse(String(value)) as Record<string, unknown>);
        if (received.length === 2) { socket.off('message', listener); resolve(received); }
      };
      socket.on('message', listener);
    });
    await saveRun(runSnapshot({ workspaceId: workspace.id }));
    await expect(messages).resolves.toEqual(expect.arrayContaining([
      { type: 'workspaces' },
      expect.objectContaining({ type: 'run', run: expect.objectContaining({ runId: 'run-1' }) }),
    ]));
    socket.close();
  });

  it('broadcasts new run snapshots before clients know to subscribe', async () => {
    const { app } = await createApp();
    const socket = await app.injectWS('/ws');
    const received = nextMessage(socket);
    await saveRun(runSnapshot({ runId: 'brand-new' }));
    await expect(received).resolves.toMatchObject({ type: 'run', run: { runId: 'brand-new' } });
    socket.close();
  });
});
