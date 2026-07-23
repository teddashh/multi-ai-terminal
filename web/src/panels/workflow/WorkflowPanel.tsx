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
import type { AgentBinding, OpenRouterModelCatalog, OpenRouterModelGroup, OpenRouterModelVersion, ProviderInfo, Slot, Stage, WorkflowDef } from '@mat/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, type ApiClient } from '../../api/client.js';
import { ACTIVE_RUN_STATUSES, matStore, useMatStore } from '../../app/store.js';
import { AgentChip } from '../../components/AgentChip.js';
import { ProviderSetupButton } from '../../components/ProviderSetup.js';
import { SideDrawer } from '../../components/SideDrawer.js';
import {
  displayEffort,
  displayPermission,
  displayProviderDetail,
  displayRunStatus,
  displaySlotLabel,
  displayStageName,
  displayWorkflowDescription,
  displayWorkflowName,
} from '../../i18n/displayText.js';
import { useUiPreferences, type UiLocale } from '../../i18n/UiPreferences.js';
import {
  appendSlotWithProviderDefaults,
  cloneWorkflow,
  createRunRequest,
  MAX_STAGE_AGENTS,
  reduceWorkflowEdit,
  stageAgentCount,
  validateSlotCount,
} from './logic.js';

export interface WorkflowPanelProps { api?: ApiClient }

export function WorkflowPanel({ api = apiClient }: WorkflowPanelProps) {
  const { locale, t } = useUiPreferences();
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
  const setViewedRunId = useMatStore((state) => state.setViewedRunId);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const [workflowId, setWorkflowId] = useState('');
  const [openSlot, setOpenSlot] = useState<string>();
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const [task, setTask] = useState('');
  const [actionError, setActionError] = useState<string>();
  const [actionPending, setActionPending] = useState(false);
  const [fallbackStage, setFallbackStage] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState('');
  const [customizing, setCustomizing] = useState(false);
  const lastWorkspaceId = useRef<string>();
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  useEffect(() => {
    const workspaceChanged = lastWorkspaceId.current !== selectedWorkspaceId;
    lastWorkspaceId.current = selectedWorkspaceId;
    if (workspaceChanged) {
      setTask('');
      setOpenSlot(undefined);
      setOrchestratorOpen(false);
      setActionError(undefined);
      setCustomizing(false);
    }
    const preferred = selectedWorkspace?.defaultWorkflowId;
    setWorkflowId((current) => {
      if (workspaceChanged) return workflows.some((workflow) => workflow.id === preferred) ? preferred! : (workflows[0]?.id ?? '');
      return workflows.some((workflow) => workflow.id === current) ? current : (workflows.find((workflow) => workflow.id === preferred)?.id ?? workflows[0]?.id ?? '');
    });
  }, [selectedWorkspaceId, selectedWorkspace?.defaultWorkflowId, workflows]);

  const baseWorkflow = workflows.find((workflow) => workflow.id === workflowId);
  const workflow = baseWorkflow ? (edits[baseWorkflow.id] ?? baseWorkflow) : undefined;
  const activeRun = Object.values(runs).find((run) => run.workspaceId === selectedWorkspaceId && ACTIVE_RUN_STATUSES.has(run.status));
  const invalidStage = workflow?.stages.find((stage) => stage.slots.length === 0 || stageAgentCount(stage) > MAX_STAGE_AGENTS);
  const unavailableBindings = workflow ? unavailableProviderBindings(workflow, providers, locale) : [];
  const providerPreflightError = unavailableBindings.length > 0 ? unavailableBindings.join('\n') : undefined;
  const authWarnings = workflow ? workflowAuthWarnings(workflow, providers) : [];
  const credentialWarnings = workflow ? workflowCredentialWarnings(workflow, providers) : [];
  const verificationWarnings = workflow ? workflowVerificationWarnings(workflow, selectedWorkspace?.verifyCommand, locale) : [];

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
    } catch (error) { setActionError(error instanceof Error ? error.message : t('workflow.duplicateFailed')); }
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
    } catch (error) { setActionError(error instanceof Error ? error.message : t('workflow.saveFailed')); }
    finally { setActionPending(false); }
  };

  const startRun = async () => {
    if (!selectedWorkspaceId || !baseWorkflow || !task.trim() || activeRun || invalidStage || runsLoading) return;
    if (providerPreflightError) { setActionError(providerPreflightError); return; }
    const requestedWorkspaceId = selectedWorkspaceId;
    setActionPending(true); setActionError(undefined);
    try {
      const run = await api.createRun(createRunRequest(requestedWorkspaceId, baseWorkflow, task, edits));
      upsertRun(run);
      if (matStore.getState().selectedWorkspaceId === requestedWorkspaceId) {
        setActiveRunId(run.runId); setViewedRunId(run.runId);
      }
    } catch (error) {
      if (matStore.getState().selectedWorkspaceId === requestedWorkspaceId) {
        setActionError(error instanceof Error ? error.message : t('workflow.startFailed'));
      }
    }
    finally { setActionPending(false); }
  };

  if (!selectedWorkspaceId) return <section className="h-full p-4"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{t('workflow.launchpad')}</h2><p className="text-xs text-muted">{t('workflow.selectWorkspace')}</p></section>;

  const readiness = workflow ? workflowReadiness(workflow, providers) : { ready: 0, required: 0 };
  const boundProviders = workflow ? providersForWorkflow(workflow).map((id) => providers.find((provider) => provider.id === id)).filter((provider): provider is ProviderInfo => provider !== undefined) : [];

  return <DndContext sensors={sensors} onDragEnd={onDragEnd}>
    <section aria-labelledby="workflow-heading" className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2"><div className="min-w-0"><h2 id="workflow-heading" className="text-xs font-semibold uppercase tracking-wider text-muted">{t('workflow.launchpad')}</h2><p className="mt-1 truncate text-sm font-medium text-ink">{selectedWorkspace?.name}</p></div>{workflow && <button type="button" aria-haspopup="dialog" aria-expanded={customizing} onClick={() => setCustomizing(true)} className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-accentForeground hover:border-accent">{t('workflow.customize')}</button>}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <section aria-labelledby="workflow-mode-heading">
          <div className="mb-2 flex items-center justify-between"><h3 id="workflow-mode-heading" className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('workflow.chooseMode')}</h3><span className="text-[10px] text-muted">{t('workflow.availableCount', { count: workflows.length })}</span></div>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('workflow.group')}>
            {workflows.map((item) => {
              const selected = item.id === workflowId;
              const itemReadiness = workflowReadiness(edits[item.id] ?? item, providers);
              return <button key={item.id} type="button" aria-pressed={selected} onClick={() => { setWorkflowId(item.id); setOpenSlot(undefined); setOrchestratorOpen(false); }} className={`min-h-24 rounded-lg border p-2.5 text-left transition-colors ${selected ? 'border-accent bg-accentSoft/60' : 'border-border bg-surface/60 hover:border-accentBorder'}`}>
                <span className="flex items-start gap-1.5"><span className="min-w-0 flex-1 text-sm font-semibold text-ink">{item.builtin ? '✦ ' : ''}{displayWorkflowName(item, locale)}</span>{item.id === selectedWorkspace?.defaultWorkflowId && <span className="rounded bg-raised px-1 py-0.5 text-[9px] text-muted">{t('workflow.default')}</span>}</span>
                <span className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted">{displayWorkflowDescription(item, locale) || t('workflow.stageCount', { count: item.stages.length })}</span>
                <span className={`mt-2 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] ${itemReadiness.ready === itemReadiness.required ? 'border-emerald-800 text-emerald-300' : 'border-amber-800 text-amber-300'}`}>{t('workflow.available', { ready: itemReadiness.ready, required: itemReadiness.required })}</span>
              </button>;
            })}
          </div>
        </section>

        {!workflow && <p className="mt-4 text-xs text-muted">{t('workflow.none')}</p>}
        {workflow && <>
          <section aria-labelledby="run-box-heading" className="mt-4 rounded-lg border border-border bg-surface/70 p-3">
            <div className="flex items-center justify-between gap-2"><h3 id="run-box-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">{t('workflow.runTask')}</h3><span className={`rounded-full border px-2 py-0.5 text-[10px] ${readiness.ready === readiness.required ? 'border-emerald-800 text-emerald-300' : 'border-amber-800 text-amber-300'}`}>{readiness.ready === readiness.required ? t('workflow.ready') : t('workflow.needsSetup')} · {readiness.ready}/{readiness.required}</span></div>
            <p className="mt-1 text-[11px] text-muted">{displayWorkflowDescription(workflow, locale)}</p>
            <textarea aria-label={t('workflow.task')} value={task} onChange={(event) => setTask(event.target.value)} rows={6} placeholder={t('workflow.taskPlaceholder')} className="mt-3 w-full resize-y rounded border border-border bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent" />

            <div className="mt-3 space-y-1.5" aria-label={t('workflow.providerReadiness')}>
              {boundProviders.map((provider) => <div key={provider.id} className="flex items-center gap-2 rounded border border-border/80 bg-canvas/60 px-2 py-1.5">
                <span className={`h-2 w-2 rounded-full ${!provider.ok ? 'bg-red-400' : provider.authAlert || provider.environmentCredential?.configured === false ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                <span className="text-xs font-medium text-ink">{provider.id}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-muted">{provider.id === 'mock'
                  ? t('workflow.mockProvider')
                  : !provider.ok
                    ? (provider.detail ? displayProviderDetail(provider.id, provider.detail, locale) : t('workflow.unavailable'))
                    : provider.environmentCredential?.configured === false
                      ? t('workflow.credentialMissing', { name: provider.environmentCredential.name })
                      : provider.authAlert
                        ? t('workflow.authFailure')
                        : `${provider.runtimeFamily ? t('workflow.runtimeDetected', { family: provider.runtimeFamily }) : t('workflow.cliDetected')}${provider.version ? ` · ${provider.version}` : ''}`}</span>
                <ProviderSetupButton provider={provider} api={api} />
              </div>)}
              {boundProviders.length === 0 && <p className="text-[11px] text-muted">{t('workflow.discoveryLoading')}</p>}
            </div>

            {activeRun && <p className="mt-2 text-xs text-amber-300">{t('workflow.activeRun', { status: displayRunStatus(activeRun.status, locale) })}</p>}
            {invalidStage && <p className="mt-2 text-xs text-red-300">{t('workflow.invalidStage', { stage: displayStageName(workflow, invalidStage, locale) })}</p>}
            {providerPreflightError && <p className="mt-2 whitespace-pre-line text-xs text-red-300">{providerPreflightError}</p>}
            {verificationWarnings.length > 0 && <div className="mt-2 rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200" role="status"><strong>{t('workflow.verifyWarning')}</strong><ul className="mt-1 list-inside list-disc space-y-0.5">{verificationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
            {authWarnings.length > 0 && <p className="mt-2 text-xs text-amber-300" role="status">{t('workflow.signInWarning', { warnings: authWarnings.join(' · ') })}</p>}
            {credentialWarnings.length > 0 && <p className="mt-2 text-xs text-amber-300" role="status">{t('workflow.credentialWarning', { warnings: credentialWarnings.join(' · ') })}</p>}
            {baseWorkflow?.builtin && edits[baseWorkflow.id] && <p className="mt-2 text-[11px] text-amber-200">{t('workflow.runScoped')}</p>}
            {!baseWorkflow?.builtin && edits[workflow.id] && <p className="mt-2 text-[11px] text-amber-200">{t('workflow.unsaved')}</p>}
            <button type="button" onClick={() => void startRun()} disabled={!task.trim() || !!activeRun || !!invalidStage || !!providerPreflightError || actionPending || runsLoading} className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-onAccent shadow-lg shadow-violet-950/30 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{actionPending || runsLoading ? t('workflow.working') : t('workflow.start')}</button>
          </section>
          {actionError && <p role="alert" className="mt-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{actionError}</p>}
        </>}
      </div>

      <SideDrawer open={customizing && workflow !== undefined} title={workflow ? t('workflow.customizeNamed', { name: displayWorkflowName(workflow, locale) }) : t('workflow.customizeTitle')} onClose={() => setCustomizing(false)} widthClassName="max-w-2xl">
        {workflow && <>
          <p className="text-sm text-muted">{t('workflow.advancedHelp')}</p>
          {baseWorkflow?.builtin && edits[baseWorkflow.id] && <div className="mt-3 flex items-center justify-between gap-2 rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200"><span>{t('workflow.editingCopy')}</span><button type="button" disabled={actionPending} onClick={() => void duplicateBuiltin()} className="rounded border border-amber-700 px-2 py-1 font-medium hover:bg-amber-900 disabled:opacity-50">{t('workflow.duplicateSave')}</button></div>}
          {!baseWorkflow?.builtin && edits[workflow.id] && <div className="mt-3 flex items-center justify-between rounded border border-border bg-surface p-2 text-xs"><span className="text-muted">{t('workflow.unsavedEdits')}</span><button type="button" disabled={actionPending} onClick={() => void saveCustom()} className="rounded border border-accent px-2 py-1 text-accentForeground disabled:opacity-50">{t('workflow.saveChanges')}</button></div>}
          <section className="mt-4"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('workflow.stages')}</h3><div className="space-y-3">{workflow.stages.map((stage) => <StageEditor key={stage.id} workflow={workflow} stage={stage} providers={providers} api={api} openSlot={openSlot} onOpenSlot={(id) => setOpenSlot((current) => current === id ? undefined : id)} onUpdate={(update) => updateStage(stage.id, update)} />)}</div></section>
          <section className="relative mt-4 rounded border border-border bg-canvas/60 p-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t('workflow.orchestrator')}</h3><label className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="text-muted">{t('workflow.enabled')}</span><input type="checkbox" checked={workflow.orchestrator.enabled} onChange={(event) => commit((copy) => { copy.orchestrator.enabled = event.target.checked; })} /></label><button type="button" onClick={() => setOrchestratorOpen((value) => !value)} className="mt-2 w-full rounded bg-surface px-2 py-1.5 text-left text-xs hover:bg-raised" aria-expanded={orchestratorOpen}>{bindingSummary(workflow.orchestrator.agent, locale)}</button>{orchestratorOpen && <BindingEditor title={t('workflow.orchestratorBinding')} binding={workflow.orchestrator.agent} providers={providers} api={api} onChange={(agent) => commit((copy) => { copy.orchestrator.agent = agent; })} onClose={() => setOrchestratorOpen(false)} />}</section>
          <section aria-labelledby="agent-palette-heading" className="mt-4 rounded border border-border bg-canvas/60 p-3"><h3 id="agent-palette-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">{t('workflow.agentPalette')}</h3><p className="mt-1 text-[11px] text-muted">{t('workflow.paletteHelp')}</p><div className="mt-2 flex flex-wrap gap-2">{providers.map((provider) => <PaletteAgent key={provider.id} provider={provider} api={api} />)}</div><div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2"><select aria-label={t('workflow.stage')} value={fallbackStage} onChange={(event) => setFallbackStage(event.target.value)} className="min-w-0 rounded border border-border bg-canvas px-2 py-1.5 text-xs"><option value="">{t('workflow.stage')}</option>{workflow.stages.map((stage) => <option key={stage.id} value={stage.id} disabled={stageAgentCount(stage) >= MAX_STAGE_AGENTS}>{displayStageName(workflow, stage, locale)}</option>)}</select><select aria-label={t('workflow.provider')} value={fallbackProvider} onChange={(event) => setFallbackProvider(event.target.value)} className="min-w-0 rounded border border-border bg-canvas px-2 py-1.5 text-xs"><option value="">{t('workflow.provider')}</option>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.ok}>{provider.id}{provider.ok ? '' : ` (${t('workflow.unavailableSuffix')})`}</option>)}</select><button type="button" onClick={() => appendProvider(fallbackStage, fallbackProvider)} disabled={!fallbackStage || !fallbackProvider} className="rounded border border-accent px-2 py-1.5 text-xs text-accentForeground disabled:opacity-40">{t('workflow.addAgent')}</button></div></section>
        </>}
      </SideDrawer>
    </section>
  </DndContext>;
}

interface StageEditorProps {
  workflow: WorkflowDef; stage: Stage; providers: ProviderInfo[]; api: ApiClient; openSlot: string | undefined;
  onOpenSlot(id: string): void; onUpdate(update: (stage: Stage) => Stage): void;
}

function StageEditor({ workflow, stage, providers, api, openSlot, onOpenSlot, onUpdate }: StageEditorProps) {
  const { locale, t } = useUiPreferences();
  const stageName = displayStageName(workflow, stage, locale);
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.id}`, data: { stageId: stage.id } });
  const total = stageAgentCount(stage);
  const updateSlot = (slotId: string, update: (slot: Slot) => Slot) => onUpdate((current) => ({ ...current, slots: current.slots.map((slot) => slot.id === slotId ? update(slot) : slot) }));
  return <section ref={setNodeRef} className={`rounded border p-2 ${isOver ? 'border-accent bg-accentSoft/60' : 'border-border bg-surface/60'}`}>
    <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-medium">{stageName}</h3><span className={`text-[11px] ${total > MAX_STAGE_AGENTS || total === 0 ? 'text-red-300' : 'text-muted'}`}>{t('workflow.agentCount', { count: total, max: MAX_STAGE_AGENTS })}</span></div><div className="grid gap-1 text-[11px] text-muted">
      <label className="flex items-center justify-between gap-2">{t('workflow.worktree')} <input type="checkbox" checked={stage.isolation === 'worktree'} onChange={(event) => onUpdate((current) => ({ ...current, isolation: event.target.checked ? 'worktree' : 'none' }))} /></label>
      <label className="flex items-center justify-between gap-2">{t('workflow.gate')} <input type="checkbox" checked={stage.gate} onChange={(event) => onUpdate((current) => ({ ...current, gate: event.target.checked }))} /></label>
      <label className="flex items-center justify-between gap-2">{t('workflow.requireVerified')} <input type="checkbox" checked={stage.requireVerified} onChange={(event) => onUpdate((current) => ({ ...current, requireVerified: event.target.checked }))} /></label>
    </div></div>
    <label className="mt-2 flex items-center gap-2 text-[11px] text-muted">{t('workflow.timeout')} <input aria-label={t('workflow.timeoutNamed', { stage: stageName })} type="number" min={1} value={stage.timeoutSec} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value > 0) onUpdate((current) => ({ ...current, timeoutSec: value })); }} className="w-24 rounded border border-border bg-canvas px-2 py-1 text-ink" /> {t('workflow.seconds')}</label>
    <div className="mt-2 flex flex-wrap gap-2">
      {stage.slots.map((slot) => {
        const popoverId = `${stage.id}:${slot.id}`;
        const slotLabel = displaySlotLabel(workflow, slot.id, slot.label, locale);
        return <div key={slot.id} className="relative"><button type="button" onClick={() => onOpenSlot(popoverId)} aria-expanded={openSlot === popoverId} className="rounded-full outline-none ring-accent focus:ring-2"><AgentChip agent={slot.agent} label={slotLabel} count={slot.count} /></button>{openSlot === popoverId && <SlotEditor workflow={workflow} stage={stage} slot={slot} providers={providers} api={api} onChange={(update) => updateSlot(slot.id, update)} onRemove={() => onUpdate((current) => ({ ...current, slots: current.slots.filter((item) => item.id !== slot.id) }))} onClose={() => onOpenSlot(popoverId)} />}</div>;
      })}
      {stage.slots.length === 0 && <span className="text-xs text-red-300">{t('workflow.dropAgent')}</span>}
    </div>
  </section>;
}

function SlotEditor({ workflow, stage, slot, providers, api, onChange, onRemove, onClose }: { workflow: WorkflowDef; stage: Stage; slot: Slot; providers: ProviderInfo[]; api: ApiClient; onChange(update: (slot: Slot) => Slot): void; onRemove(): void; onClose(): void }) {
  const { locale, t } = useUiPreferences();
  const slotLabel = displaySlotLabel(workflow, slot.id, slot.label, locale);
  const provider = providers.find((item) => item.id === slot.agent.provider);
  const canIncrease = validateSlotCount(stage, slot.id, slot.count + 1).valid;
  const editAgent = (update: (agent: AgentBinding) => void) => onChange((current) => { const agent = { ...current.agent }; update(agent); return { ...current, agent }; });
  return <div role="dialog" aria-label={t('workflow.editSlot', { slot: slotLabel })} className="absolute left-0 top-full z-30 mt-2 w-72 rounded border border-accent bg-panel p-3 shadow-2xl">
    <div className="flex items-center justify-between"><strong className="text-xs">{slotLabel}</strong><button type="button" onClick={onClose} aria-label={t('workflow.closeSlot')} className="text-muted hover:text-ink">×</button></div>
    <ProviderModelEditor key={slot.agent.provider} provider={provider} model={slot.agent.model} api={api} onChange={(model) => editAgent((agent) => { if (model) agent.model = model; else delete agent.model; })} />
    <label className="mt-2 block text-xs text-muted">{t('workflow.effort')}<select value={slot.agent.effort ?? ''} onChange={(event) => editAgent((agent) => { if (event.target.value) agent.effort = event.target.value as NonNullable<AgentBinding['effort']>; else delete agent.effort; })} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink"><option value="">{t('workflow.defaultOption')}</option>{(['low', 'medium', 'high', 'xhigh'] as const).map((effort) => <option key={effort} value={effort}>{displayEffort(effort, locale)}</option>)}</select></label>
    <div className="mt-2 text-xs text-muted">{t('workflow.count')}<div className="mt-1 inline-flex items-center rounded border border-border bg-canvas"><button type="button" aria-label={t('workflow.decreaseCount')} disabled={slot.count <= 1} onClick={() => onChange((current) => ({ ...current, count: current.count - 1 }))} className="px-3 py-1 disabled:opacity-30">−</button><output className="min-w-8 text-center text-ink">{slot.count}</output><button type="button" aria-label={t('workflow.increaseCount')} disabled={!canIncrease} onClick={() => onChange((current) => ({ ...current, count: current.count + 1 }))} className="px-3 py-1 disabled:opacity-30">+</button></div></div>
    <label className="mt-2 block text-xs text-muted">{t('workflow.permission')}<select value={slot.agent.permission} onChange={(event) => editAgent((agent) => { agent.permission = event.target.value as AgentBinding['permission']; })} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink">{(['safe', 'auto', 'full'] as const).map((permission) => <option key={permission} value={permission}>{displayPermission(permission, locale)}</option>)}</select></label>
    <label className="mt-2 block text-xs text-muted">{t('workflow.promptTemplate')}<textarea value={slot.promptTemplate} onChange={(event) => onChange((current) => ({ ...current, promptTemplate: event.target.value }))} rows={5} className="mt-1 w-full resize-y rounded border border-border bg-canvas px-2 py-1.5 font-mono text-xs text-ink" /></label>
    <button type="button" onClick={onRemove} className="mt-3 text-xs text-red-300 hover:text-red-200">{t('workflow.removeSlot')}</button>
  </div>;
}

function BindingEditor({ title, binding, providers, api, onChange, onClose }: { title: string; binding: AgentBinding; providers: ProviderInfo[]; api: ApiClient; onChange(value: AgentBinding): void; onClose(): void }) {
  const { locale, t } = useUiPreferences();
  const provider = providers.find((item) => item.id === binding.provider);
  const edit = (update: (copy: AgentBinding) => void) => { const copy = { ...binding }; update(copy); onChange(copy); };
  return <div role="dialog" aria-label={title} className="absolute left-0 top-full z-30 mt-2 w-full rounded border border-accent bg-panel p-3 shadow-2xl">
    <div className="flex items-center justify-between"><strong className="text-xs">{title}</strong><button type="button" onClick={onClose} aria-label={t('workflow.closeOrchestrator')} className="text-muted">×</button></div>
    <label className="mt-2 block text-xs text-muted">{t('workflow.provider')}<select value={binding.provider} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); if (next) onChange({ ...binding, provider: next.id, model: next.defaultModel }); }} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink">{providers.map((item) => <option key={item.id} value={item.id} disabled={!item.ok}>{item.id}</option>)}</select></label>
    <ProviderModelEditor key={binding.provider} provider={provider} model={binding.model} api={api} onChange={(model) => edit((copy) => { if (model) copy.model = model; else delete copy.model; })} />
    <label className="mt-2 block text-xs text-muted">{t('workflow.effort')}<select value={binding.effort ?? ''} onChange={(event) => edit((copy) => { if (event.target.value) copy.effort = event.target.value as NonNullable<AgentBinding['effort']>; else delete copy.effort; })} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink"><option value="">{t('workflow.defaultOption')}</option>{(['low', 'medium', 'high', 'xhigh'] as const).map((effort) => <option key={effort} value={effort}>{displayEffort(effort, locale)}</option>)}</select></label>
    <label className="mt-2 block text-xs text-muted">{t('workflow.permission')}<select value={binding.permission} onChange={(event) => onChange({ ...binding, permission: event.target.value as AgentBinding['permission'] })} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink">{(['safe', 'auto', 'full'] as const).map((permission) => <option key={permission} value={permission}>{displayPermission(permission, locale)}</option>)}</select></label>
  </div>;
}

const CUSTOM_MODEL = '__custom__';

function ProviderModelEditor({ provider, model, api, onChange }: {
  provider: ProviderInfo | undefined;
  model: string | undefined;
  api: ApiClient;
  onChange(model?: string): void;
}) {
  if (provider?.id === 'openrouter') {
    return <OpenRouterModelEditor provider={provider} model={model} api={api} onChange={onChange} />;
  }
  return <ModelEditor model={model} models={provider?.models ?? []} onChange={onChange} />;
}

function fallbackOpenRouterCatalog(provider: ProviderInfo): OpenRouterModelCatalog {
  const ids = [...new Set([provider.defaultModel, ...provider.models].filter((value) => value.length > 0))];
  return {
    source: 'fallback',
    groups: ids.map((id) => ({
      id,
      label: id,
      defaultVersion: id,
      versions: [{
        id,
        label: id,
        kind: id.startsWith('~') ? 'latest' : 'current',
        supportsTools: true,
      }],
    })),
  };
}

function findOpenRouterSelection(groups: readonly OpenRouterModelGroup[], model: string | undefined): {
  group: OpenRouterModelGroup;
  version: OpenRouterModelVersion;
} | undefined {
  if (!model) return undefined;
  for (const group of groups) {
    const version = group.versions.find((candidate) => candidate.id === model);
    if (version) return { group, version };
  }
  return undefined;
}

function OpenRouterModelEditor({ provider, model, api, onChange }: {
  provider: ProviderInfo;
  model: string | undefined;
  api: ApiClient;
  onChange(model?: string): void;
}) {
  const { t } = useUiPreferences();
  const fallback = useMemo(() => fallbackOpenRouterCatalog(provider), [provider.defaultModel, provider.models]);
  const [catalog, setCatalog] = useState<OpenRouterModelCatalog>(fallback);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [customSelected, setCustomSelected] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    setCatalog(fallback);
    setLoading(true);
    setLoaded(false);
    void api.getOpenRouterModels().then((next) => {
      if (current) setCatalog(next.groups.length > 0 ? next : fallback);
    }).catch(() => {
      if (current) setCatalog(fallback);
    }).finally(() => {
      if (current) {
        setLoading(false);
        setLoaded(true);
      }
    });
    return () => { current = false; };
  }, [api, fallback]);

  const selection = findOpenRouterSelection(catalog.groups, model);
  const isUnknownModel = loaded && model !== undefined && model !== '' && selection === undefined;
  const showCustom = customSelected || isUnknownModel;
  const selectedGroup = showCustom ? undefined : selection?.group;
  const selectedVersion = showCustom ? undefined : selection?.version;

  // Once an existing/custom slug opens the escape hatch, keep it open even if
  // the user types through a catalog value on the way to a longer variant.
  useEffect(() => {
    if (isUnknownModel) setCustomSelected(true);
  }, [isUnknownModel]);
  useEffect(() => {
    if (showCustom) customRef.current?.focus();
  }, [showCustom]);

  const versionLabel = (version: OpenRouterModelVersion): string => {
    const kind = t(version.kind === 'latest'
      ? 'workflow.openRouterVersionLatest'
      : version.kind === 'pinned'
        ? 'workflow.openRouterVersionPinned'
        : 'workflow.openRouterVersionCurrent');
    const detail = version.kind === 'latest' ? kind : `${kind} · ${version.label}`;
    return version.supportsTools ? detail : `${detail} · ${t('workflow.openRouterToolsUnknown')}`;
  };

  return <div className="mt-2">
    <label className="block text-xs text-muted">{t('workflow.model')}
      <select aria-label={t('workflow.model')} value={showCustom ? CUSTOM_MODEL : (selectedGroup?.id ?? '')} onChange={(event) => {
        const value = event.target.value;
        if (value === CUSTOM_MODEL) {
          setCustomSelected(true);
          onChange(undefined);
          return;
        }
        setCustomSelected(false);
        if (!value) {
          onChange(undefined);
          return;
        }
        const group = catalog.groups.find((candidate) => candidate.id === value);
        onChange(group?.defaultVersion);
      }} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink">
        <option value="">{t('workflow.defaultOption')}</option>
        {catalog.groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
        <option value={CUSTOM_MODEL}>{t('workflow.customOption')}</option>
      </select>
    </label>
    <label className="mt-2 block text-xs text-muted">{t('workflow.version')}
      <select aria-label={t('workflow.version')} disabled={!selectedGroup} value={selectedVersion?.id ?? ''} onChange={(event) => onChange(event.target.value || undefined)} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-50">
        {!selectedGroup && <option value="">{t('workflow.selectModelFirst')}</option>}
        {selectedGroup?.versions.map((version) => <option key={version.id} value={version.id}>{versionLabel(version)}</option>)}
      </select>
    </label>
    {loading && <p className="mt-1 text-[10px] text-muted" role="status">{t('workflow.openRouterCatalogLoading')}</p>}
    {!loading && catalog.source === 'stale' && <p className="mt-1 text-[10px] text-amber-200" role="status">{t('workflow.openRouterCatalogStale')}</p>}
    {!loading && catalog.source === 'fallback' && <p className="mt-1 text-[10px] text-amber-200" role="status">{t('workflow.openRouterCatalogFallback')}</p>}
    {showCustom && <input ref={customRef} aria-label={t('workflow.customModel')} value={model ?? ''} onChange={(event) => onChange(event.target.value || undefined)} className="mt-2 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink" />}
  </div>;
}

function ModelEditor({ model, models, onChange }: { model: string | undefined; models: string[]; onChange(model?: string): void }) {
  const { t } = useUiPreferences();
  const isCustomModel = model !== undefined && model !== '' && !models.includes(model);
  const [customSelected, setCustomSelected] = useState(isCustomModel);
  const customRef = useRef<HTMLInputElement>(null);
  const showCustom = customSelected || isCustomModel;
  // Never auto-collapse: a custom value can pass through a listed model while
  // being typed (e.g. `sonnet` on the way to `sonnet[1m]`).
  useEffect(() => {
    if (isCustomModel) setCustomSelected(true);
  }, [isCustomModel]);
  useEffect(() => { if (showCustom) customRef.current?.focus(); }, [showCustom]);
  return <label className="mt-2 block text-xs text-muted">{t('workflow.model')}
    <select aria-label={t('workflow.model')} value={showCustom ? CUSTOM_MODEL : (model ?? '')} onChange={(event) => {
      if (event.target.value === CUSTOM_MODEL) { setCustomSelected(true); onChange(undefined); }
      else { setCustomSelected(false); onChange(event.target.value || undefined); }
    }} className="mt-1 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink">
      <option value="">{t('workflow.defaultOption')}</option>
      {models.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
      <option value={CUSTOM_MODEL}>{t('workflow.customOption')}</option>
    </select>
    {showCustom && <input ref={customRef} aria-label={t('workflow.customModel')} value={model ?? ''} onChange={(event) => onChange(event.target.value || undefined)} className="mt-2 w-full rounded border border-border bg-canvas px-2 py-1.5 text-ink" />}
  </label>;
}

function PaletteAgent({ provider, api }: { provider: ProviderInfo; api: ApiClient }) {
  const { locale, t } = useUiPreferences();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `provider-${provider.id}`, data: { providerId: provider.id }, disabled: !provider.ok });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const localizedDetail = provider.detail ? displayProviderDetail(provider.id, provider.detail, locale) : undefined;
  const credentialMissing = provider.environmentCredential?.configured === false;
  const unavailable = localizedDetail ? t('workflow.providerUnavailableDetail', { detail: localizedDetail }) : t('workflow.providerUnavailable');
  const title = credentialMissing
    ? t('workflow.credentialMissing', { name: provider.environmentCredential!.name })
    : provider.authAlert?.message ?? (provider.ok ? t('workflow.dragProvider', { provider: provider.id, version: provider.version ? ` · ${provider.version}` : '' }) : unavailable);
  const providerLabel = provider.ok
    ? t('workflow.providerAriaReady', { provider: provider.id })
    : t('workflow.providerAriaUnavailable', { provider: provider.id, detail: localizedDetail ?? t('workflow.notDetected') });
  const ariaLabel = credentialMissing
    ? `${providerLabel}${locale === 'zh-TW' ? '・' : ' '}${t('workflow.environmentCredentialRequired')}`
    : provider.authAlert
      ? `${providerLabel}${locale === 'zh-TW' ? '・' : ' '}${t('workflow.authenticationRequired')}`
      : providerLabel;
  return <span title={title} className="relative inline-flex items-center gap-1"><button ref={setNodeRef} type="button" style={style} {...listeners} {...attributes} disabled={!provider.ok} aria-label={ariaLabel} className={`rounded-full text-left ${provider.ok ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed grayscale opacity-40'} ${(provider.authAlert || credentialMissing) && provider.ok ? 'ring-1 ring-amber-500' : ''} ${isDragging ? 'z-50 opacity-70' : ''}`}><AgentChip agent={{ provider: provider.id, model: provider.defaultModel, permission: 'auto' }} /></button>{provider.authAlert && !credentialMissing && <span className="rounded border border-amber-700 bg-amber-950/50 px-1 py-0.5 text-[9px] font-medium text-amber-300">{t('workflow.auth')}</span>}{credentialMissing && <span className="rounded border border-amber-700 bg-amber-950/50 px-1 py-0.5 text-[9px] font-medium text-amber-300">{t('workflow.credential')}</span>}{provider.version && <span className="max-w-24 truncate text-[10px] text-muted">{provider.version}</span>}<ProviderSetupButton provider={provider} api={api} /></span>;
}

function bindingSummary(binding: AgentBinding, locale: UiLocale): string {
  return [binding.provider, binding.model, binding.effort ? displayEffort(binding.effort, locale) : undefined, displayPermission(binding.permission, locale)].filter(Boolean).join(' · ');
}

export function unavailableProviderBindings(workflow: WorkflowDef, providers: readonly ProviderInfo[], locale: UiLocale = 'en'): string[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const bindings = workflow.stages.flatMap((stage) => stage.slots.map((slot) => ({ label: displaySlotLabel(workflow, slot.id, slot.label, locale), provider: slot.agent.provider })));
  if (workflow.orchestrator.enabled) bindings.push({ label: locale === 'zh-TW' ? '協調者' : 'Orchestrator', provider: workflow.orchestrator.agent.provider });
  return bindings.flatMap(({ label, provider }) => {
    const availability = byId.get(provider);
    if (availability?.ok === true) return [];
    const detail = availability?.detail ? displayProviderDetail(provider, availability.detail, locale) : (locale === 'zh-TW' ? '未偵測到' : 'not detected');
    return [locale === 'zh-TW' ? `${label} · ${provider} 無法使用：${detail}` : `${label} · ${provider} unavailable: ${detail}`];
  });
}

export function workflowReadiness(workflow: WorkflowDef, providers: readonly ProviderInfo[]): { ready: number; required: number } {
  const availability = new Map(providers.map((provider) => [
    provider.id,
    provider.ok && provider.environmentCredential?.configured !== false,
  ]));
  const bindings = workflow.stages.flatMap((stage) => stage.slots.flatMap((slot) => Array.from({ length: slot.count }, () => slot.agent.provider)));
  if (workflow.orchestrator.enabled) bindings.push(workflow.orchestrator.agent.provider);
  return { ready: bindings.filter((provider) => availability.get(provider) === true).length, required: bindings.length };
}

function providersForWorkflow(workflow: WorkflowDef): Array<ProviderInfo['id']> {
  const ids = new Set<ProviderInfo['id']>(workflow.stages.flatMap((stage) => stage.slots.map((slot) => slot.agent.provider)));
  if (workflow.orchestrator.enabled) ids.add(workflow.orchestrator.agent.provider);
  return [...ids];
}

function workflowAuthWarnings(workflow: WorkflowDef, providers: readonly ProviderInfo[]): string[] {
  const used = new Set(workflow.stages.flatMap((stage) => stage.slots.map((slot) => slot.agent.provider)));
  if (workflow.orchestrator.enabled) used.add(workflow.orchestrator.agent.provider);
  return providers
    .filter((provider) => used.has(provider.id) && provider.authAlert && provider.environmentCredential?.configured !== false)
    .map((provider) => provider.authAlert!.message.split('\n', 1)[0]!);
}

function workflowCredentialWarnings(workflow: WorkflowDef, providers: readonly ProviderInfo[]): string[] {
  const used = new Set(workflow.stages.flatMap((stage) => stage.slots.map((slot) => slot.agent.provider)));
  if (workflow.orchestrator.enabled) used.add(workflow.orchestrator.agent.provider);
  return providers
    .filter((provider) => used.has(provider.id) && provider.environmentCredential?.configured === false)
    .map((provider) => `${provider.id}: ${provider.environmentCredential!.name}`);
}

export function workflowVerificationWarnings(workflow: WorkflowDef, verifyCommand?: string, locale: UiLocale = 'en'): string[] {
  return workflow.stages.flatMap((stage) => {
    if (!stage.requireVerified) return [];
    const warnings: string[] = [];
    const stageName = displayStageName(workflow, stage, locale);
    if (!stage.gate) warnings.push(locale === 'zh-TW' ? `${stageName}：「必須通過驗證」需要啟用關卡，否則此政策不會執行。` : `${stageName}: “require verified” needs an enabled gate; the policy will not run.`);
    if (stage.isolation !== 'worktree') warnings.push(locale === 'zh-TW' ? `${stageName}：「必須通過驗證」需要隔離工作樹，否則會略過驗證。` : `${stageName}: “require verified” needs worktree isolation; verification will be skipped.`);
    if (!verifyCommand?.trim()) warnings.push(locale === 'zh-TW' ? `${stageName}：「必須通過驗證」需要工作區驗證指令，否則會略過驗證。` : `${stageName}: “require verified” needs a workspace verify command; verification will be skipped.`);
    return warnings;
  });
}
