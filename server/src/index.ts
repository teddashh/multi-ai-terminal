import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { registerApiRoutes } from './api/routes.js';
import { resolveDataDir } from './store/dataDir.js';
import { configureEventLog } from './store/eventLog.js';

export interface ServerOptions { port: number; host: string; dataDir: string | undefined; token: string | undefined }

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const options: ServerOptions = { port: 7788, host: '127.0.0.1', dataDir: undefined, token: undefined };
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
  options.dataDir ??= env.MAT_DATA_DIR;
  options.token ??= env.MAT_TOKEN;
  return options;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const dataDir = resolveDataDir({ dataDir: options.dataDir });
  configureEventLog(dataDir);
  await app.register(websocket);

  if (options.token) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/api/') && request.headers.authorization !== `Bearer ${options.token}`) {
        await reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' } });
      }
    });
  }

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  await registerApiRoutes(app);

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  }
  return app;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const app = await buildServer(options);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await app.listen({ port: options.port, host: options.host });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) void main();
