import type { AgentBinding, GateDecision, NodeRun, RunSnapshot, Stage, SteerMessage } from '@mat/shared';
import { appendEvent } from '../store/eventLog.js';
import { getWorkspace } from '../store/workspaces.js';
import { evaluateGate } from '../orchestrator/gate.js';
import { renderTemplate, STEER_TEMPLATE } from '../orchestrator/prompts.js';
import { diag } from '../diag.js';
import { assembleArtifacts, buildDigest } from './digest.js';
import { killAllActiveNodes, markNodeKilled, resetNodeForRetry } from './nodeRunner.js';
import { appendDecision, executeNodes, persistRun, queueStageRetryAddendum, takeSteerInterruptedStage } from './stageRunner.js';

export type SteerOutcome = 'redo'|'continue'|'continue-pending'|'abort';
const isAborted = (run: RunSnapshot): boolean => run.status === 'aborted';

function steerEvent(run: RunSnapshot, steer: SteerMessage, transition: SteerMessage['status'], text: string): void {
  appendEvent(run.runId, {
    runId: run.runId, stageId: steer.steerStageId ?? null, nodeRunId: null, attempt: 0,
    role: 'system', kind: 'status', text,
    data: { detail: `steer-${transition}`, steerId: steer.steerId, mode: steer.mode },
  });
  diag(run.runId, 'steer', {
    steerId: steer.steerId, transition, mode: steer.mode,
    ...(steer.interruptedStageId !== undefined ? { interruptedStageId: steer.interruptedStageId } : {}),
  });
}

function agentFor(run: RunSnapshot, steer: SteerMessage, priorStage: Stage): AgentBinding {
  const interruptedStage = run.workflow.stages.find((stage) => stage.id === steer.interruptedStageId);
  const interruptedNode = run.nodes.find((node) => node.stageId === steer.interruptedStageId);
  return structuredClone(interruptedStage?.slots[0]?.agent ?? interruptedNode?.agent ?? priorStage.slots[0]!.agent);
}

function deterministicSummary(steer: SteerMessage, node: NodeRun): string {
  return `A mid-run user instruction was executed: ${steer.text.slice(0, 200)}. Outcome: ${(node.resultText ?? '').slice(0, 400)}.`;
}

function interruptedNodes(run: RunSnapshot, steer: SteerMessage, priorStage: Stage): NodeRun[] {
  if (steer.interruptedStageId === null) return [];
  const exact = run.nodes.filter((node) => node.stageId === steer.interruptedStageId && !node.nodeRunId.startsWith('steer-'));
  return exact.length > 0 ? exact : run.nodes.filter((node) => node.stageId === priorStage.id);
}

export async function runSteerCycle(run: RunSnapshot, steer: SteerMessage, priorStage: Stage): Promise<SteerOutcome> {
  const index = (run.steers ?? []).indexOf(steer) + 1;
  steer.status = 'active';
  steer.appliedAt = Date.now();
  const cutShortStageId = takeSteerInterruptedStage(run.runId);
  if (steer.interruptedStageId === undefined) steer.interruptedStageId = cutShortStageId ?? null;
  const stageId = `steer-${index}`;
  steer.steerStageId = stageId;
  run.currentStageId = stageId;
  steerEvent(run, steer, 'active', `Steer ${index} is active.`);
  await persistRun(run);

  const agent = agentFor(run, steer, priorStage);
  const stage: Stage = {
    id: stageId, name: `Steer ${index}`,
    slots: [{ id: 'agent', label: 'Steer', agent, count: 1, promptTemplate: STEER_TEMPLATE }],
    isolation: priorStage.isolation, join: 'all', gate: false, requireVerified: false,
    timeoutSec: priorStage.timeoutSec, stallSec: priorStage.stallSec,
  };
  const node: NodeRun = {
    nodeRunId: `${stageId}.agent.0`, stageId, slotId: 'agent', instanceIndex: 0,
    agent: structuredClone(agent), label: `Steer · ${agent.provider}`, status: 'queued', attempt: 1,
    cwd: (await getWorkspace(run.workspaceId)).path,
  };
  run.nodes.push(node);
  await persistRun(run);
  const priorNodes = interruptedNodes(run, steer, priorStage);
  const artifacts = assembleArtifacts(priorNodes);
  const workspace = await getWorkspace(run.workspaceId);
  const prompt = renderTemplate(STEER_TEMPLATE, {
    task: run.task, steer_text: steer.text, workspace_path: workspace.path,
    prior_stage_digest: buildDigest(priorNodes, { interruptedPartial: true }), patches: artifacts.patches,
  });
  await executeNodes(run, stage, [node], workspace, new Map(), () => prompt);
  if (isAborted(run)) return 'abort';
  if (node.status === 'queued' && (run.steers ?? []).some((candidate) => candidate.status === 'pending' && candidate.mode === 'interrupt')) {
    markNodeKilled(node, run.runId, 'steer');
    await persistRun(run);
  }
  if (node.status === 'killed') {
    steer.status = 'superseded';
    steerEvent(run, steer, 'superseded', `Steer ${index} was superseded by a newer interrupt.`);
    await persistRun(run);
    return 'continue-pending';
  }

  const interruptedWorkflowStage = run.workflow.stages.find((candidate) => candidate.id === steer.interruptedStageId);
  const redoStage = steer.interruptedStageId === null ? undefined : (interruptedWorkflowStage ?? priorStage);
  const reviewDigest = [buildDigest([node]), priorNodes.length ? `## Interrupted progress\n${buildDigest(priorNodes, { interruptedPartial: true })}` : ''].filter(Boolean).join('\n\n');
  let decision: GateDecision;
  if (run.workflow.orchestrator.enabled) {
    run.status = 'gating';
    await persistRun(run);
    decision = await evaluateGate(
      run,
      stage,
      reviewDigest,
      redoStage ? priorNodes.map((candidate) => candidate.nodeRunId) : [],
      { interruptedStageName: redoStage?.name ?? null, steerText: steer.text },
    );
  } else {
    const summary = deterministicSummary(steer, node);
    decision = redoStage ? {
      stageId, gateAttempt: 1, action: 'retry', retryNodeRunIds: priorNodes.map((candidate) => candidate.nodeRunId),
      promptAddendum: `${summary} Incorporate it and complete the original stage goal.`,
      rationale: 'Steer applied: deterministic redo of the interrupted stage.', ts: Date.now(),
    } : {
      stageId, gateAttempt: 1, action: 'advance', contextForNext: summary,
      rationale: 'Steer applied: deterministic continue.', ts: Date.now(),
    };
  }
  if (isAborted(run)) return 'abort';
  appendDecision(run, decision, { engineForced: !run.workflow.orchestrator.enabled });
  steer.status = 'reviewed';
  steerEvent(run, steer, 'reviewed', `Steer ${index} review chose ${decision.action}.`);
  run.status = 'running';
  await persistRun(run);

  if (decision.action === 'abort') {
    run.status = 'aborted';
    run.endedAt = Date.now();
    for (const candidate of run.nodes) if (candidate.status === 'queued') markNodeKilled(candidate, run.runId, 'abort');
    killAllActiveNodes(run.runId, 'abort');
    appendEvent(run.runId, {
      runId: run.runId, stageId: null, nodeRunId: null, attempt: 0, role: 'system', kind: 'status',
      text: 'Run aborted by steer review.', data: { status: 'aborted', detail: 'steer-review' },
    });
    await persistRun(run);
    return 'abort';
  }
  if (decision.action !== 'retry' || !redoStage) return 'continue';
  for (const candidate of run.nodes.filter((item) => item.stageId === redoStage.id && item.status !== 'queued')) resetNodeForRetry(candidate);
  queueStageRetryAddendum(run.runId, redoStage.id, decision.promptAddendum);
  await persistRun(run);
  return 'redo';
}

export async function expireSteers(run: RunSnapshot): Promise<void> {
  let changed = false;
  for (const steer of run.steers ?? []) {
    if (steer.status !== 'pending' && steer.status !== 'active') continue;
    steer.status = 'expired';
    steerEvent(run, steer, 'expired', `Steer ${steer.steerId} expired when the run ended.`);
    changed = true;
  }
  if (changed) await persistRun(run);
}
