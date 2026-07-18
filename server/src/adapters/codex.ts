import type { Adapter } from './base.js';
export const codexAdapter: Adapter = { id: 'codex', tier: 'rich', models: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol', async available() { return { ok: false, detail: 'stub' }; }, spawn() { throw new Error('NOT_IMPLEMENTED: adapters/codex'); } };
