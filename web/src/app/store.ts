import type { AgentEvent, EventRole, ProviderInfo, RuntimeStatus, RunSnapshot, WorkflowDef, Workspace, WsServerMsg } from '@mat/shared';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { apiClient, type ApiClient } from '../api/client.js';

export const EVENT_RING_LIMIT = 20_000;
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set(['created', 'running', 'gating']);
const TERMINAL_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set(['done', 'failed', 'aborted']);
const EVIDENCE_SYNC_FAILURE_MESSAGE = 'Evidence synchronization did not complete. Retry to catch up.';
const EVIDENCE_RECOVERY_FAILURE_MESSAGE = 'Evidence recovery did not complete. Retry to recover missing events.';
export type WsConnectionState = 'connecting' | 'open' | 'closed';
export type EvidenceCatchUpState = 'started' | 'synchronized' | 'failed';
export interface EvidenceIntegrity {
  status: 'live' | 'recovering' | 'incomplete';
  expectedSeq?: number;
  receivedSeq?: number;
  message?: string;
}
export interface MatFilters { nodeRunIds: string[]; roles: EventRole[]; follow: boolean }
export interface MatState {
  workspaces: Workspace[];
  workflows: WorkflowDef[];
  providers: ProviderInfo[];
  runtimes: RuntimeStatus[];
  selectedWorkspaceId: string | undefined;
  ephemeralWorkflowEdits: Record<string, WorkflowDef>;
  activeRunId: string | undefined;
  viewedRunId: string | undefined;
  runsLoading: boolean;
  runs: Record<string, RunSnapshot>;
  events: Record<string, AgentEvent[]>;
  wsConnection: WsConnectionState;
  evidenceIntegrity: Record<string, EvidenceIntegrity>;
  filters: MatFilters;
  ui: { focusedNodeRunId: string | undefined };
}
export interface MatActions {
  setWorkspaces(value: Workspace[]): void;
  setWorkflows(value: WorkflowDef[]): void;
  setProviders(value: ProviderInfo[]): void;
  setRuntimes(value: RuntimeStatus[]): void;
  setSelectedWorkspaceId(id?: string): void;
  setEphemeralWorkflowEdit(id: string, value?: WorkflowDef): void;
  setActiveRunId(id?: string): void;
  setViewedRunId(id?: string): void;
  setRunsLoading(value: boolean): void;
  upsertRun(run: RunSnapshot): void;
  setEvents(runId: string, events: AgentEvent[]): void;
  setWsConnection(value: WsConnectionState): void;
  setEvidenceCatchUpState(runId: string, value: EvidenceCatchUpState, afterSeq?: number): void;
  retryEvidenceRecovery(runId: string): void;
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
  const pendingGapEvents = new Map<string, Map<number, AgentEvent>>();
  const activeRecoveries = new Set<string>();
  const recoveryBases = new Map<string, number>();
  const catchUpOwnedIntegrity = new Set<string>();

  return createStore<MatStore>()((set, get) => {
    const mergeRecoveredEvents = (runId: string, recovered: readonly AgentEvent[]): void => {
      set((state) => ({
        events: {
          ...state.events,
          [runId]: uniqueSorted([...(state.events[runId] ?? []), ...recovered]).slice(-EVENT_RING_LIMIT),
        },
      }));
    };

    const recoverEvidenceGap = async (runId: string, baseSeq: number): Promise<void> => {
      if (activeRecoveries.has(runId)) return;
      activeRecoveries.add(runId);
      recoveryBases.set(runId, baseSeq);
      const pending = pendingGapEvents.get(runId) ?? new Map<number, AgentEvent>();
      pendingGapEvents.set(runId, pending);
      let contiguousSeq = baseSeq;
      let noProgress = 0;
      try {
        while (noProgress < 2) {
          const page = await client.getEvents(runId, contiguousSeq, 1000);
          for (const event of page) if (event.seq > contiguousSeq) pending.set(event.seq, event);

          const before = contiguousSeq;
          const recovered: AgentEvent[] = [];
          for (;;) {
            const next = pending.get(contiguousSeq + 1);
            if (!next) break;
            pending.delete(next.seq);
            recovered.push(next);
            contiguousSeq = next.seq;
          }
          if (recovered.length > 0) mergeRecoveredEvents(runId, recovered);
          if (pending.size === 0 && page.length < 1000) {
            pendingGapEvents.delete(runId);
            recoveryBases.delete(runId);
            catchUpOwnedIntegrity.delete(runId);
            set((state) => ({ evidenceIntegrity: { ...state.evidenceIntegrity, [runId]: { status: 'live' } } }));
            return;
          }
          noProgress = contiguousSeq === before ? noProgress + 1 : 0;
        }
        if (get().evidenceIntegrity[runId]?.status === 'live') return;
        const highestSeq = Math.max(contiguousSeq, highestMapKey(pending) ?? contiguousSeq);
        set((state) => ({ evidenceIntegrity: {
          ...state.evidenceIntegrity,
          [runId]: {
            status: 'incomplete', expectedSeq: contiguousSeq + 1, receivedSeq: highestSeq,
            message: `Could not recover event ${contiguousSeq + 1} from persisted evidence.`,
          },
        } }));
      } catch {
        if (get().evidenceIntegrity[runId]?.status === 'live') return;
        const visiblePending = [...pending.values()].sort((left, right) => left.seq - right.seq).slice(-EVENT_RING_LIMIT);
        mergeRecoveredEvents(runId, visiblePending);
        const highestSeq = highestMapKey(pending);
        const current = get().events[runId] ?? [];
        if (highestSeq !== undefined && rangePresent(current, contiguousSeq + 1, highestSeq)) {
          pendingGapEvents.delete(runId); recoveryBases.delete(runId);
          catchUpOwnedIntegrity.delete(runId);
          set((state) => ({ evidenceIntegrity: { ...state.evidenceIntegrity, [runId]: { status: 'live' } } }));
          return;
        }
        set((state) => ({ evidenceIntegrity: {
          ...state.evidenceIntegrity,
          [runId]: {
            status: 'incomplete', expectedSeq: contiguousSeq + 1,
            ...(highestSeq !== undefined ? { receivedSeq: highestSeq } : {}),
            message: EVIDENCE_RECOVERY_FAILURE_MESSAGE,
          },
        } }));
      } finally {
        activeRecoveries.delete(runId);
      }
    };

    const startEvidenceRecovery = (runId: string, baseSeq: number): void => {
      if (activeRecoveries.has(runId)) return;
      catchUpOwnedIntegrity.delete(runId);
      set((state) => {
        const pending = pendingGapEvents.get(runId);
        return { evidenceIntegrity: {
          ...state.evidenceIntegrity,
          [runId]: {
            status: 'recovering', expectedSeq: baseSeq + 1,
            ...(pending && pending.size > 0 ? { receivedSeq: highestMapKey(pending)! } : {}),
          },
        } };
      });
      void recoverEvidenceGap(runId, baseSeq);
    };

    return ({
    workspaces: [], workflows: [], providers: [], runtimes: [], selectedWorkspaceId: undefined, ephemeralWorkflowEdits: {}, activeRunId: undefined, viewedRunId: undefined, runsLoading: true, runs: {}, events: {},
    wsConnection: 'closed', evidenceIntegrity: {},
    filters: { nodeRunIds: [], roles: allRoles, follow: true }, ui: { focusedNodeRunId: undefined },
    setWorkspaces: (workspaces) => set({ workspaces }),
    setWorkflows: (workflows) => set({ workflows }),
    setProviders: (providers) => set({ providers }),
    setRuntimes: (runtimes) => set({ runtimes }),
    setSelectedWorkspaceId: (selectedWorkspaceId) => set((state) => {
      if (state.selectedWorkspaceId === selectedWorkspaceId) return state;
      return {
        selectedWorkspaceId,
        activeRunId: undefined,
        viewedRunId: undefined,
        runsLoading: selectedWorkspaceId !== undefined,
        ephemeralWorkflowEdits: Object.fromEntries(
          Object.entries(state.ephemeralWorkflowEdits).filter(([, workflow]) => !workflow.builtin),
        ),
        filters: { ...state.filters, nodeRunIds: [], follow: true },
        ui: { focusedNodeRunId: undefined },
      };
    }),
    setEphemeralWorkflowEdit: (id, value) => set((state) => {
      const edits = { ...state.ephemeralWorkflowEdits };
      if (value) edits[id] = value; else delete edits[id];
      return { ephemeralWorkflowEdits: edits };
    }),
    setActiveRunId: (activeRunId) => set({ activeRunId }),
    setViewedRunId: (viewedRunId) => set((state) => state.viewedRunId === viewedRunId ? state : ({
      viewedRunId,
      filters: { ...state.filters, nodeRunIds: [] },
      ui: { focusedNodeRunId: undefined },
    })),
    setRunsLoading: (runsLoading) => set({ runsLoading }),
    upsertRun: (run) => set((state) => ({ runs: { ...state.runs, [run.runId]: run } })),
    setEvents: (runId, value) => set((state) => {
      const sorted = uniqueSorted(value);
      const integrity = state.evidenceIntegrity[runId];
      const resolved = !catchUpOwnedIntegrity.has(runId) && integrity !== undefined && integrity.status !== 'live' && integrity.expectedSeq !== undefined && integrity.receivedSeq !== undefined
        && rangePresent(sorted, integrity.expectedSeq, integrity.receivedSeq);
      if (resolved) { pendingGapEvents.delete(runId); recoveryBases.delete(runId); catchUpOwnedIntegrity.delete(runId); }
      return {
        events: { ...state.events, [runId]: sorted.slice(-EVENT_RING_LIMIT) },
        ...(resolved ? { evidenceIntegrity: { ...state.evidenceIntegrity, [runId]: { status: 'live' } } } : {}),
      };
    }),
    setWsConnection: (wsConnection) => set((state) => state.wsConnection === wsConnection ? state : { wsConnection }),
    setEvidenceCatchUpState: (runId, value, afterSeq) => {
      const gapRecoveryOwnsIntegrity = activeRecoveries.has(runId) || recoveryBases.has(runId) || pendingGapEvents.has(runId);
      if (value === 'started') {
        if (gapRecoveryOwnsIntegrity) return;
        catchUpOwnedIntegrity.add(runId);
        const cursor = Math.max(0, afterSeq ?? (get().events[runId]?.at(-1)?.seq ?? 0));
        const receivedSeq = get().events[runId]?.at(-1)?.seq;
        set((state) => ({ evidenceIntegrity: {
          ...state.evidenceIntegrity,
          [runId]: {
            status: 'recovering', expectedSeq: cursor + 1,
            ...(receivedSeq !== undefined && receivedSeq > cursor ? { receivedSeq } : {}),
          },
        } }));
        return;
      }
      if (!catchUpOwnedIntegrity.delete(runId) || gapRecoveryOwnsIntegrity) return;
      set((state) => {
        const integrity = state.evidenceIntegrity[runId];
        return { evidenceIntegrity: {
          ...state.evidenceIntegrity,
          [runId]: value === 'synchronized'
            ? { status: 'live' }
            : {
                status: 'incomplete',
                ...(integrity?.expectedSeq !== undefined ? { expectedSeq: integrity.expectedSeq } : {}),
                ...(integrity?.receivedSeq !== undefined ? { receivedSeq: integrity.receivedSeq } : {}),
                message: EVIDENCE_SYNC_FAILURE_MESSAGE,
              },
        } };
      });
    },
    retryEvidenceRecovery: (runId) => {
      const integrity = get().evidenceIntegrity[runId];
      const baseSeq = recoveryBases.get(runId) ?? (integrity?.expectedSeq !== undefined ? Math.max(0, integrity.expectedSeq - 1) : (get().events[runId]?.at(-1)?.seq ?? 0));
      startEvidenceRecovery(runId, baseSeq);
    },
    setNodeFilter: (nodeRunIds) => set((state) => ({ filters: { ...state.filters, nodeRunIds } })),
    setFollow: (follow) => set((state) => ({ filters: { ...state.filters, follow } })),
    applyWsMsg: (msg) => {
      if (msg.type === 'event') {
        const runId = msg.event.runId;
        const state = get();
        const current = state.events[runId] ?? [];
        const pending = pendingGapEvents.get(runId);
        if (current.some((event) => event.id === msg.event.id || event.seq === msg.event.seq) || pending?.has(msg.event.seq)) return;
        if (activeRecoveries.has(runId)) {
          const recoveryBase = recoveryBases.get(runId);
          if (recoveryBase !== undefined && msg.event.seq <= recoveryBase) return;
          const nextPending = pending ?? new Map<number, AgentEvent>();
          nextPending.set(msg.event.seq, msg.event);
          pendingGapEvents.set(runId, nextPending);
          set((currentState) => ({ evidenceIntegrity: {
            ...currentState.evidenceIntegrity,
            [runId]: { ...currentState.evidenceIntegrity[runId], status: 'recovering', receivedSeq: highestMapKey(nextPending)! },
          } }));
          return;
        }
        const latest = current.at(-1)?.seq ?? 0;
        if (msg.event.seq > latest + 1) {
          const nextPending = pending ?? new Map<number, AgentEvent>();
          nextPending.set(msg.event.seq, msg.event);
          pendingGapEvents.set(runId, nextPending);
          // Preserve the earliest unresolved gap. Starting from the latest
          // event would make a later jump abandon evidence that is still missing.
          startEvidenceRecovery(runId, recoveryBases.get(runId) ?? latest);
          return;
        }
        set((currentState) => {
          const existing = currentState.events[runId] ?? [];
          const sorted = msg.event.seq > (existing.at(-1)?.seq ?? 0) ? [...existing, msg.event] : uniqueSorted([...existing, msg.event]);
          const integrity = currentState.evidenceIntegrity[runId];
          const resolved = integrity?.status === 'incomplete' && integrity.expectedSeq !== undefined && integrity.receivedSeq !== undefined
            && rangePresent(sorted, integrity.expectedSeq, integrity.receivedSeq);
          if (resolved) {
            pendingGapEvents.delete(runId); recoveryBases.delete(runId); catchUpOwnedIntegrity.delete(runId);
          }
          return {
            events: { ...currentState.events, [runId]: sorted.slice(-EVENT_RING_LIMIT) },
            evidenceIntegrity: {
              ...currentState.evidenceIntegrity,
              [runId]: resolved || integrity === undefined ? { status: 'live' } : integrity,
            },
          };
        });
      }
      else if (msg.type === 'run') {
        const previous = get().runs[msg.run.runId];
        set((state) => {
          const currentActiveRun = state.activeRunId ? state.runs[state.activeRunId] : undefined;
          const shouldActivate = msg.run.workspaceId === state.selectedWorkspaceId
            && ACTIVE_RUN_STATUSES.has(msg.run.status)
            && (state.activeRunId === undefined || state.activeRunId === msg.run.runId || (currentActiveRun !== undefined && !ACTIVE_RUN_STATUSES.has(currentActiveRun.status)));
          const shouldView = shouldActivate && (state.viewedRunId === undefined || state.viewedRunId === state.activeRunId);
          const activeRunEnded = state.activeRunId === msg.run.runId && TERMINAL_RUN_STATUSES.has(msg.run.status);
          return {
            runs: { ...state.runs, [msg.run.runId]: msg.run },
            ...(shouldActivate ? { activeRunId: msg.run.runId } : activeRunEnded ? { activeRunId: undefined } : {}),
            ...(shouldView ? { viewedRunId: msg.run.runId } : {}),
          };
        });
        if (TERMINAL_RUN_STATUSES.has(msg.run.status) && (!previous || !TERMINAL_RUN_STATUSES.has(previous.status))) {
          void client.getProviders().then((providers) => set({ providers })).catch(() => undefined);
        }
      }
      else if (msg.type === 'runtime:changed') {
        void client.getRuntimes().then((runtimes) => set({ runtimes })).catch(() => undefined);
        void client.getProviders().then((providers) => set({ providers })).catch(() => undefined);
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
      set((state) => {
        const sorted = uniqueSorted([...loaded.filter((event) => oldest === undefined || event.seq < oldest), ...(state.events[runId] ?? [])]);
        return { events: { ...state.events, [runId]: sorted.slice(0, EVENT_RING_LIMIT) } };
      });
    },
  });
  });
}

function uniqueSorted(events: AgentEvent[]): AgentEvent[] {
  if (events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)) return events;
  const bySeq = new Map<number, AgentEvent>();
  for (const event of events) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function rangePresent(events: readonly AgentEvent[], fromSeq: number, toSeq: number): boolean {
  if (toSeq < fromSeq) return true;
  let expectedSeq = fromSeq;
  for (const event of events) {
    if (event.seq < expectedSeq) continue;
    if (event.seq > expectedSeq) return false;
    if (expectedSeq === toSeq) return true;
    expectedSeq += 1;
  }
  return false;
}

function highestMapKey<T>(values: ReadonlyMap<number, T>): number | undefined {
  let highest: number | undefined;
  for (const key of values.keys()) if (highest === undefined || key > highest) highest = key;
  return highest;
}

export const matStore = createMatStore();
export function useMatStore<T = MatStore>(selector: (state: MatStore) => T = ((state) => state as T)): T { return useStore(matStore, selector); }
