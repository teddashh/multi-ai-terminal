import type { RunSnapshot } from '@mat/shared';
export async function saveRun(_run: RunSnapshot): Promise<void> { throw new Error('NOT_IMPLEMENTED: store/runs.save'); }
export async function getRun(_runId: string): Promise<RunSnapshot> { throw new Error('NOT_IMPLEMENTED: store/runs.get'); }
export async function listRuns(_workspaceId?: string, _limit = 50, _before?: number): Promise<RunSnapshot[]> { throw new Error('NOT_IMPLEMENTED: store/runs.list'); }
export async function deleteRun(_runId: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: store/runs.delete'); }
