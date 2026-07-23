import { spawnGrok } from '../providers/grok/runtime.js';
import { buildGrokArgs } from '../providers/grok/transport.js';
import { probeVersion, type Adapter } from './base.js';

export { spawnGrok };
export { buildGrokArgs };

export const grokAdapter: Adapter = {
  id: 'grok',
  tier: 'rich',
  models: ['grok-4.5'],
  defaultModel: 'grok-4.5',
  available: () => probeVersion('grok'),
  spawn: spawnGrok,
};

export default grokAdapter;
