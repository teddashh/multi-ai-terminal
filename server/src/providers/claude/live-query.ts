import type { AgentQueryStream, AgentSdkModule } from './sdk-loader.js';

export interface LiveQueryConfig {
  sdk: AgentSdkModule;
  queryOptions: Record<string, unknown>;
  onMessage: (msg: Record<string, unknown>) => void;
  onError?: (err: unknown) => void;
}

interface TurnDeferred {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class LiveQuery {
  private readonly queue: Record<string, unknown>[] = [];
  private waker: (() => void) | undefined;
  private closed = false;
  private readonly turnDeferreds: TurnDeferred[] = [];
  private readonly onMessage: LiveQueryConfig['onMessage'];
  private readonly onError: NonNullable<LiveQueryConfig['onError']>;
  private readonly generator: AgentQueryStream;
  private readonly loopPromise: Promise<void>;

  constructor(config: LiveQueryConfig) {
    if (!config?.sdk || typeof config.sdk.query !== 'function') {
      throw new Error('LiveQuery: sdk.query is required');
    }
    if (typeof config.onMessage !== 'function') {
      throw new Error('LiveQuery: onMessage callback is required');
    }
    this.onMessage = config.onMessage;
    this.onError = typeof config.onError === 'function' ? config.onError : () => undefined;

    const thisQuery = this;
    const prompt: AsyncIterable<Record<string, unknown>> = {
      [Symbol.asyncIterator]: async function* (this: void) {
        while (!thisQuery.closed) {
          if (thisQuery.queue.length > 0) {
            yield thisQuery.queue.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => { thisQuery.waker = resolve; });
          thisQuery.waker = undefined;
        }
      },
    };
    this.generator = config.sdk.query({ prompt, options: config.queryOptions });
    this.loopPromise = this.drain();
  }

  get isClosed(): boolean { return this.closed; }

  push(userMessage: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('LiveQuery is closed'));
    return new Promise((resolve, reject) => {
      this.turnDeferreds.push({ resolve, reject });
      this.queue.push(userMessage);
      this.waker?.();
    });
  }

  async interrupt(): Promise<unknown> { return this.control('interrupt', []); }
  async setModel(model: string): Promise<unknown> { return this.control('setModel', [model]); }
  async setPermissionMode(mode: string): Promise<unknown> { return this.control('setPermissionMode', [mode]); }
  async stopTask(taskId: string): Promise<unknown> { return this.control('stopTask', [taskId]); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waker?.();
    this.waker = undefined;
    try { this.generator.close?.(); } catch { /* best-effort SDK teardown */ }
    this.rejectPending(new Error('LiveQuery is closed'));
  }

  private async control(method: 'interrupt' | 'setModel' | 'setPermissionMode' | 'stopTask', args: string[]): Promise<unknown> {
    if (this.closed) throw new Error('LiveQuery is closed');
    const control = this.generator[method] as ((argument?: string) => Promise<unknown>) | undefined;
    if (typeof control !== 'function') throw new Error(`${method} not supported by this SDK build`);
    return control.call(this.generator, ...args);
  }

  private async drain(): Promise<void> {
    try {
      for await (const message of this.generator) {
        if (this.closed) break;
        try { this.onMessage(message); } catch (error) { this.onError(error); }
        // Object-guarded like BAT: a malformed frame must not throw here and
        // tear down the whole query.
        if (message && typeof message === 'object' && message.type === 'result') this.turnDeferreds.shift()?.resolve(message);
      }
    } catch (error) {
      this.onError(error);
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.closed = true;
      this.waker?.();
      this.waker = undefined;
      this.rejectPending(new Error('LiveQuery closed before turn completed'));
    }
  }

  private rejectPending(error: Error): void {
    for (const deferred of this.turnDeferreds) deferred.reject(error);
    this.turnDeferreds.length = 0;
  }
}
