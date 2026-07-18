import type { Workspace } from '@mat/shared';
export async function listWorkspaces(): Promise<Workspace[]> { throw new Error('NOT_IMPLEMENTED: store/workspaces.list'); }
export async function getWorkspace(_id: string): Promise<Workspace> { throw new Error('NOT_IMPLEMENTED: store/workspaces.get'); }
export async function createWorkspace(_value: Omit<Workspace, 'id' | 'isGit'>): Promise<Workspace> { throw new Error('NOT_IMPLEMENTED: store/workspaces.create'); }
export async function updateWorkspace(_id: string, _value: Partial<Pick<Workspace, 'name' | 'path' | 'defaultWorkflowId'>>): Promise<Workspace> { throw new Error('NOT_IMPLEMENTED: store/workspaces.update'); }
export async function deleteWorkspace(_id: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: store/workspaces.delete'); }
