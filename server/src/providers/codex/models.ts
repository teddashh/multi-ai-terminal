export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

export interface CodexModelInfo { value: string; displayName: string; description: string }

export const CODEX_MODELS: readonly CodexModelInfo[] = [
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Newest frontier - recommended (ChatGPT login)' },
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Previous frontier GPT-5.5' },
  { value: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Flagship GPT-5.4' },
  { value: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: 'Fast GPT-5.4' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'GPT-5.3 - codex variant' },
  { value: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark', description: 'GPT-5.3 - lightweight codex' },
  { value: 'codex-mini-latest', displayName: 'Codex Mini', description: 'codex-mini - optimized for code' },
  { value: 'o4-mini', displayName: 'o4-mini', description: 'OpenAI o4-mini - fast reasoning' },
  { value: 'o3', displayName: 'o3', description: 'OpenAI o3 - reasoning model' },
  { value: 'gpt-4.1', displayName: 'GPT-4.1', description: 'OpenAI GPT-4.1' },
] as const;

export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;

export function contextWindowForModel(model: string): number {
  return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].includes(model) ? 353_400 : 1_000_000;
}
