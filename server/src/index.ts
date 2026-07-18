import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { registerApiRoutes, type ApiRouteDependencies } from './api/routes.js';
import { registerWsHub } from './api/wsHub.js';
import { abortRun, sweepOnBoot } from './engine/runManager.js';
import { pruneWorktrees } from './engine/worktree.js';
import { resolveDataDir } from './store/dataDir.js';
import { configureEventLog } from './store/eventLog.js';
import { configureRunStore, listRuns } from './store/runs.js';
import { configureWorkflowStore } from './store/workflows.js';
import { configureWorkspaceStore } from './store/workspaces.js';

export interface ServerOptions { port: number; host: string; dataDir: string | undefined; token: string | undefined }

export interface BuildServerDependencies {
  sweepOnBoot: typeof sweepOnBoot;
  abortRun: typeof abortRun;
  api?: ApiRouteDependencies;
  webDist?: string;
  cleanupRun: typeof pruneWorktrees;
}

const defaultBuildDependencies: BuildServerDependencies = {
  sweepOnBoot,
  abortRun,
  cleanupRun: pruneWorktrees,
};

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const envPort = env.MAT_PORT === undefined ? 7788 : Number(env.MAT_PORT);
  const options: ServerOptions = {
    port: envPort,
    host: env.MAT_HOST ?? '127.0.0.1',
    dataDir: env.MAT_DATA_DIR,
    token: env.MAT_TOKEN,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--port' && value) { options.port = Number(value); index += 1; }
    else if (flag === '--host' && value) { options.host = value; index += 1; }
    else if (flag === '--data-dir' && value) { options.dataDir = value; index += 1; }
    else if (flag === '--token' && value) { options.token = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error(`Invalid port: ${options.port}`);
  if (!options.host.trim()) throw new Error('Invalid host: host cannot be empty');
  return options;
}

export async function buildServer(
  options: ServerOptions,
  overrides: Partial<BuildServerDependencies> = {},
): Promise<FastifyInstance> {
  const dependencies = { ...defaultBuildDependencies, ...overrides };
  const app = fastify({ logger: false });
  const dataDir = resolveDataDir({ dataDir: options.dataDir });

  configureWorkspaceStore(dataDir);
  configureWorkflowStore(dataDir);
  configureRunStore(dataDir, { cleanupRun: dependencies.cleanupRun });
  const eventLog = configureEventLog(dataDir);

  await dependencies.sweepOnBoot();

  // The websocket plugin must decorate Fastify before any websocket route is declared.
  await app.register(websocket);

  if (options.token) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/api/') && request.headers.authorization !== `Bearer ${options.token}`) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' } });
      }
    });
  }

  await registerApiRoutes(app, dependencies.api);
  registerWsHub(app, eventLog, options.token ? { token: options.token } : {});

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = dependencies.webDist ?? resolve(here, '../../web/dist');
  if (existsSync(webDist)) await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler(async (request, reply) => {
    if (existsSync(webDist) && request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/ws')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  return app;
}

async function stopEngine(abort: typeof abortRun): Promise<void> {
  const activeRuns = (await listRuns(undefined, Number.MAX_SAFE_INTEGER)).filter((run) => !['done', 'failed', 'aborted'].includes(run.status));
  await Promise.allSettled(activeRuns.map((run) => abort(run.runId)));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const app = await buildServer(options);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopEngine(abortRun);
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await app.listen({ port: options.port, host: options.host });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) void main();
