import type { WorkflowDef } from '@mat/shared';
export async function listWorkflows(): Promise<WorkflowDef[]> { throw new Error('NOT_IMPLEMENTED: store/workflows.list'); }
export async function createWorkflow(_workflow: WorkflowDef): Promise<WorkflowDef> { throw new Error('NOT_IMPLEMENTED: store/workflows.create'); }
export async function updateWorkflow(_id: string, _workflow: Partial<WorkflowDef>): Promise<WorkflowDef> { throw new Error('NOT_IMPLEMENTED: store/workflows.update'); }
export async function deleteWorkflow(_id: string): Promise<void> { throw new Error('NOT_IMPLEMENTED: store/workflows.delete'); }
export async function duplicateWorkflow(_id: string): Promise<WorkflowDef> { throw new Error('NOT_IMPLEMENTED: store/workflows.duplicate'); }
