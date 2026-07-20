import type { AgentEvent, EventRole, ProviderInfo, RunSnapshot, WorkflowDef, Workspace, WsServerMsg } from '@mat/shared';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { apiClient, type ApiClient } from '../api/client.js';

export const EVENT_RING_LIMIT = 20_000;
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set(['created', 'running', 'gating']);
const TERMINAL_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set(['done', 'failed', 'aborted']);
export interface MatFilters { nodeRunIds: string[]; roles: EventRole[]; follow: boolean }
export interface MatState {
  workspaces: Workspace[];
  workflows: WorkflowDef[];
  providers: ProviderInfo[];
  selectedWorkspaceId: string | undefined;
  ephemeralWorkflowEdits: Record<string, WorkflowDef>;
  activeRunId: string | undefined;
  runsLoading: boolean;
  runs: Record<string, RunSnapshot>;
  events: Record<string, AgentEvent[]>;
  filters: MatFilters;
  ui: { focusedNodeRunId: string | undefined };
}
export interface MatActions {
  setWorkspaces(value: Workspace[]): void;
  setWorkflows(value: WorkflowDef[]): void;
  setProviders(value: ProviderInfo[]): void;
  setSelectedWorkspaceId(id?: string): void;
  setEphemeralWorkflowEdit(id: string, value?: WorkflowDef): void;
  setActiveRunId(id?: string): void;
  setRunsLoading(value: boolean): void;
  upsertRun(run: RunSnapshot): void;
  setEvents(runId: string, events: AgentEvent[]): void;
  setNodeFilter(ids: string[]): void;
  setFollow(follow: boolean): void;
  applyWsMsg(msg: WsServerMsg): void;
  focusNode(id?: string): void;
  toggleRole(role: EventRole): void;
  loadOlderEvents(runId: string): Promise<void>;
}
export type MatStore = MatState & MatActions;

const allRoles: EventRole[] = ['user', 'agent', 'tool', 'thinking', 'system', 'decision'];

export function createMatStore(client: ApiClient = apiClient): StoreApi<MatStore> {
  return createStore<MatStore>()((set, get) => ({
    workspaces: [], workflows: [], providers: [], selectedWorkspaceId: undefined, ephemeralWorkflowEdits: {}, activeRunId: undefined, runsLoading: true, runs: {}, events: {},
    filters: { nodeRunIds: [], roles: allRoles, follow: true }, ui: { focusedNodeRunId: undefined },
    setWorkspaces: (workspaces) => set({ workspaces }),
    setWorkflows: (workflows) => set({ workflows }),
    setProviders: (providers) => set({ providers }),
    setSelectedWorkspaceId: (selectedWorkspaceId) => set({ selectedWorkspaceId, runsLoading: selectedWorkspaceId !== undefined }),
    setEphemeralWorkflowEdit: (id, value) => set((state) => {
      const edits = { ...state.ephemeralWorkflowEdits };
      if (value) edits[id] = value; else delete edits[id];
      return { ephemeralWorkflowEdits: edits };
    }),
    setActiveRunId: (activeRunId) => set({ activeRunId }),
    setRunsLoading: (runsLoading) => set({ runsLoading }),
    upsertRun: (run) => set((state) => ({ runs: { ...state.runs, [run.runId]: run } })),
    setEvents: (runId, value) => set((state) => ({ events: { ...state.events, [runId]: uniqueSorted(value).slice(-EVENT_RING_LIMIT) } })),
    setNodeFilter: (nodeRunIds) => set((state) => ({ filters: { ...state.filters, nodeRunIds } })),
    setFollow: (follow) => set((state) => ({ filters: { ...state.filters, follow } })),
    applyWsMsg: (msg) => {
      if (msg.type === 'event') set((state) => {
        const current = state.events[msg.event.runId] ?? [];
        if (current.some((event) => event.id === msg.event.id || event.seq === msg.event.seq)) return state;
        const latest = current.at(-1)?.seq;
        if (latest !== undefined && msg.event.seq > latest + 1) console.warn(`Event gap for ${msg.event.runId}: expected ${latest + 1}, received ${msg.event.seq}`);
        return { events: { ...state.events, [msg.event.runId]: uniqueSorted([...current, msg.event]).slice(-EVENT_RING_LIMIT) } };
      });
      else if (msg.type === 'run') {
        const previous = get().runs[msg.run.runId];
        set((state) => {
          const currentActiveRun = state.activeRunId ? state.runs[state.activeRunId] : undefined;
          const shouldActivate = msg.run.workspaceId === state.selectedWorkspaceId
            && ACTIVE_RUN_STATUSES.has(msg.run.status)
            && (state.activeRunId === undefined || state.activeRunId === msg.run.runId || (currentActiveRun !== undefined && !ACTIVE_RUN_STATUSES.has(currentActiveRun.status)));
          return {
            runs: { ...state.runs, [msg.run.runId]: msg.run },
            ...(shouldActivate ? { activeRunId: msg.run.runId } : {}),
          };
        });
        if (TERMINAL_RUN_STATUSES.has(msg.run.status) && (!previous || !TERMINAL_RUN_STATUSES.has(previous.status))) {
          void client.getProviders().then((providers) => set({ providers })).catch(() => undefined);
        }
      }
      else void client.getWorkspaces().then((workspaces) => set({ workspaces })).catch(() => undefined);
    },
    focusNode: (focusedNodeRunId) => set({ ui: { focusedNodeRunId } }),
    toggleRole: (role) => set((state) => ({ filters: { ...state.filters, roles: state.filters.roles.includes(role) ? state.filters.roles.filter((value) => value !== role) : [...state.filters.roles, role] } })),
    loadOlderEvents: async (runId) => {
      const current = get().events[runId] ?? [];
      const oldest = current[0]?.seq;
      if (oldest === 1) return;
      const limit = Math.min(1000, oldest === undefined ? 1000 : oldest - 1);
      const afterSeq = oldest === undefined ? 0 : Math.max(0, oldest - limit - 1);
      const loaded = await client.getEvents(runId, afterSeq, limit);
      set((state) => ({ events: { ...state.events, [runId]: uniqueSorted([...loaded.filter((event) => oldest === undefined || event.seq < oldest), ...(state.events[runId] ?? [])]).slice(0, EVENT_RING_LIMIT) } }));
    },
  }));
}

function uniqueSorted(events: AgentEvent[]): AgentEvent[] {
  const bySeq = new Map<number, AgentEvent>();
  for (const event of events) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export const matStore = createMatStore();
export function useMatStore<T = MatStore>(selector: (state: MatStore) => T = ((state) => state as T)): T { return useStore(matStore, selector); }
