import { disposeAgySessionRuntime } from './agy/runtime.js';
import { disposeClaudeSessionRuntime } from './claude/runtime.js';
import { disposeCodexSessionRuntime } from './codex/runtime.js';
import { disposeGrokSessionRuntime } from './grok/runtime.js';
import { disposeOpenRouterSessionRuntime } from './openrouter/runtime.js';

/**
 * Release persistent provider children and subscriptions during server exit.
 * Each disposer is singleton-aware and will not initialize an unused runtime.
 */
export async function disposeProviderRuntimes(): Promise<void> {
  disposeAgySessionRuntime();
  disposeGrokSessionRuntime();
  await Promise.allSettled([
    disposeClaudeSessionRuntime(),
    disposeCodexSessionRuntime(),
    disposeOpenRouterSessionRuntime(),
  ]);
}
