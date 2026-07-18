import type { GateDecision, NodeRun, RunSnapshot, Stage } from '@mat/shared';
import { saveRun } from '../store/runs.js';
import { buildGatePrompt } from './prompts.js';
import { degradedDecision, tryParseDecision } from './decision.js';
import { killActiveNode, registerNodeContext, runNode } from '../engine/nodeRunner.js';

const RESUMABLE = new Set(['claude', 'codex', 'grok']);
const hasNodeStatus = (node: NodeRun, status: NodeRun['status']): boolean => node.status === status;

class GateTimeoutError extends Error {}

function orchestratorNode(run: RunSnapshot): NodeRun {
  const node = run.nodes.find((candidate) => candidate.nodeRunId === 'orchestrator');
  if (!node) throw new Error('Enabled workflow is missing its reserved orchestrator NodeRun');
  return node;
}

export async function evaluateGate(run: RunSnapshot, stage: Stage, digest: string): Promise<GateDecision> {
  const gateAttempt = run.gateDecisions.filter((decision) => decision.stageId === stage.id).length + 1;
  const validIds = run.nodes.filter((node) => node.stageId === stage.id).map((node) => node.nodeRunId);
  if (!run.workflow.orchestrator.enabled) {
    return {
      stageId: stage.id,
      gateAttempt,
      action: 'advance',
      rationale: 'Orchestrator disabled; stage advances deterministically.',
      ts: Date.now(),
    };
  }

  const node = orchestratorNode(run);
  node.attempt = gateAttempt;
  node.status = 'queued';
  node.agent = structuredClone(run.workflow.orchestrator.agent);
  const deadline = Date.now() + run.workflow.orchestrator.gateTimeoutSec * 1000;
  let lastRaw = '';
  let lastUsedResume = false;

  const execute = async (reask: boolean): Promise<string> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new GateTimeoutError('Orchestrator gate timed out');
    const canResume = RESUMABLE.has(node.agent.provider) && Boolean(node.sessionRef);
    lastUsedResume = canResume;
    const prompt = buildGatePrompt(run, stage, digest, !canResume, reask);
    registerNodeContext(node, {
      runId: run.runId,
      stageId: null,
      getRunStatus: () => run.status,
      ...(canResume && node.sessionRef ? { resumeSessionRef: node.sessionRef } : {}),
      persist: async () => saveRun(run),
    });
    const gateStage: Stage = {
      id: stage.id,
      name: `${stage.name} gate`,
      slots: [],
      isolation: 'none',
      join: 'all',
      timeoutSec: Math.max(0.001, remainingMs / 1000),
      stallSec: Math.max(1, Math.min(stage.stallSec, Math.ceil(remainingMs / 1000))),
      gate: false,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const execution = runNode(node, gateStage, prompt);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        killActiveNode(run.runId, node.nodeRunId, 'gate-timeout');
        reject(new GateTimeoutError('Orchestrator gate timed out'));
      }, remainingMs);
    });
    try {
      await Promise.race([execution, timeout]);
    } catch (error) {
      await execution;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return node.resultText ?? '';
  };

  try {
    lastRaw = await execute(false);
    if (hasNodeStatus(node, 'killed')) return degradedDecision(stage.id, gateAttempt, 'Orchestrator gate was interrupted; advancing.', lastRaw);
    if (hasNodeStatus(node, 'failed') && lastUsedResume) {
      delete node.sessionRef;
      node.status = 'queued';
      lastRaw = await execute(false);
      if (hasNodeStatus(node, 'killed')) return degradedDecision(stage.id, gateAttempt, 'Orchestrator gate was interrupted; advancing.', lastRaw);
    }
    try {
      return tryParseDecision(lastRaw, stage.id, gateAttempt, validIds);
    } catch {
      node.status = 'queued';
      lastRaw = await execute(true);
      if (hasNodeStatus(node, 'killed')) return degradedDecision(stage.id, gateAttempt, 'Orchestrator gate was interrupted; advancing.', lastRaw);
      try {
        return tryParseDecision(lastRaw, stage.id, gateAttempt, validIds);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return degradedDecision(stage.id, gateAttempt, `Orchestrator returned invalid JSON twice: ${detail}`, lastRaw);
      }
    }
  } catch (error) {
    if (error instanceof GateTimeoutError) {
      return degradedDecision(stage.id, gateAttempt, 'Orchestrator gate timed out; advancing.', lastRaw);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return degradedDecision(stage.id, gateAttempt, `Orchestrator gate failed: ${detail}`, lastRaw);
  }
}
