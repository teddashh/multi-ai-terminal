import type { Adapter } from './base.js';
export const grokAdapter: Adapter = { id: 'grok', tier: 'rich', models: ['grok-4.5'], defaultModel: 'grok-4.5', async available() { return { ok: false, detail: 'stub' }; }, spawn() { throw new Error('NOT_IMPLEMENTED: adapters/grok'); } };
