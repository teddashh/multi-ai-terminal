import type { ApplyPatchResponse, RetryStageRequest, RunCreateRequest, RunSnapshot } from '@mat/shared';

export async function createRun(_req: RunCreateRequest): Promise<RunSnapshot> { throw new Error('NOT_IMPLEMENTED: engine/runManager.createRun'); }
export async function abortRun(_runId: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: engine/runManager.abortRun'); }
export async function killNode(_runId: string, _nodeRunId: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: engine/runManager.killNode'); }
export async function retryStage(_runId: string, _stageId: string, _req: RetryStageRequest): Promise<RunSnapshot> { throw new Error('NOT_IMPLEMENTED: engine/runManager.retryStage'); }
export async function applyPatch(_runId: string, _nodeRunId: string): Promise<ApplyPatchResponse> { throw new Error('NOT_IMPLEMENTED: engine/runManager.applyPatch'); }
export async function sweepOnBoot(): Promise<void> { throw new Error('NOT_IMPLEMENTED: engine/runManager.sweepOnBoot'); }
