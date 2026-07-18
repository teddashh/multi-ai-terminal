import type { FastifyInstance } from 'fastify';
import { listProviders } from '../adapters/registry.js';

const notImplemented = (module: string) => ({ error: { code: 'NOT_IMPLEMENTED', message: `NOT_IMPLEMENTED: ${module}` } });

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/providers', async () => listProviders());

  const routes: Array<{ method: 'GET'|'POST'|'PATCH'|'DELETE'; url: string; module: string }> = [
    { method: 'GET', url: '/api/workspaces', module: 'api/workspaces.list' },
    { method: 'POST', url: '/api/workspaces', module: 'api/workspaces.create' },
    { method: 'GET', url: '/api/workspaces/:id', module: 'api/workspaces.get' },
    { method: 'PATCH', url: '/api/workspaces/:id', module: 'api/workspaces.update' },
    { method: 'DELETE', url: '/api/workspaces/:id', module: 'api/workspaces.delete' },
    { method: 'GET', url: '/api/workflows', module: 'api/workflows.list' },
    { method: 'POST', url: '/api/workflows', module: 'api/workflows.create' },
    { method: 'PATCH', url: '/api/workflows/:id', module: 'api/workflows.update' },
    { method: 'DELETE', url: '/api/workflows/:id', module: 'api/workflows.delete' },
    { method: 'POST', url: '/api/workflows/:id/duplicate', module: 'api/workflows.duplicate' },
    { method: 'POST', url: '/api/runs', module: 'api/runs.create' },
    { method: 'GET', url: '/api/runs', module: 'api/runs.list' },
    { method: 'GET', url: '/api/runs/:id', module: 'api/runs.get' },
    { method: 'GET', url: '/api/runs/:id/events', module: 'api/runs.events' },
    { method: 'GET', url: '/api/runs/:id/patches/:nodeRunId', module: 'api/runs.patch' },
    { method: 'POST', url: '/api/runs/:id/abort', module: 'api/runs.abort' },
    { method: 'POST', url: '/api/runs/:id/nodes/:nodeRunId/kill', module: 'api/runs.killNode' },
    { method: 'POST', url: '/api/runs/:id/stages/:stageId/retry', module: 'api/runs.retryStage' },
    { method: 'POST', url: '/api/runs/:id/nodes/:nodeRunId/apply-patch', module: 'api/runs.applyPatch' },
    { method: 'DELETE', url: '/api/runs/:id', module: 'api/runs.delete' },
  ];
  for (const route of routes) {
    app.route({ method: route.method, url: route.url, handler: async (_request, reply) => reply.code(501).send(notImplemented(route.module)) });
  }
}
