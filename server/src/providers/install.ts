import type { ProviderId } from '@mat/shared';

export interface ProviderInstallRecipe { command: string; args: string[] }
export interface ProviderInstallPlan { recipe?: ProviderInstallRecipe; manualCommand?: string }

const npmRecipes: Record<'claude' | 'codex' | 'grok', ProviderInstallRecipe> = {
  claude: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
  codex: { command: 'npm', args: ['install', '-g', '@openai/codex'] },
  grok: { command: 'npm', args: ['install', '-g', '@xai-official/grok'] },
};

export function providerInstallPlan(providerId: ProviderId, platform: NodeJS.Platform = process.platform): ProviderInstallPlan {
  if (providerId === 'claude' || providerId === 'codex' || providerId === 'grok') return { recipe: { ...npmRecipes[providerId], args: [...npmRecipes[providerId].args] } };
  if (providerId === 'agy') {
    return platform === 'win32'
      ? { recipe: { command: 'winget', args: ['install', '-e', '--id', 'Google.AntigravityCLI', '--accept-source-agreements', '--accept-package-agreements'] } }
      : { manualCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' };
  }
  return {};
}

export function providerInstallTimeoutMs(providerId: ProviderId): number {
  // winget may spend several minutes acquiring and verifying Antigravity on a
  // first install. The npm recipes normally complete within the original cap.
  return providerId === 'agy' ? 10 * 60 * 1000 : 5 * 60 * 1000;
}

export function providerUpdatePlan(providerId: ProviderId, platform: NodeJS.Platform = process.platform): ProviderInstallPlan {
  // claude ships its own updater that detects how it was installed (npm or the
  // native installer); prefer it over blindly reinstalling one method.
  if (providerId === 'claude') return { recipe: { command: 'claude', args: ['update'] } };
  // The npm recipes install @latest, so rerunning them is the update. winget
  // likewise upgrades an already-installed Antigravity to the newest version.
  return providerInstallPlan(providerId, platform);
}
