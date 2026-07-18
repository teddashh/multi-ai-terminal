import { z } from 'zod';
import type { GateDecision } from '@mat/shared';

const DecisionPayloadSchema = z.object({
  action: z.enum(['advance', 'retry', 'abort']),
  retryNodeRunIds: z.array(z.string()).optional(),
  promptAddendum: z.string().optional(),
  contextForNext: z.string().optional(),
  rationale: z.string().min(1),
}).passthrough();

type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

export function extractLastFencedJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) throw new Error('No fenced JSON block found');
  const body = blocks.at(-1)?.[1];
  if (!body) throw new Error('The final fenced JSON block is empty');
  return JSON.parse(body);
}

export function tryParseDecision(text: string, stageId: string, gateAttempt: number, validNodeRunIds: readonly string[]): GateDecision {
  const value: DecisionPayload = DecisionPayloadSchema.parse(extractLastFencedJson(text));
  const valid = new Set(validNodeRunIds);
  const retryNodeRunIds = value.retryNodeRunIds?.filter((id) => valid.has(id));
  const base: GateDecision = {
    stageId,
    gateAttempt,
    action: value.action,
    rationale: value.rationale,
    raw: text,
    ts: Date.now(),
    ...(value.promptAddendum !== undefined ? { promptAddendum: value.promptAddendum } : {}),
    ...(value.contextForNext !== undefined ? { contextForNext: value.contextForNext } : {}),
  };
  if (value.action !== 'retry') return base;
  if (!retryNodeRunIds?.length) {
    return {
      ...base,
      action: 'advance',
      degraded: true,
      rationale: `${value.rationale} (retry contained no valid stage node ids)`,
    };
  }
  return { ...base, retryNodeRunIds };
}

export function degradedDecision(stageId: string, gateAttempt: number, rationale: string, raw?: string): GateDecision {
  return {
    stageId,
    gateAttempt,
    action: 'advance',
    rationale,
    ...(raw !== undefined ? { raw } : {}),
    degraded: true,
    ts: Date.now(),
  };
}

export function parseDecision(text: string, stageId: string, gateAttempt: number, validNodeRunIds: readonly string[]): GateDecision {
  try {
    return tryParseDecision(text, stageId, gateAttempt, validNodeRunIds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return degradedDecision(stageId, gateAttempt, `Orchestrator decision could not be parsed: ${detail}`, text);
  }
}
