import type { AgentEvent, ApplyPatchResponse, GateDecision, NodeRun, RunSnapshot, Stage } from '@mat/shared';
import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../api/client.js';
import { matStore, useMatStore } from '../../app/store.js';
import { AgentChip, Collapsible, displayNodeLabel, ModalDialog, PROVIDER_COLORS } from '../../components/index.js';
import { useUiPreferences } from '../../i18n/UiPreferences.js';
import { canComposeSteer, canRetryStage, decisionDisplay, elapsedForNode, formatElapsed, nodeDisplayStatus, steerGroups, verificationSummary, type NodeDisplayStatus } from './runLogic.js';

const STATUS_STYLE: Record<NodeDisplayStatus, string> = {
  queued: 'bg-control text-ink',
  running: 'bg-sky-950 text-sky-200 ring-1 ring-sky-500/40',
  thinking: 'animate-pulse bg-violet-950 text-violet-200 ring-1 ring-violet-500/50',
  stalled: 'bg-amber-950 text-amber-200 ring-1 ring-amber-500/50',
  done: 'bg-emerald-950 text-emerald-200 ring-1 ring-emerald-500/40',
  failed: 'bg-red-950 text-red-200 ring-1 ring-red-500/50',
  killed: 'bg-raised text-ink ring-1 ring-border',
};

const STATUS_LABEL_KEY: Record<NodeDisplayStatus, 'status.queued' | 'status.running' | 'status.thinking' | 'status.stalled' | 'status.done' | 'status.failed' | 'status.killed'> = {
  queued: 'status.queued', running: 'status.running', thinking: 'status.thinking', stalled: 'status.stalled',
  done: 'status.done', failed: 'status.failed', killed: 'status.killed',
};

interface PatchDialogState {
  runId: string;
  node: NodeRun;
  loading: boolean;
  applying: boolean;
  content?: string;
  error?: string;
  result?: ApplyPatchResponse;
}

// Selectors must return referentially stable values: a fresh `[]` per call
// makes useSyncExternalStore re-render forever (React #185).
const EMPTY_EVENTS: readonly AgentEvent[] = [];

export function RunPanel() {
  const { t } = useUiPreferences();
  const viewedRunId = useMatStore((state) => state.viewedRunId);
  const run = useMatStore((state) => viewedRunId ? state.runs[viewedRunId] : undefined);
  const events = useMatStore((state) => (viewedRunId ? state.events[viewedRunId] : undefined) ?? EMPTY_EVENTS);
  const focusNode = useMatStore((state) => state.focusNode);
  const upsertRun = useMatStore((state) => state.upsertRun);
  const [now, setNow] = useState(Date.now());
  const [killConfirmation, setKillConfirmation] = useState<string>();
  const [retryStage, setRetryStage] = useState<Stage>();
  const [retryAddendum, setRetryAddendum] = useState('');
  const [patchDialog, setPatchDialog] = useState<PatchDialogState>();
  const [actionError, setActionError] = useState<string>();
  const [report, setReport] = useState<{ loading: boolean; content?: string; error?: string }>();
  const [steerText, setSteerText] = useState('');
  const [steerMode, setSteerMode] = useState<'interrupt'|'queue'>('interrupt');
  const [steering, setSteering] = useState(false);
  const [debugging, setDebugging] = useState(false);

  useEffect(() => {
    setKillConfirmation(undefined);
    setRetryStage(undefined);
    setRetryAddendum('');
    setPatchDialog(undefined);
    setActionError(undefined);
    setReport(undefined);
    setSteerText('');
    setSteering(false);
    setDebugging(false);
  }, [viewedRunId]);

  useEffect(() => {
    if (!run?.nodes.some((node) => node.startedAt !== undefined && node.endedAt === undefined)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.nodes]);

  const latestByNode = useMemo(() => {
    const result = new Map<string, AgentEvent>();
    for (const event of events) if (event.nodeRunId) result.set(event.nodeRunId, event);
    return result;
  }, [events]);
  const seedByNode = useMemo(() => {
    const result = new Map<string, AgentEvent>();
    if (!run) return result;
    const attempts = new Map(run.nodes.map((node) => [node.nodeRunId, node.attempt]));
    for (const event of events) {
      if (event.role === 'user' && event.nodeRunId && attempts.get(event.nodeRunId) === event.attempt && !result.has(event.nodeRunId)) result.set(event.nodeRunId, event);
    }
    return result;
  }, [events, run]);
  const steerGroupList = useMemo(() => run ? steerGroups(run) : [], [run]);

  if (!run) return <section className="h-full overflow-auto p-3" aria-label={t('run.panel')}>
    <PanelHeading />
    <div className="rounded border border-dashed border-border p-4 text-xs text-muted">
      {t('run.noRun')}
    </div>
  </section>;

  const orchestrator = run.nodes.find((node) => node.nodeRunId === 'orchestrator');
  const nonTerminal = !['done', 'failed', 'aborted'].includes(run.status);
  const doKill = async (nodeRunId: string) => {
    setActionError(undefined);
    try { upsertRun(await apiClient.killNode(run.runId, nodeRunId)); setKillConfirmation(undefined); }
    catch (error) { setActionError(errorMessage(error)); }
  };
  const openPatch = (node: NodeRun) => {
    const patchRunId = run.runId;
    setPatchDialog({ runId: patchRunId, node, loading: true, applying: false });
    void apiClient.getPatch(patchRunId, node.nodeRunId)
      .then((content) => setPatchDialog((current) => current?.runId === patchRunId && current.node.nodeRunId === node.nodeRunId ? { ...current, loading: false, content } : current))
      .catch((error) => setPatchDialog((current) => current?.runId === patchRunId && current.node.nodeRunId === node.nodeRunId ? { ...current, loading: false, error: errorMessage(error) } : current));
  };
  const applyPatch = async () => {
    if (!patchDialog) return;
    const patchRunId = patchDialog.runId;
    const patchNodeRunId = patchDialog.node.nodeRunId;
    setPatchDialog({ runId: patchRunId, node: patchDialog.node, loading: patchDialog.loading, applying: true, ...(patchDialog.content !== undefined ? { content: patchDialog.content } : {}) });
    try {
      const result = await apiClient.applyPatch(patchRunId, patchNodeRunId);
      setPatchDialog((current) => current?.runId === patchRunId && current.node.nodeRunId === patchNodeRunId ? { ...current, applying: false, result } : current);
    } catch (error) {
      setPatchDialog((current) => current?.runId === patchRunId && current.node.nodeRunId === patchNodeRunId ? { ...current, applying: false, error: errorMessage(error) } : current);
    }
  };
  const submitRetry = async () => {
    if (!retryStage) return;
    setActionError(undefined);
    try {
      const updated = await apiClient.retryStage(run.runId, retryStage.id, retryAddendum.trim() ? { promptAddendum: retryAddendum.trim() } : {});
      upsertRun(updated); setRetryStage(undefined); setRetryAddendum('');
    } catch (error) { setActionError(errorMessage(error)); }
  };
  const openReport = () => {
    const reportRunId = run.runId;
    setReport({ loading: true });
    void apiClient.getReport(reportRunId)
      .then((content) => { if (matStore.getState().viewedRunId === reportRunId) setReport({ loading: false, content }); })
      .catch((error) => { if (matStore.getState().viewedRunId === reportRunId) setReport({ loading: false, error: errorMessage(error) }); });
  };
  const downloadReport = () => {
    if (!report?.content) return;
    const url = URL.createObjectURL(new Blob([report.content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `mat-run-${run.runId}.md`; link.click(); URL.revokeObjectURL(url);
  };
  const submitSteer = async () => {
    const text = steerText.trim();
    if (!text || !canComposeSteer(run)) return;
    setSteering(true); setActionError(undefined);
    try { upsertRun(await apiClient.steerRun(run.runId, { text, mode: steerMode })); setSteerText(''); }
    catch (error) { setActionError(errorMessage(error)); }
    finally { setSteering(false); }
  };
  const downloadDebug = async () => {
    const debugRunId = run.runId;
    setDebugging(true); setActionError(undefined);
    try {
      const blob = await apiClient.getDebugBundle(debugRunId);
      if (matStore.getState().viewedRunId !== debugRunId) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `mat-debug-${debugRunId}.zip`; link.click(); URL.revokeObjectURL(url);
    } catch (error) {
      if (matStore.getState().viewedRunId === debugRunId) setActionError(errorMessage(error));
    } finally {
      if (matStore.getState().viewedRunId === debugRunId) setDebugging(false);
    }
  };

  const card = (node: NodeRun) => <NodeCard
    key={node.nodeRunId}
    node={node}
    displayLabel={displayNodeLabel(node, run.nodes)}
    latestEvent={latestByNode.get(node.nodeRunId)}
    {...(seedByNode.get(node.nodeRunId)?.text ? { seedPrompt: seedByNode.get(node.nodeRunId)!.text } : {})}
    now={now}
    confirmingKill={killConfirmation === node.nodeRunId}
    onRequestKill={() => setKillConfirmation(node.nodeRunId)}
    onCancelKill={() => setKillConfirmation(undefined)}
    onKill={() => void doKill(node.nodeRunId)}
    onPatch={() => openPatch(node)}
    onFocus={() => focusNode(node.nodeRunId)}
  />;

  return <section className="h-full overflow-auto p-3" aria-label={t('run.panel')}>
    <PanelHeading onReport={openReport} onDebug={() => void downloadDebug()} debugging={debugging} />
    <p className="mb-3 line-clamp-3 text-sm text-ink" title={run.task}>{run.task}</p>
    {nonTerminal && <form className="mb-3 space-y-1.5" onSubmit={(event) => { event.preventDefault(); void submitSteer(); }}>
      <input type="text" maxLength={4000} disabled={!canComposeSteer(run)} value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder={t('run.steerPlaceholder')} aria-label={t('run.steerInstruction')} className="w-full rounded border border-border bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50" />
      <div className="flex items-center gap-1.5">
        <button type="button" aria-pressed={steerMode === 'interrupt'} onClick={() => setSteerMode('interrupt')} className={`rounded border px-2 py-1 text-[10px] ${steerMode === 'interrupt' ? 'border-accentBorder text-accentForeground' : 'border-border text-muted'}`}>{t('run.interrupt')}</button>
        <button type="button" aria-pressed={steerMode === 'queue'} onClick={() => setSteerMode('queue')} className={`rounded border px-2 py-1 text-[10px] ${steerMode === 'queue' ? 'border-accentBorder text-accentForeground' : 'border-border text-muted'}`}>{t('run.queue')}</button>
        <button type="submit" disabled={steering || !steerText.trim() || !canComposeSteer(run)} className="ml-auto rounded bg-accent px-2.5 py-1 text-[11px] text-onAccent hover:brightness-110 disabled:opacity-40">{steering ? t('run.sending') : t('run.send')}</button>
      </div>
    </form>}
    {actionError && <p role="alert" className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-200">{actionError}</p>}
    {orchestrator && <div className="mb-4" data-testid="orchestrator-group">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-accentForeground">{t('run.orchestrator')}</div>
      {card(orchestrator)}
    </div>}
    <div className="space-y-4">
      {run.workflow.stages.map((stage) => {
        const stageNodes = run.nodes.filter((node) => node.stageId === stage.id);
        const decisions = run.gateDecisions.filter((decision) => decision.stageId === stage.id).sort((a, b) => a.gateAttempt - b.gateAttempt);
        return <section key={stage.id} aria-labelledby={`stage-${stage.id}`}>
          <header className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0"><h3 id={`stage-${stage.id}`} className="truncate text-xs font-semibold text-ink">{stage.name}</h3><span className="text-[10px] text-muted">{t('run.nodes', { count: stageNodes.length, unit: t(stageNodes.length === 1 ? 'run.node' : 'run.nodePlural') })}</span></div>
            <button type="button" disabled={!canRetryStage(run, stage.id)} onClick={() => { setRetryStage(stage); setRetryAddendum(''); }} className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-35">{t('run.retryStage')}</button>
          </header>
          <div className="grid gap-2">{stageNodes.map(card)}</div>
          {decisions.map((decision) => <DecisionCard key={`${decision.stageId}-${decision.gateAttempt}`} decision={decision} run={run} />)}
        </section>;
      })}
      {steerGroupList.map(({ steer, nodes, decisions }) => <section key={steer.steerId} aria-labelledby={`steer-${steer.steerId}`} data-testid="steer-group">
        <header className="mb-2">
          <div className="flex min-w-0 items-center gap-1.5"><h3 id={`steer-${steer.steerId}`} className="shrink-0 text-xs font-semibold text-accentForeground">{steer.steerStageId ? `${t('run.steer')} ${steer.steerStageId.split('-').at(-1)}` : t('run.steer')}</h3><span className="rounded bg-accentSoft px-1.5 py-0.5 text-[10px] text-accentForeground">{steer.mode}</span><span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink">{steer.status}</span></div>
          <p className="mt-1 truncate text-[11px] text-muted" title={steer.text}>{steer.text}</p>
        </header>
        <div className="grid gap-2">{nodes.map(card)}</div>
        {decisions.map((decision) => <DecisionCard key={`${decision.stageId}-${decision.gateAttempt}`} decision={decision} run={run} />)}
      </section>)}
    </div>
    <ModalDialog open={patchDialog !== undefined} title={patchDialog ? `${t('run.patch')} · ${displayNodeLabel(patchDialog.node, run.nodes)}` : t('run.patch')} onClose={() => setPatchDialog(undefined)} footer={patchDialog && !patchDialog.loading && !patchDialog.error ? <button type="button" disabled={patchDialog.applying} onClick={() => void applyPatch()} className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-50">{patchDialog.applying ? t('run.applying') : t('run.applyPatch')}</button> : undefined}>
      {patchDialog?.loading && <p className="animate-pulse text-sm text-muted">{t('run.loadingPatch')}</p>}
      {patchDialog?.error && <p role="alert" className="text-sm text-red-300">{patchDialog.error}</p>}
      {patchDialog?.content !== undefined && <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded bg-canvas p-3 text-xs text-ink">{patchDialog.content || t('run.emptyPatch')}</pre>}
      {patchDialog?.result && <ApplyPatchResult result={patchDialog.result} />}
    </ModalDialog>
    <ModalDialog open={retryStage !== undefined} title={retryStage ? t('run.retryNamed', { name: retryStage.name }) : t('run.retryStage')} onClose={() => setRetryStage(undefined)} footer={<button type="button" onClick={() => void submitRetry()} className="rounded bg-accent px-3 py-1.5 text-sm text-onAccent hover:brightness-110">{t('run.retryStage')}</button>}>
      <label className="block text-xs text-muted">{t('run.optionalAddendum')}<textarea value={retryAddendum} onChange={(event) => setRetryAddendum(event.target.value)} rows={4} placeholder={t('run.addendumPlaceholder')} className="mt-2 w-full resize-y rounded border border-border bg-canvas p-2 text-sm text-ink outline-none focus:border-accent" /></label>
    </ModalDialog>
    <ModalDialog open={report !== undefined} title={t('run.reportNamed', { id: run.runId })} onClose={() => setReport(undefined)} footer={report?.content ? <div className="flex justify-end gap-2"><button type="button" onClick={() => void navigator.clipboard.writeText(report.content ?? '')} className="rounded-none border border-border px-3 py-1.5 text-xs text-ink hover:border-emerald-600">{t('run.copy')}</button><button type="button" onClick={downloadReport} className="rounded-none bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600">{t('run.downloadMd')}</button></div> : undefined}>
      {report?.loading && <p className="text-xs text-muted">{t('run.loadingReport')}</p>}
      {report?.error && <p role="alert" className="text-xs text-red-300">{report.error}</p>}
      {report?.content && <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap text-xs text-ink">{report.content}</pre>}
    </ModalDialog>
  </section>;
}

function PanelHeading({ onReport, onDebug, debugging }: { onReport?: () => void; onDebug?: () => void; debugging?: boolean }) {
  const { t } = useUiPreferences();
  return <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('run.title')}</h2><div className="flex gap-1.5">{onReport && <button type="button" onClick={onReport} className="rounded-none border border-border px-2 py-1 text-[11px] text-ink hover:border-emerald-600 hover:text-emerald-300">{t('run.report')}</button>}{onDebug && <button type="button" disabled={debugging} onClick={onDebug} className="rounded-none border border-border px-2 py-1 text-[11px] text-ink hover:border-accent hover:text-accentForeground disabled:opacity-50">{debugging ? t('run.debugging') : t('run.debug')}</button>}</div></div>;
}

interface NodeCardProps {
  node: NodeRun;
  displayLabel?: string;
  latestEvent: AgentEvent | undefined;
  seedPrompt?: string;
  now: number;
  confirmingKill: boolean;
  onRequestKill(): void;
  onCancelKill(): void;
  onKill(): void;
  onPatch(): void;
  onFocus(): void;
}

export function NodeCard({ node, displayLabel = node.label, latestEvent, seedPrompt, now, confirmingKill, onRequestKill, onCancelKill, onKill, onPatch, onFocus }: NodeCardProps) {
  const { t } = useUiPreferences();
  const displayStatus = nodeDisplayStatus(node, latestEvent);
  const elapsed = elapsedForNode(node, now);
  const canKill = ['queued', 'running', 'stalled'].includes(node.status);
  return <article data-node-run-id={node.nodeRunId} className="rounded-md border bg-surface/65 p-2.5 shadow-sm" style={{ borderColor: PROVIDER_COLORS[node.agent.provider] }}>
    <div className="mb-2 flex items-start justify-between gap-2">
      <AgentChip agent={node.agent} label={displayLabel} className="min-w-0" />
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[displayStatus]}`}>{t(STATUS_LABEL_KEY[displayStatus])}</span>
    </div>
    <div className="mb-2 flex items-center gap-2 text-[10px] text-muted">
      <span>{elapsed === undefined ? t('run.notStarted') : formatElapsed(elapsed)}</span>
      {node.attempt > 1 && <span className="rounded bg-accentSoft px-1.5 py-0.5 text-accentForeground">{t('run.attempt', { count: node.attempt })}</span>}
      <UsageSummary node={node} />
    </div>
    <VerificationBadge node={node} />
    {node.handoff && <p className="mb-2 text-[10px] text-muted">{t('run.upstream', { count: node.handoff.priorNodeRunIds.length })}{node.handoff.orchestratorContext ? t('run.orchestratorContext') : ''}{node.handoff.retryAddendum ? t('run.retryNote') : ''}</p>}
    {seedPrompt && <Collapsible className="mb-2 text-[10px]" summary={<span className="text-sky-300">{t('run.seedPrompt')}</span>}><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-ink">{seedPrompt}</pre></Collapsible>}
    {(node.status === 'failed' && (node.errorReason || node.error))
      ? <p className={`mb-2 whitespace-pre-line break-words text-xs ${node.errorReason ? 'text-amber-200' : 'line-clamp-3 text-red-300'}`} title={node.errorReason ?? node.error}>{node.errorReason ?? node.error}</p>
      : (node.status === 'killed' && node.error)
        ? <p className="mb-2 line-clamp-3 break-words text-xs text-red-300" title={node.error}>{node.error}</p>
      : <p className="mb-2 line-clamp-2 text-xs text-ink" title={latestEvent?.text}>{latestEvent?.text || (node.status === 'queued' ? t('run.waitStart') : t('run.waitEvents'))}</p>}
    {confirmingKill ? <div className="flex items-center gap-1.5 rounded border border-red-900/70 bg-red-950/30 p-1.5 text-[11px]">
      <span className="mr-auto text-red-200">{t('run.killQuestion')}</span>
      <button type="button" onClick={onKill} className="rounded bg-red-700 px-2 py-1 text-white">{t('run.confirm')}</button>
      <button type="button" onClick={onCancelKill} className="rounded px-2 py-1 text-muted hover:text-ink">{t('run.cancel')}</button>
    </div> : <div className="flex flex-wrap gap-1.5">
      <button type="button" disabled={!canKill} onClick={onRequestKill} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:border-red-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-35">{t('run.kill')}</button>
      <button type="button" disabled={!node.patchFile} onClick={onPatch} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:border-emerald-700 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-35">{t('run.viewPatch')}</button>
      <button type="button" onClick={onFocus} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:border-sky-700 hover:text-sky-300">{t('run.focusStream')}</button>
    </div>}
  </article>;
}

function VerificationBadge({ node }: { node: NodeRun }) {
  const { t } = useUiPreferences();
  const verification = node.verification;
  if (!verification || (verification.status === 'skipped' && verification.reason === 'no-verify-command')) return null;
  if (verification.status === 'passed') return <span className="mb-2 inline-flex rounded-none bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">{t('run.verified')}</span>;
  if (verification.status === 'failed' || verification.status === 'error') {
    return <span title={verification.reason ?? (verification.exitCode === undefined ? t('run.checksFailedTitle') : `exit ${String(verification.exitCode)}`)} className="mb-2 inline-flex rounded-none bg-red-950 px-1.5 py-0.5 text-[10px] text-red-300">{t('run.checksFailed')}</span>;
  }
  return <span title={verification.reason} className="mb-2 inline-flex rounded-none bg-raised px-1.5 py-0.5 text-[10px] text-ink">{t('run.unverified')}</span>;
}

function UsageSummary({ node }: { node: NodeRun }) {
  if (!node.usage) return null;
  const tokens = (node.usage.inputTokens ?? 0) + (node.usage.outputTokens ?? 0);
  return <span className="ml-auto truncate">{tokens > 0 ? `${tokens.toLocaleString()} tok` : ''}{tokens > 0 && node.usage.costUsd !== undefined ? ' · ' : ''}{node.usage.costUsd !== undefined ? `$${node.usage.costUsd.toFixed(4)}` : ''}</span>;
}

export function DecisionCard({ decision, run }: { decision: GateDecision; run: RunSnapshot }) {
  const { t } = useUiPreferences();
  const display = decisionDisplay(decision);
  const labels = new Map(run.nodes.map((node) => [node.nodeRunId, displayNodeLabel(node, run.nodes)]));
  const summary = decision.verificationSummary ?? verificationSummary(run.nodes.filter((node) => node.stageId === decision.stageId));
  return <article className={`mt-2 rounded-md border bg-emerald-950/20 p-2.5 ${display.borderClass}`} data-degraded={display.degraded ? 'true' : 'false'}>
    <header className="mb-1 flex items-center justify-between gap-2"><span className={`text-xs font-semibold uppercase ${display.actionClass}`}>{display.label}</span><span className="text-[10px] text-muted">{run.steers?.some((steer) => steer.steerStageId === decision.stageId) ? t('run.steerReview') : t('run.gateAttempt', { count: decision.gateAttempt })}</span></header>
    {summary.passed + summary.failed + summary.skipped > 0 && <span className="mb-1 inline-flex rounded-none border border-border px-1.5 py-0.5 text-[10px] text-ink">{t('run.verificationSummary', { passed: summary.passed, failed: summary.failed, skipped: summary.skipped })}</span>}
    <p className="text-xs leading-relaxed text-emerald-50/90">{decision.rationale}</p>
    {decision.retryNodeRunIds && decision.retryNodeRunIds.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{decision.retryNodeRunIds.map((id) => <span key={id} className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-200">{t('run.retryNode', { node: labels.get(id) ?? id })}</span>)}</div>}
    {decision.promptAddendum && <p className="mt-2 border-l border-amber-600 pl-2 text-[11px] text-amber-100">{decision.promptAddendum}</p>}
    {decision.contextForNext && <Collapsible className="mt-2 text-[11px]" summary={<span className="text-emerald-300">{t('run.contextNext')}</span>}><p className="whitespace-pre-wrap text-ink">{decision.contextForNext}</p></Collapsible>}
  </article>;
}

function ApplyPatchResult({ result }: { result: ApplyPatchResponse }) {
  const { t } = useUiPreferences();
  return <div className={`mt-3 rounded border p-2 text-sm ${result.ok ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-red-900 bg-red-950/30 text-red-200'}`} role="status">
    <p>{result.message}</p>
    {result.conflicts && result.conflicts.length > 0 && <div className="mt-2"><p className="text-xs font-semibold uppercase tracking-wide">{t('run.conflicts')}</p><ul className="mt-1 list-inside list-disc font-mono text-xs">{result.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul></div>}
  </div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
