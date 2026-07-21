import type { AgentEvent, ApplyPatchResponse, ProviderInfo, ProviderInstallResponse, RetryStageRequest, RunCreateRequest, RunSnapshot, SteerRequest, WorkflowDef, Workspace } from '@mat/shared';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'HTTP_ERROR') { super(message); }
}

export interface ApiClientOptions { baseUrl?: string; token?: string | (() => string | undefined) }

export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string | (() => string | undefined) | undefined;
  constructor(options: ApiClientOptions = {}) { this.#baseUrl = options.baseUrl ?? ''; this.#token = options.token; }

  get token(): string | undefined { return typeof this.#token === 'function' ? this.#token() : this.#token; }
  health(): Promise<{ ok: boolean; version: string }> { return this.request('/api/health'); }
  getProviders(): Promise<ProviderInfo[]> { return this.request('/api/providers'); }
  installProvider(id: string): Promise<ProviderInstallResponse> { return this.request(`/api/providers/${encodeURIComponent(id)}/install`, { method: 'POST' }); }
  getWorkspaces(): Promise<Workspace[]> { return this.request('/api/workspaces'); }
  getWorkspace(id: string): Promise<Workspace> { return this.request(`/api/workspaces/${encodeURIComponent(id)}`); }
  createWorkspace(value: { name: string; path: string; defaultWorkflowId?: string; verifyCommand?: string; verifyTimeoutSec?: number }): Promise<Workspace> { return this.request('/api/workspaces', { method: 'POST', body: value }); }
  updateWorkspace(id: string, value: Partial<Pick<Workspace, 'name'|'path'|'defaultWorkflowId'>> & { verifyCommand?: string | null; verifyTimeoutSec?: number | null }): Promise<Workspace> { return this.request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: value }); }
  deleteWorkspace(id: string): Promise<void> { return this.request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  getWorkflows(): Promise<WorkflowDef[]> { return this.request('/api/workflows'); }
  createWorkflow(value: WorkflowDef): Promise<WorkflowDef> { return this.request('/api/workflows', { method: 'POST', body: value }); }
  updateWorkflow(id: string, value: Partial<WorkflowDef>): Promise<WorkflowDef> { return this.request(`/api/workflows/${encodeURIComponent(id)}`, { method: 'PATCH', body: value }); }
  deleteWorkflow(id: string): Promise<void> { return this.request(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  duplicateWorkflow(id: string): Promise<WorkflowDef> { return this.request(`/api/workflows/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }); }
  createRun(value: RunCreateRequest): Promise<RunSnapshot> { return this.request('/api/runs', { method: 'POST', body: value }); }
  getRuns(query: { workspaceId?: string; limit?: number; before?: number } = {}): Promise<RunSnapshot[]> { return this.request(`/api/runs${queryString(query)}`); }
  getRun(id: string): Promise<RunSnapshot> { return this.request(`/api/runs/${encodeURIComponent(id)}`); }
  getEvents(id: string, afterSeq = 0, limit = 1000): Promise<AgentEvent[]> { return this.request(`/api/runs/${encodeURIComponent(id)}/events${queryString({ afterSeq, limit })}`); }
  getReport(id: string): Promise<string> { return this.request(`/api/runs/${encodeURIComponent(id)}/report`, { response: 'text' }); }
  getDebugBundle(id: string): Promise<Blob> { return this.request(`/api/runs/${encodeURIComponent(id)}/debug-bundle`, { response: 'blob' }); }
  getPatch(id: string, nodeRunId: string): Promise<string> { return this.request(`/api/runs/${encodeURIComponent(id)}/patches/${encodeURIComponent(nodeRunId)}`, { response: 'text' }); }
  abortRun(id: string): Promise<RunSnapshot> { return this.request(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' }); }
  killNode(id: string, nodeRunId: string): Promise<RunSnapshot> { return this.request(`/api/runs/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeRunId)}/kill`, { method: 'POST' }); }
  retryStage(id: string, stageId: string, value: RetryStageRequest = {}): Promise<RunSnapshot> { return this.request(`/api/runs/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageId)}/retry`, { method: 'POST', body: value }); }
  steerRun(id: string, value: SteerRequest): Promise<RunSnapshot> { return this.request(`/api/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', body: value }); }
  clientLog(value: { level: 'error'|'warn'; message: string; stack?: string; url?: string }): Promise<void> { return this.request('/api/client-log', { method: 'POST', body: value }); }
  getServerLog(): Promise<string> { return this.request('/api/debug/server-log', { response: 'text' }); }
  applyPatch(id: string, nodeRunId: string): Promise<ApplyPatchResponse> { return this.request(`/api/runs/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeRunId)}/apply-patch`, { method: 'POST' }); }
  deleteRun(id: string): Promise<void> { return this.request(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

  async request<T>(path: string, options: { method?: string; body?: unknown; response?: 'json'|'text'|'blob' } = {}): Promise<T> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const init: RequestInit = { method: options.method ?? 'GET', headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const response = await fetch(`${this.#baseUrl}${path}`, init);
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`; let code = 'HTTP_ERROR';
      try { const body = await response.json() as { error?: { code?: string; message?: string } }; message = body.error?.message ?? message; code = body.error?.code ?? code; } catch { /* Keep HTTP fallback. */ }
      throw new ApiError(response.status, message, code);
    }
    if (response.status === 204) return undefined as T;
    return (options.response === 'text' ? await response.text() : options.response === 'blob' ? await response.blob() : await response.json()) as T;
  }
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const result = query.toString(); return result ? `?${result}` : '';
}

export const apiClient = new ApiClient({ token: () => sessionStorage.getItem('mat-token') ?? undefined });
