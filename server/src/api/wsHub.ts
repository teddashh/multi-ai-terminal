import type { AgentEvent, RunSnapshot } from '@mat/shared';
import type { FastifyInstance } from 'fastify';
import type { EventLog } from '../store/eventLog.js';

export interface WsHub { broadcastEvent(event: AgentEvent): void; broadcastRun(run: RunSnapshot): void; close(): void }
export function registerWsHub(_app: FastifyInstance, _eventLog: EventLog): WsHub {
  throw new Error('NOT_IMPLEMENTED: api/wsHub');
}
