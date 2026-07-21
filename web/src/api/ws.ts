import { WsServerMsgSchema, type WsClientMsg, type WsServerMsg } from '@mat/shared';
import { apiClient, type ApiClient } from './client.js';

export type WsCatchUpUpdate =
  | { runId: string; status: 'started'; afterSeq: number }
  | { runId: string; status: 'synchronized' | 'failed' };

export interface ReconnectingWsOptions {
  url?: string;
  token?: string | (() => string | undefined);
  api?: ApiClient;
  onMessage(message: WsServerMsg): void;
  onStateChange?(state: 'connecting'|'open'|'closed'): void;
  onCatchUpState?(update: WsCatchUpUpdate): void;
}

export class ReconnectingWsClient {
  readonly #subscriptions = new Set<string>();
  readonly #lastSeq = new Map<string, number>();
  readonly #catchUpGeneration = new Map<string, number>();
  readonly #activeCatchUps = new Map<string, number>();
  readonly #api: ApiClient;
  #socket: WebSocket | undefined;
  #timer: number | undefined;
  #attempt = 0;
  #closed = true;
  constructor(private readonly options: ReconnectingWsOptions) { this.#api = options.api ?? apiClient; }

  connect(): void { if (!this.#closed || this.#socket) return; this.#closed = false; this.#open(); }
  close(): void { this.#closed = true; if (this.#timer !== undefined) window.clearTimeout(this.#timer); this.#socket?.close(); this.#socket = undefined; this.options.onStateChange?.('closed'); }
  subscribe(runId: string): void {
    if (this.#subscriptions.has(runId)) return;
    this.#subscriptions.add(runId);
    this.#send({ type: 'sub', runId });
    if (this.#socket?.readyState === WebSocket.OPEN) void this.#catchUp(runId);
  }
  unsubscribe(runId: string): void {
    this.#subscriptions.delete(runId);
    this.#catchUpGeneration.set(runId, (this.#catchUpGeneration.get(runId) ?? 0) + 1);
    if (this.#activeCatchUps.delete(runId)) this.options.onCatchUpState?.({ runId, status: 'failed' });
    this.#send({ type: 'unsub', runId });
  }

  #open(): void {
    if (this.#closed) return;
    this.options.onStateChange?.('connecting');
    const token = typeof this.options.token === 'function' ? this.options.token() : (this.options.token ?? this.#api.token);
    const fallback = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    const url = new URL(this.options.url ?? fallback, location.href);
    if (token) url.searchParams.set('token', token);
    const socket = new WebSocket(url);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      this.#attempt = 0; this.options.onStateChange?.('open');
      for (const runId of this.#subscriptions) { this.#send({ type: 'sub', runId }); void this.#catchUp(runId); }
    });
    socket.addEventListener('message', (event) => {
      try {
        const parsed = WsServerMsgSchema.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        if (parsed.data.type === 'event') this.#lastSeq.set(parsed.data.event.runId, Math.max(this.#lastSeq.get(parsed.data.event.runId) ?? 0, parsed.data.event.seq));
        this.options.onMessage(parsed.data as WsServerMsg);
      } catch { /* Ignore malformed frames; reconnect/catch-up remains authoritative. */ }
    });
    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.options.onStateChange?.('closed');
      if (!this.#closed) this.#timer = window.setTimeout(() => this.#open(), Math.min(10_000, 250 * 2 ** this.#attempt++));
    });
  }

  #send(message: WsClientMsg): void { if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message)); }
  async #catchUp(runId: string): Promise<void> {
    let cursor = this.#lastSeq.get(runId) ?? 0;
    const generation = (this.#catchUpGeneration.get(runId) ?? 0) + 1;
    this.#catchUpGeneration.set(runId, generation);
    this.#activeCatchUps.set(runId, generation);
    this.options.onCatchUpState?.({ runId, status: 'started', afterSeq: cursor });
    try {
      for (;;) {
        const before = cursor;
        const events = await this.#api.getEvents(runId, cursor, 1000);
        if (this.#closed || this.#catchUpGeneration.get(runId) !== generation) return;
        for (const event of events) {
          cursor = Math.max(cursor, event.seq); this.#lastSeq.set(runId, cursor);
          this.options.onMessage({ type: 'event', event });
        }
        if (events.length < 1000) {
          this.#activeCatchUps.delete(runId);
          this.options.onCatchUpState?.({ runId, status: 'synchronized' });
          return;
        }
        if (cursor === before) {
          this.#activeCatchUps.delete(runId);
          this.options.onCatchUpState?.({ runId, status: 'failed' });
          return;
        }
      }
    } catch {
      if (!this.#closed && this.#catchUpGeneration.get(runId) === generation) {
        this.#activeCatchUps.delete(runId);
        this.options.onCatchUpState?.({ runId, status: 'failed' });
      }
    }
  }
}
