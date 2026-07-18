import { WsClientMsgSchema, type AgentEvent, type RunSnapshot, type WsServerMsg } from '@mat/shared';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { EventLog } from '../store/eventLog.js';
import { subscribeRunChanges } from '../store/runs.js';
import { subscribeWorkspaceChanges } from '../store/workspaces.js';

export interface WsHub { broadcastEvent(event: AgentEvent): void; broadcastRun(run: RunSnapshot): void; close(): void }
export interface WsHubOptions { token?: string }

interface ClientState {
  socket: WebSocket;
  subscriptions: Set<string>;
  alive: boolean;
}

export function registerWsHub(app: FastifyInstance, eventLog: EventLog, options: WsHubOptions = {}): WsHub {
  const clients = new Set<ClientState>();
  let closed = false;

  const send = (client: ClientState, message: WsServerMsg): void => {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try { client.socket.send(JSON.stringify(message)); }
    catch { cleanup(client); }
  };

  const cleanup = (client: ClientState): void => {
    client.subscriptions.clear();
    clients.delete(client);
  };

  const hub: WsHub = {
    broadcastEvent(event) {
      for (const client of clients) if (client.subscriptions.has(event.runId)) send(client, { type: 'event', event });
    },
    broadcastRun(run) {
      for (const client of clients) if (client.subscriptions.has(run.runId)) send(client, { type: 'run', run });
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribeEvents();
      unsubscribeRuns();
      unsubscribeWorkspaces();
      for (const client of [...clients]) {
        cleanup(client);
        try { client.socket.close(1001, 'Server shutting down'); } catch { client.socket.terminate(); }
      }
    },
  };

  const unsubscribeEvents = eventLog.subscribe((event) => hub.broadcastEvent(event));
  const unsubscribeRuns = subscribeRunChanges((run) => hub.broadcastRun(run));
  const unsubscribeWorkspaces = subscribeWorkspaceChanges(() => {
    for (const client of clients) send(client, { type: 'workspaces' });
  });

  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      if (!client.alive) {
        cleanup(client);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try { client.socket.ping(); } catch { cleanup(client); client.socket.terminate(); }
    }
  }, 30_000);
  heartbeat.unref();

  app.get('/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!options.token) return;
      const query = request.query as { token?: unknown };
      if (query.token !== options.token) {
        await reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid WebSocket token is required' } });
      }
    },
  }, (socket) => {
    if (closed) { socket.close(1012, 'Server restarting'); return; }
    const client: ClientState = { socket, subscriptions: new Set(), alive: true };
    clients.add(client);
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', (raw: unknown) => {
      try {
        const parsed = WsClientMsgSchema.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) { socket.close(1008, 'Invalid subscription message'); return; }
        if (parsed.data.type === 'sub') client.subscriptions.add(parsed.data.runId);
        else client.subscriptions.delete(parsed.data.runId);
      } catch {
        socket.close(1008, 'Invalid subscription message');
      }
    });
    socket.on('close', () => cleanup(client));
    socket.on('error', () => cleanup(client));
  });

  app.addHook('onClose', async () => hub.close());
  return hub;
}
