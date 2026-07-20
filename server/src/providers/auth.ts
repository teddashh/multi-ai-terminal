export interface ProviderAuthAlert {
  message: string;
  at: number;
  runId: string;
  nodeRunId: string;
}

const alerts = new Map<string, ProviderAuthAlert>();
const commands: Readonly<Record<string, string>> = {
  codex: 'codex logout && codex login',
  claude: 'claude   (then /login inside the session)',
  grok: 'grok login   (browser) · grok login --device-code (headless) · or set XAI_API_KEY',
  agy: 'agy   (sign-in starts automatically; /logout to clear)',
};

export function setAuthAlert(providerId: string, message: string, runId: string, nodeRunId: string): ProviderAuthAlert | undefined {
  if (providerId === 'mock') return undefined;
  const alert = { message, at: Date.now(), runId, nodeRunId };
  alerts.set(providerId, alert);
  return alert;
}

export function clearAuthAlert(providerId: string): void { alerts.delete(providerId); }
export function getAuthAlert(providerId: string): ProviderAuthAlert | undefined { return alerts.get(providerId); }
export function clearAllAuthAlerts(): void { alerts.clear(); }
export function signInCommand(providerId: string): string | undefined { return commands[providerId]; }
