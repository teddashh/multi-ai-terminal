import { spawnAgy } from '../providers/agy/runtime.js';
import { AGY_MODELS, buildAgyArgs, resolveAgyModel } from '../providers/agy/transport.js';
import { probeVersion, type Adapter } from './base.js';

export { spawnAgy };
export { AGY_MODELS, buildAgyArgs, resolveAgyModel };

export const agyAdapter: Adapter = {
  id: 'agy',
  tier: 'plain',
  models: AGY_MODELS,
  defaultModel: 'Gemini 3.1 Pro (High)',
  available: () => probeVersion('agy'),
  spawn: spawnAgy,
};

export default agyAdapter;
