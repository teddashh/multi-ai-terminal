import { describe, expect, it } from 'vitest';
import { PROVIDER_COLORS } from './AgentChip.js';

describe('AgentChip provider colors', () => {
  it('gives OpenRouter its own provider color', () => {
    expect(PROVIDER_COLORS.openrouter).toBe('#6366f1');
    expect(PROVIDER_COLORS.openrouter).not.toBe(PROVIDER_COLORS.codex);
    expect(PROVIDER_COLORS.openrouter).not.toBe(PROVIDER_COLORS.mock);
  });
});
