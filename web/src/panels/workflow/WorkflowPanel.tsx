import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { AgentBinding, ProviderInfo, Slot, Stage, WorkflowDef } from '@mat/shared';
import { useEffect, useRef, useState } from 'react';
import { apiClient, type ApiClient } from '../../api/client.js';
import { useMatStore } from '../../app/store.js';
import { AgentChip } from '../../components/AgentChip.js';
import {
  appendSlotWithProviderDefaults,
  cloneWorkflow,
  createRunRequest,
  MAX_STAGE_AGENTS,
  reduceWorkflowEdit,
  stageAgentCount,
  validateSlotCount,
} from './logic.js';

const ACTIVE_STATUSES = new Set(['created', 'running', 'gating']);

export interface WorkflowPanelProps { api?: ApiClient }

export function WorkflowPanel({ api = apiClient }: WorkflowPanelProps) {
  const workflows = useMatStore((state) => state.workflows);
  const providers = useMatStore((state) => state.providers);
  const workspaces = useMatStore((state) => state.workspaces);
  const selectedWorkspaceId = useMatStore((state) => state.selectedWorkspaceId);
  const edits = useMatStore((state) => state.ephemeralWorkflowEdits);
  const runs = useMatStore((state) => state.runs);
  const runsLoading = useMatStore((state) => state.runsLoading);
  const setEdit = useMatStore((state) => state.setEphemeralWorkflowEdit);
  const setWorkflows = useMatStore((state) => state.setWorkflows);
  const upsertRun = useMatStore((state) => state.upsertRun);
  const setActiveRunId = useMatStore((state) => state.setActiveRunId);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const [workflowId, setWorkflowId] = useState('');
  const [openSlot, setOpenSlot] = useState<string>();
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const [task, setTask] = useState('');
  const [actionError, setActionError] = useState<string>();
  const [actionPending, setActionPending] = useState(false);
  const [fallbackStage, setFallbackStage] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState('');
  const lastWorkspaceId = useRef<string>();
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  useEffect(() => {
    const workspaceChanged = lastWorkspaceId.current !== selectedWorkspaceId;
    lastWorkspaceId.current = selectedWorkspaceId;
    const preferred = selectedWorkspace?.defaultWorkflowId;
    setWorkflowId((current) => {
      if (workspaceChanged) return workflows.some((workflow) => workflow.id === preferred) ? preferred! : (workflows[0]?.id ?? '');
      return workflows.some((workflow) => workflow.id === current) ? current : (workflows.find((workflow) => workflow.id === preferred)?.id ?? workflows[0]?.id ?? '');
    });
  }, [selectedWorkspaceId, selectedWorkspace?.defaultWorkflowId, workflows]);

  const baseWorkflow = workflows.find((workflow) => workflow.id === workflowId);
  const workflow = baseWorkflow ? (edits[baseWorkflow.id] ?? baseWorkflow) : undefined;
  const activeRun = Object.values(runs).find((run) => run.workspaceId === selectedWorkspaceId && ACTIVE_STATUSES.has(run.status));
  const invalidStage = workflow?.stages.find((stage) => stage.slots.length === 0 || stageAgentCount(stage) > MAX_STAGE_AGENTS);

  useEffect(() => {
    if (!workflow) return;
    setFallbackStage((value) => workflow.stages.some((stage) => stage.id === value) ? value : (workflow.stages[0]?.id ?? ''));
    setFallbackProvider((value) => providers.some((provider) => provider.id === value && provider.ok) ? value : (providers.find((provider) => provider.ok)?.id ?? ''));
  }, [workflow, providers]);

  const commit = (update: (copy: WorkflowDef) => void) => {
    if (!baseWorkflow) return;
    const next = reduceWorkflowEdit(edits, baseWorkflow, update);
    setEdit(baseWorkflow.id, next[baseWorkflow.id]);
  };

  const updateStage = (stageId: string, update: (stage: Stage) => Stage) => commit((copy) => {
    copy.stages = copy.stages.map((stage) => stage.id === stageId ? update(stage) : stage);
  });

  const appendProvider = (stageId: string, providerId: string) => {
    const provider = providers.find((item) => item.id === providerId);
    const stage = workflow?.stages.find((item) => item.id === stageId);
    if (!provider?.ok || !stage || stageAgentCount(stage) >= MAX_STAGE_AGENTS) return;
    updateStage(stageId, (stage) => appendSlotWithProviderDefaults(stage, provider));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const providerId = event.active.data.current?.providerId;
    const stageId = event.over?.data.current?.stageId;
    if (typeof providerId === 'string' && typeof stageId === 'string') appendProvider(stageId, providerId);
  };

  const duplicateBuiltin = async () => {
    if (!baseWorkflow || !workflow) return;
    setActionPending(true); setActionError(undefined);
    try {
      const duplicated = await api.duplicateWorkflow(baseWorkflow.id);
      const copy = { ...cloneWorkflow(workflow), id: duplicated.id, name: duplicated.name };
      delete copy.builtin;
      const saved = await api.updateWorkflow(duplicated.id, copy);
      setWorkflows([...workflows.filter((item) => item.id !== saved.id), saved]);
      setEdit(baseWorkflow.id, undefined); setEdit(saved.id, undefined); setWorkflowId(saved.id);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not duplicate workflow.'); }
    finally { setActionPending(false); }
  };

  const saveCustom = async () => {
    if (!baseWorkflow || !workflow || baseWorkflow.builtin) return;
    setActionPending(true); setActionError(undefined);
    try {
      const copy = cloneWorkflow(workflow); delete copy.builtin;
      const saved = await api.updateWorkflow(baseWorkflow.id, copy);
      setWorkflows(workflows.map((item) => item.id === saved.id ? saved : item));
      setEdit(baseWorkflow.id, undefined);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not save workflow.'); }
    finally { setActionPending(false); }
  };

  const startRun = async () => {
    if (!selectedWorkspaceId || !baseWorkflow || !task.trim() || activeRun || invalidStage || runsLoading) return;
    setActionPending(true); setActionError(undefined);
    try {
      const run = await api.createRun(createRunRequest(selectedWorkspaceId, baseWorkflow, task, edits));
      upsertRun(run); setActiveRunId(run.runId);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not start run.'); }
    finally { setActionPending(false); }
  };

  if (!selectedWorkspaceId) return <section className="h-full p-3"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Workflow</h2><p className="text-xs text-muted">Select a workspace to configure a workflow.</p></section>;

  return <DndContext sensors={sensors} onDragEnd={onDragEnd}>
    <section aria-labelledby="workflow-heading" className="h-full overflow-auto p-3">
      <h2 id="workflow-heading" className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Workflow</h2>
      <label className="block text-xs text-muted">Mode
        <select aria-label="Workflow" value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setOpenSlot(undefined); setOrchestratorOpen(false); }} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-2 text-sm text-ink">
          {workflows.map((item) => <option key={item.id} value={item.id}>{item.builtin ? '⭐ ' : ''}{item.name}{item.id === selectedWorkspace?.defaultWorkflowId ? ' (default)' : ''}</option>)}
        </select>
      </label>

      {!workflow && <p className="mt-3 text-xs text-muted">No workflows available.</p>}
      {workflow && <>
        <p className="mt-2 text-xs text-muted">{workflow.description}</p>
        {baseWorkflow?.builtin && edits[baseWorkflow.id] && <div className="mt-3 rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200"><span>editing a copy — Duplicate to save</span><button type="button" disabled={actionPending} onClick={() => void duplicateBuiltin()} className="ml-2 rounded border border-amber-700 px-2 py-1 font-medium hover:bg-amber-900 disabled:opacity-50">Duplicate</button></div>}
        {!baseWorkflow?.builtin && edits[workflow.id] && <div className="mt-3 flex items-center justify-between rounded border border-border bg-zinc-900 p-2 text-xs"><span className="text-muted">Unsaved workflow edits</span><button type="button" disabled={actionPending} onClick={() => void saveCustom()} className="rounded border border-accent px-2 py-1 text-violet-200 disabled:opacity-50">Save changes</button></div>}

        <div className="mt-3 space-y-3">
          {workflow.stages.map((stage) => <StageEditor key={stage.id} stage={stage} providers={providers} openSlot={openSlot} onOpenSlot={(id) => setOpenSlot((current) => current === id ? undefined : id)} onUpdate={(update) => updateStage(stage.id, update)} />)}
        </div>

        <section aria-labelledby="run-box-heading" className="mt-4 rounded border border-border bg-zinc-900/50 p-3">
          <h3 id="run-box-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Run task</h3>
          <textarea aria-label="Task" value={task} onChange={(event) => setTask(event.target.value)} rows={5} placeholder="Describe the work for this workflow…" className="mt-2 w-full resize-y rounded border border-border bg-zinc-950 px-2 py-2 text-sm text-ink outline-none focus:border-accent" />
          <div className="relative mt-2 rounded border border-border bg-zinc-950/60 p-2">
            <label className="flex items-center justify-between gap-2 text-xs"><span className="text-muted">Orchestrator</span><input type="checkbox" checked={workflow.orchestrator.enabled} onChange={(event) => commit((copy) => { copy.orchestrator.enabled = event.target.checked; })} /></label>
            <button type="button" onClick={() => setOrchestratorOpen((value) => !value)} className="mt-2 w-full rounded bg-zinc-900 px-2 py-1.5 text-left text-xs hover:bg-zinc-800" aria-expanded={orchestratorOpen}>{bindingSummary(workflow.orchestrator.agent)}</button>
            {orchestratorOpen && <BindingEditor title="Orchestrator binding" binding={workflow.orchestrator.agent} providers={providers} onChange={(agent) => commit((copy) => { copy.orchestrator.agent = agent; })} onClose={() => setOrchestratorOpen(false)} />}
          </div>
          {activeRun && <p className="mt-2 text-xs text-amber-300">A {activeRun.status} run already exists in this workspace.</p>}
          {invalidStage && <p className="mt-2 text-xs text-red-300">{invalidStage.name} must contain 1–12 agents.</p>}
          <button type="button" onClick={() => void startRun()} disabled={!task.trim() || !!activeRun || !!invalidStage || actionPending || runsLoading} className="mt-3 w-full rounded bg-accent px-3 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40">{actionPending || runsLoading ? 'Working…' : 'Start'}</button>
        </section>

        <section aria-labelledby="agent-palette-heading" className="mt-4 rounded border border-border bg-zinc-950/60 p-3">
          <h3 id="agent-palette-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Agent palette</h3>
          <p className="mt-1 text-[11px] text-muted">Drag a provider onto a stage, or use the add-agent controls.</p>
          <div className="mt-2 flex flex-wrap gap-2">{providers.map((provider) => <PaletteAgent key={provider.id} provider={provider} />)}</div>
          {providers.length === 0 && <p className="mt-2 text-xs text-muted">Provider discovery pending.</p>}
          <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
            <select aria-label="Stage for new agent" value={fallbackStage} onChange={(event) => setFallbackStage(event.target.value)} className="min-w-0 rounded border border-border bg-zinc-950 px-2 py-1.5 text-xs"><option value="">Stage</option>{workflow.stages.map((stage) => <option key={stage.id} value={stage.id} disabled={stageAgentCount(stage) >= MAX_STAGE_AGENTS}>{stage.name}</option>)}</select>
            <select aria-label="Provider for new agent" value={fallbackProvider} onChange={(event) => setFallbackProvider(event.target.value)} className="min-w-0 rounded border border-border bg-zinc-950 px-2 py-1.5 text-xs"><option value="">Provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.ok}>{provider.id}{provider.ok ? '' : ' (unavailable)'}</option>)}</select>
            <button type="button" onClick={() => appendProvider(fallbackStage, fallbackProvider)} disabled={!fallbackStage || !fallbackProvider} className="rounded border border-accent px-2 py-1.5 text-xs text-violet-200 disabled:opacity-40">+ add agent</button>
          </div>
        </section>
      </>}
      {actionError && <p role="alert" className="mt-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{actionError}</p>}
    </section>
  </DndContext>;
}

interface StageEditorProps {
  stage: Stage; providers: ProviderInfo[]; openSlot: string | undefined;
  onOpenSlot(id: string): void; onUpdate(update: (stage: Stage) => Stage): void;
}

function StageEditor({ stage, providers, openSlot, onOpenSlot, onUpdate }: StageEditorProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.id}`, data: { stageId: stage.id } });
  const total = stageAgentCount(stage);
  const updateSlot = (slotId: string, update: (slot: Slot) => Slot) => onUpdate((current) => ({ ...current, slots: current.slots.map((slot) => slot.id === slotId ? update(slot) : slot) }));
  return <section ref={setNodeRef} className={`rounded border p-2 ${isOver ? 'border-accent bg-violet-950/30' : 'border-border bg-zinc-900/40'}`}>
    <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-medium">{stage.name}</h3><span className={`text-[11px] ${total > MAX_STAGE_AGENTS || total === 0 ? 'text-red-300' : 'text-muted'}`}>{total}/{MAX_STAGE_AGENTS} agents</span></div><div className="grid gap-1 text-[11px] text-muted">
      <label className="flex items-center justify-between gap-2">worktree <input type="checkbox" checked={stage.isolation === 'worktree'} onChange={(event) => onUpdate((current) => ({ ...current, isolation: event.target.checked ? 'worktree' : 'none' }))} /></label>
      <label className="flex items-center justify-between gap-2">gate <input type="checkbox" checked={stage.gate} onChange={(event) => onUpdate((current) => ({ ...current, gate: event.target.checked }))} /></label>
    </div></div>
    <label className="mt-2 flex items-center gap-2 text-[11px] text-muted">Timeout <input aria-label={`${stage.name} timeout seconds`} type="number" min={1} value={stage.timeoutSec} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value > 0) onUpdate((current) => ({ ...current, timeoutSec: value })); }} className="w-24 rounded border border-border bg-zinc-950 px-2 py-1 text-ink" /> sec</label>
    <div className="mt-2 flex flex-wrap gap-2">
      {stage.slots.map((slot) => {
        const popoverId = `${stage.id}:${slot.id}`;
        return <div key={slot.id} className="relative"><button type="button" onClick={() => onOpenSlot(popoverId)} aria-expanded={openSlot === popoverId} className="rounded-full outline-none ring-accent focus:ring-2"><AgentChip agent={slot.agent} label={slot.label} count={slot.count} /></button>{openSlot === popoverId && <SlotEditor stage={stage} slot={slot} providers={providers} onChange={(update) => updateSlot(slot.id, update)} onRemove={() => onUpdate((current) => ({ ...current, slots: current.slots.filter((item) => item.id !== slot.id) }))} onClose={() => onOpenSlot(popoverId)} />}</div>;
      })}
      {stage.slots.length === 0 && <span className="text-xs text-red-300">Drop or add an agent.</span>}
    </div>
  </section>;
}

function SlotEditor({ stage, slot, providers, onChange, onRemove, onClose }: { stage: Stage; slot: Slot; providers: ProviderInfo[]; onChange(update: (slot: Slot) => Slot): void; onRemove(): void; onClose(): void }) {
  const provider = providers.find((item) => item.id === slot.agent.provider);
  const listId = `models-${stage.id}-${slot.id}`;
  const canIncrease = validateSlotCount(stage, slot.id, slot.count + 1).valid;
  const editAgent = (update: (agent: AgentBinding) => void) => onChange((current) => { const agent = { ...current.agent }; update(agent); return { ...current, agent }; });
  return <div role="dialog" aria-label={`Edit ${slot.label}`} className="absolute left-0 top-full z-30 mt-2 w-72 rounded border border-accent bg-panel p-3 shadow-2xl">
    <div className="flex items-center justify-between"><strong className="text-xs">{slot.label}</strong><button type="button" onClick={onClose} aria-label="Close slot editor" className="text-muted hover:text-ink">×</button></div>
    <label className="mt-2 block text-xs text-muted">Model<input list={listId} value={slot.agent.model ?? ''} onChange={(event) => editAgent((agent) => { if (event.target.value) agent.model = event.target.value; else delete agent.model; })} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink" /></label>
    <datalist id={listId}>{provider?.models.map((model) => <option key={model} value={model} />)}</datalist>
    <label className="mt-2 block text-xs text-muted">Effort<select value={slot.agent.effort ?? ''} onChange={(event) => editAgent((agent) => { if (event.target.value) agent.effort = event.target.value as NonNullable<AgentBinding['effort']>; else delete agent.effort; })} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink"><option value="">default</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
    <div className="mt-2 text-xs text-muted">Count<div className="mt-1 inline-flex items-center rounded border border-border bg-zinc-950"><button type="button" aria-label="Decrease count" disabled={slot.count <= 1} onClick={() => onChange((current) => ({ ...current, count: current.count - 1 }))} className="px-3 py-1 disabled:opacity-30">−</button><output className="min-w-8 text-center text-ink">{slot.count}</output><button type="button" aria-label="Increase count" disabled={!canIncrease} onClick={() => onChange((current) => ({ ...current, count: current.count + 1 }))} className="px-3 py-1 disabled:opacity-30">+</button></div></div>
    <label className="mt-2 block text-xs text-muted">Permission<select value={slot.agent.permission} onChange={(event) => editAgent((agent) => { agent.permission = event.target.value as AgentBinding['permission']; })} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink"><option value="safe">safe</option><option value="auto">auto</option><option value="full">full</option></select></label>
    <label className="mt-2 block text-xs text-muted">Prompt template<textarea value={slot.promptTemplate} onChange={(event) => onChange((current) => ({ ...current, promptTemplate: event.target.value }))} rows={5} className="mt-1 w-full resize-y rounded border border-border bg-zinc-950 px-2 py-1.5 font-mono text-xs text-ink" /></label>
    <button type="button" onClick={onRemove} className="mt-3 text-xs text-red-300 hover:text-red-200">Remove slot</button>
  </div>;
}

function BindingEditor({ title, binding, providers, onChange, onClose }: { title: string; binding: AgentBinding; providers: ProviderInfo[]; onChange(value: AgentBinding): void; onClose(): void }) {
  const provider = providers.find((item) => item.id === binding.provider);
  const edit = (update: (copy: AgentBinding) => void) => { const copy = { ...binding }; update(copy); onChange(copy); };
  return <div role="dialog" aria-label={title} className="absolute left-0 top-full z-30 mt-2 w-full rounded border border-accent bg-panel p-3 shadow-2xl">
    <div className="flex items-center justify-between"><strong className="text-xs">{title}</strong><button type="button" onClick={onClose} aria-label="Close orchestrator editor" className="text-muted">×</button></div>
    <label className="mt-2 block text-xs text-muted">Provider<select value={binding.provider} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); if (next) onChange({ ...binding, provider: next.id, model: next.defaultModel }); }} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink">{providers.map((item) => <option key={item.id} value={item.id} disabled={!item.ok}>{item.id}</option>)}</select></label>
    <label className="mt-2 block text-xs text-muted">Model<input list="orchestrator-models" value={binding.model ?? ''} onChange={(event) => edit((copy) => { if (event.target.value) copy.model = event.target.value; else delete copy.model; })} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink" /></label><datalist id="orchestrator-models">{provider?.models.map((model) => <option key={model} value={model} />)}</datalist>
    <label className="mt-2 block text-xs text-muted">Effort<select value={binding.effort ?? ''} onChange={(event) => edit((copy) => { if (event.target.value) copy.effort = event.target.value as NonNullable<AgentBinding['effort']>; else delete copy.effort; })} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink"><option value="">default</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
    <label className="mt-2 block text-xs text-muted">Permission<select value={binding.permission} onChange={(event) => onChange({ ...binding, permission: event.target.value as AgentBinding['permission'] })} className="mt-1 w-full rounded border border-border bg-zinc-950 px-2 py-1.5 text-ink"><option value="safe">safe</option><option value="auto">auto</option><option value="full">full</option></select></label>
  </div>;
}

function PaletteAgent({ provider }: { provider: ProviderInfo }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `provider-${provider.id}`, data: { providerId: provider.id }, disabled: !provider.ok });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const unavailable = provider.detail ? `Unavailable: ${provider.detail}` : 'Provider unavailable';
  return <span title={provider.ok ? `Drag ${provider.id} to a stage` : unavailable} className="inline-flex"><button ref={setNodeRef} type="button" style={style} {...listeners} {...attributes} disabled={!provider.ok} aria-label={`${provider.id} provider${provider.ok ? '' : ` unavailable: ${provider.detail ?? 'not detected'}`}`} className={`rounded-full text-left ${provider.ok ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed grayscale opacity-40'} ${isDragging ? 'z-50 opacity-70' : ''}`}><AgentChip agent={{ provider: provider.id, model: provider.defaultModel, permission: 'auto' }} /></button></span>;
}

function bindingSummary(binding: AgentBinding): string {
  return [binding.provider, binding.model, binding.effort, binding.permission].filter(Boolean).join(' · ');
}
