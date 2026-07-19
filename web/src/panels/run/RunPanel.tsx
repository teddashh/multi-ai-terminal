import type { AgentEvent, ApplyPatchResponse, GateDecision, NodeRun, RunSnapshot, Stage } from '@mat/shared';
import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../api/client.js';
import { useMatStore } from '../../app/store.js';
import { AgentChip, Collapsible, ModalDialog, PROVIDER_COLORS, mergeConsecutiveEvents } from '../../components/index.js';
import { canRetryStage, decisionDisplay, elapsedForNode, formatElapsed, nodeDisplayStatus, verificationSummary, type NodeDisplayStatus } from './runLogic.js';

const STATUS_STYLE: Record<NodeDisplayStatus, string> = {
  queued: 'bg-zinc-700 text-zinc-200',
  running: 'bg-sky-950 text-sky-200 ring-1 ring-sky-500/40',
  thinking: 'animate-pulse bg-violet-950 text-violet-200 ring-1 ring-violet-500/50',
  stalled: 'bg-amber-950 text-amber-200 ring-1 ring-amber-500/50',
  done: 'bg-emerald-950 text-emerald-200 ring-1 ring-emerald-500/40',
  failed: 'bg-red-950 text-red-200 ring-1 ring-red-500/50',
  killed: 'bg-zinc-800 text-zinc-300 ring-1 ring-zinc-600',
};

interface PatchDialogState {
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
  const activeRunId = useMatStore((state) => state.activeRunId);
  const run = useMatStore((state) => activeRunId ? state.runs[activeRunId] : undefined);
  const events = useMatStore((state) => (activeRunId ? state.events[activeRunId] : undefined) ?? EMPTY_EVENTS);
  const focusNode = useMatStore((state) => state.focusNode);
  const upsertRun = useMatStore((state) => state.upsertRun);
  const [now, setNow] = useState(Date.now());
  const [killConfirmation, setKillConfirmation] = useState<string>();
  const [retryStage, setRetryStage] = useState<Stage>();
  const [retryAddendum, setRetryAddendum] = useState('');
  const [patchDialog, setPatchDialog] = useState<PatchDialogState>();
  const [actionError, setActionError] = useState<string>();
  const [report, setReport] = useState<{ loading: boolean; content?: string; error?: string }>();

  useEffect(() => {
    if (!run?.nodes.some((node) => node.startedAt !== undefined && node.endedAt === undefined)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.nodes]);

  const latestByNode = useMemo(() => {
    const result = new Map<string, AgentEvent>();
    for (const event of mergeConsecutiveEvents(events)) if (event.nodeRunId) result.set(event.nodeRunId, event);
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

  if (!run) return <section className="h-full overflow-auto p-3" aria-label="Run panel">
    <PanelHeading />
    <div className="rounded border border-dashed border-border p-4 text-xs text-muted">
      No run yet. Enter a task in the run box and start a workflow.
    </div>
  </section>;

  const orchestrator = run.nodes.find((node) => node.nodeRunId === 'orchestrator');
  const doKill = async (nodeRunId: string) => {
    setActionError(undefined);
    try { upsertRun(await apiClient.killNode(run.runId, nodeRunId)); setKillConfirmation(undefined); }
    catch (error) { setActionError(errorMessage(error)); }
  };
  const openPatch = (node: NodeRun) => {
    setPatchDialog({ node, loading: true, applying: false });
    void apiClient.getPatch(run.runId, node.nodeRunId)
      .then((content) => setPatchDialog((current) => current?.node.nodeRunId === node.nodeRunId ? { ...current, loading: false, content } : current))
      .catch((error) => setPatchDialog((current) => current?.node.nodeRunId === node.nodeRunId ? { ...current, loading: false, error: errorMessage(error) } : current));
  };
  const applyPatch = async () => {
    if (!patchDialog) return;
    setPatchDialog({ node: patchDialog.node, loading: patchDialog.loading, applying: true, ...(patchDialog.content !== undefined ? { content: patchDialog.content } : {}) });
    try {
      const result = await apiClient.applyPatch(run.runId, patchDialog.node.nodeRunId);
      setPatchDialog((current) => current ? { ...current, applying: false, result } : current);
    } catch (error) {
      setPatchDialog((current) => current ? { ...current, applying: false, error: errorMessage(error) } : current);
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
    setReport({ loading: true });
    void apiClient.getReport(run.runId)
      .then((content) => setReport({ loading: false, content }))
      .catch((error) => setReport({ loading: false, error: errorMessage(error) }));
  };
  const downloadReport = () => {
    if (!report?.content) return;
    const url = URL.createObjectURL(new Blob([report.content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `mat-run-${run.runId}.md`; link.click(); URL.revokeObjectURL(url);
  };

  const card = (node: NodeRun) => <NodeCard
    key={node.nodeRunId}
    node={node}
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

  return <section className="h-full overflow-auto p-3" aria-label="Run panel">
    <PanelHeading onReport={openReport} />
    <p className="mb-3 line-clamp-3 text-sm text-ink" title={run.task}>{run.task}</p>
    {actionError && <p role="alert" className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-200">{actionError}</p>}
    {orchestrator && <div className="mb-4" data-testid="orchestrator-group">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-violet-300">Orchestrator</div>
      {card(orchestrator)}
    </div>}
    <div className="space-y-4">
      {run.workflow.stages.map((stage) => {
        const stageNodes = run.nodes.filter((node) => node.stageId === stage.id);
        const decisions = run.gateDecisions.filter((decision) => decision.stageId === stage.id).sort((a, b) => a.gateAttempt - b.gateAttempt);
        return <section key={stage.id} aria-labelledby={`stage-${stage.id}`}>
          <header className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0"><h3 id={`stage-${stage.id}`} className="truncate text-xs font-semibold text-ink">{stage.name}</h3><span className="text-[10px] text-muted">{stageNodes.length} node{stageNodes.length === 1 ? '' : 's'}</span></div>
            <button type="button" disabled={!canRetryStage(run, stage.id)} onClick={() => { setRetryStage(stage); setRetryAddendum(''); }} className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:border-violet-500 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35">Retry stage</button>
          </header>
          <div className="grid gap-2">{stageNodes.map(card)}</div>
          {decisions.map((decision) => <DecisionCard key={`${decision.stageId}-${decision.gateAttempt}`} decision={decision} run={run} />)}
        </section>;
      })}
    </div>
    <ModalDialog open={patchDialog !== undefined} title={patchDialog ? `Patch · ${patchDialog.node.label}` : 'Patch'} onClose={() => setPatchDialog(undefined)} footer={patchDialog && !patchDialog.loading && !patchDialog.error ? <button type="button" disabled={patchDialog.applying} onClick={() => void applyPatch()} className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-50">{patchDialog.applying ? 'Applying…' : 'Apply patch'}</button> : undefined}>
      {patchDialog?.loading && <p className="animate-pulse text-sm text-muted">Loading patch…</p>}
      {patchDialog?.error && <p role="alert" className="text-sm text-red-300">{patchDialog.error}</p>}
      {patchDialog?.content !== undefined && <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 text-xs text-zinc-200">{patchDialog.content || '(empty patch)'}</pre>}
      {patchDialog?.result && <ApplyPatchResult result={patchDialog.result} />}
    </ModalDialog>
    <ModalDialog open={retryStage !== undefined} title={retryStage ? `Retry ${retryStage.name}` : 'Retry stage'} onClose={() => setRetryStage(undefined)} footer={<button type="button" onClick={() => void submitRetry()} className="rounded bg-violet-700 px-3 py-1.5 text-sm text-white hover:bg-violet-600">Retry stage</button>}>
      <label className="block text-xs text-muted">Optional prompt addendum<textarea value={retryAddendum} onChange={(event) => setRetryAddendum(event.target.value)} rows={4} placeholder="What should the stage do differently?" className="mt-2 w-full resize-y rounded border border-border bg-zinc-950 p-2 text-sm text-ink outline-none focus:border-violet-500" /></label>
    </ModalDialog>
    <ModalDialog open={report !== undefined} title={`Run report · ${run.runId}`} onClose={() => setReport(undefined)} footer={report?.content ? <div className="flex justify-end gap-2"><button type="button" onClick={() => void navigator.clipboard.writeText(report.content ?? '')} className="rounded-none border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-emerald-600">Copy</button><button type="button" onClick={downloadReport} className="rounded-none bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600">Download .md</button></div> : undefined}>
      {report?.loading && <p className="text-xs text-zinc-400">Loading report…</p>}
      {report?.error && <p role="alert" className="text-xs text-red-300">{report.error}</p>}
      {report?.content && <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap text-xs text-zinc-200">{report.content}</pre>}
    </ModalDialog>
  </section>;
}

function PanelHeading({ onReport }: { onReport?: () => void }) {
  return <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Run</h2>{onReport && <button type="button" onClick={onReport} className="rounded-none border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:border-emerald-600 hover:text-emerald-200">Report</button>}</div>;
}

interface NodeCardProps {
  node: NodeRun;
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

export function NodeCard({ node, latestEvent, seedPrompt, now, confirmingKill, onRequestKill, onCancelKill, onKill, onPatch, onFocus }: NodeCardProps) {
  const displayStatus = nodeDisplayStatus(node, latestEvent);
  const elapsed = elapsedForNode(node, now);
  const canKill = ['queued', 'running', 'stalled'].includes(node.status);
  return <article data-node-run-id={node.nodeRunId} className="rounded-md border bg-zinc-900/45 p-2.5 shadow-sm" style={{ borderColor: PROVIDER_COLORS[node.agent.provider] }}>
    <div className="mb-2 flex items-start justify-between gap-2">
      <AgentChip agent={node.agent} label={node.label} className="min-w-0" />
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[displayStatus]}`}>{displayStatus}</span>
    </div>
    <div className="mb-2 flex items-center gap-2 text-[10px] text-muted">
      <span>{elapsed === undefined ? 'not started' : formatElapsed(elapsed)}</span>
      {node.attempt > 1 && <span className="rounded bg-violet-950 px-1.5 py-0.5 text-violet-200">attempt {node.attempt}</span>}
      <UsageSummary node={node} />
    </div>
    <VerificationBadge node={node} />
    {node.handoff && <p className="mb-2 text-[10px] text-zinc-400">← {node.handoff.priorNodeRunIds.length} upstream node(s){node.handoff.orchestratorContext ? ' + orchestrator context' : ''}{node.handoff.retryAddendum ? ' + retry note' : ''}</p>}
    {seedPrompt && <Collapsible className="mb-2 text-[10px]" summary={<span className="text-sky-300">Seed prompt</span>}><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-zinc-300">{seedPrompt}</pre></Collapsible>}
    {(['failed', 'killed'].includes(node.status) && node.error)
      ? <p className="mb-2 line-clamp-3 break-words text-xs text-red-300" title={node.error}>{node.error}</p>
      : <p className="mb-2 line-clamp-2 text-xs text-zinc-300" title={latestEvent?.text}>{latestEvent?.text || (node.status === 'queued' ? 'Waiting to start' : 'Waiting for events…')}</p>}
    {confirmingKill ? <div className="flex items-center gap-1.5 rounded border border-red-900/70 bg-red-950/30 p-1.5 text-[11px]">
      <span className="mr-auto text-red-200">Kill this node?</span>
      <button type="button" onClick={onKill} className="rounded bg-red-700 px-2 py-1 text-white">Confirm</button>
      <button type="button" onClick={onCancelKill} className="rounded px-2 py-1 text-muted hover:text-ink">Cancel</button>
    </div> : <div className="flex flex-wrap gap-1.5">
      <button type="button" disabled={!canKill} onClick={onRequestKill} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:border-red-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-35">Kill</button>
      <button type="button" disabled={!node.patchFile} onClick={onPatch} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:border-emerald-700 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-35">View patch</button>
      <button type="button" onClick={onFocus} className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:border-sky-700 hover:text-sky-300">Focus stream</button>
    </div>}
  </article>;
}

function VerificationBadge({ node }: { node: NodeRun }) {
  const verification = node.verification;
  if (!verification || (verification.status === 'skipped' && verification.reason === 'no-verify-command')) return null;
  if (verification.status === 'passed') return <span className="mb-2 inline-flex rounded-none bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">✓ verified</span>;
  if (verification.status === 'failed' || verification.status === 'error') {
    return <span title={verification.reason ?? (verification.exitCode === undefined ? 'checks failed' : `exit ${String(verification.exitCode)}`)} className="mb-2 inline-flex rounded-none bg-red-950 px-1.5 py-0.5 text-[10px] text-red-300">✗ checks failed</span>;
  }
  return <span title={verification.reason} className="mb-2 inline-flex rounded-none bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">– unverified</span>;
}

function UsageSummary({ node }: { node: NodeRun }) {
  if (!node.usage) return null;
  const tokens = (node.usage.inputTokens ?? 0) + (node.usage.outputTokens ?? 0);
  return <span className="ml-auto truncate">{tokens > 0 ? `${tokens.toLocaleString()} tok` : ''}{tokens > 0 && node.usage.costUsd !== undefined ? ' · ' : ''}{node.usage.costUsd !== undefined ? `$${node.usage.costUsd.toFixed(4)}` : ''}</span>;
}

export function DecisionCard({ decision, run }: { decision: GateDecision; run: RunSnapshot }) {
  const display = decisionDisplay(decision);
  const labels = new Map(run.nodes.map((node) => [node.nodeRunId, node.label]));
  const summary = verificationSummary(run.nodes.filter((node) => node.stageId === decision.stageId));
  return <article className={`mt-2 rounded-md border bg-emerald-950/20 p-2.5 ${display.borderClass}`} data-degraded={display.degraded ? 'true' : 'false'}>
    <header className="mb-1 flex items-center justify-between gap-2"><span className={`text-xs font-semibold uppercase ${display.actionClass}`}>{display.label}</span><span className="text-[10px] text-muted">gate {decision.gateAttempt}</span></header>
    {summary.passed + summary.failed + summary.skipped > 0 && <span className="mb-1 inline-flex rounded-none border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">{summary.passed} passed / {summary.failed} failed / {summary.skipped} skipped</span>}
    <p className="text-xs leading-relaxed text-emerald-50/90">{decision.rationale}</p>
    {decision.retryNodeRunIds && decision.retryNodeRunIds.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{decision.retryNodeRunIds.map((id) => <span key={id} className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-200">retry: {labels.get(id) ?? id}</span>)}</div>}
    {decision.promptAddendum && <p className="mt-2 border-l border-amber-600 pl-2 text-[11px] text-amber-100">{decision.promptAddendum}</p>}
    {decision.contextForNext && <Collapsible className="mt-2 text-[11px]" summary={<span className="text-emerald-300">Context for next stage</span>}><p className="whitespace-pre-wrap text-zinc-300">{decision.contextForNext}</p></Collapsible>}
  </article>;
}

function ApplyPatchResult({ result }: { result: ApplyPatchResponse }) {
  return <div className={`mt-3 rounded border p-2 text-sm ${result.ok ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-red-900 bg-red-950/30 text-red-200'}`} role="status">
    <p>{result.message}</p>
    {result.conflicts && result.conflicts.length > 0 && <div className="mt-2"><p className="text-xs font-semibold uppercase tracking-wide">Conflicts</p><ul className="mt-1 list-inside list-disc font-mono text-xs">{result.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul></div>}
  </div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
