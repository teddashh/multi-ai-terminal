export interface WorktreeResult { cwd: string; baseCommit: string; branch: string }
export async function createWorktree(_workspacePath: string, _runId: string, _nodeRunId: string, _attempt: number): Promise<WorktreeResult> { throw new Error('NOT_IMPLEMENTED: engine/worktree'); }
export async function collectPatch(_cwd: string, _baseCommit: string, _patchPath: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: engine/worktree.collectPatch'); }
export async function pruneWorktrees(_runId: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: engine/worktree.prune'); }
