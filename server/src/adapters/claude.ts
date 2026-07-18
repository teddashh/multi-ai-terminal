import type { Adapter } from './base.js';
export const claudeAdapter: Adapter = { id: 'claude', tier: 'rich', models: ['sonnet', 'opus', 'haiku'], defaultModel: 'sonnet', async available() { return { ok: false, detail: 'stub' }; }, spawn() { throw new Error('NOT_IMPLEMENTED: adapters/claude'); } };
