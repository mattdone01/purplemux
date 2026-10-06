import type { ITab, IWorkspaceOrchestration } from '@/types/terminal';
import type { IOrchestrationNudge } from '@/types/status';
import type { IOrchestrationPrecondition } from '@/lib/orchestration-contract';
import useWorkspaceStore from '@/hooks/use-workspace-store';

export class OrchestrationClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly orchestration?: IWorkspaceOrchestration, public readonly undesignatedTabId?: string) { super(message); }
}
const checkResponse = async (res: Response): Promise<void> => {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) await useWorkspaceStore.getState().syncWorkspaces();
  throw new OrchestrationClientError(body.code ?? 'orchestration-request-failed', body.error ?? 'Unable to change orchestration', body.orchestration, body.undesignatedTabId);
};

export const patchWorkspaceOrchestration = async (
  workspaceId: string,
  patch: Partial<IWorkspaceOrchestration>,
  condition: IOrchestrationPrecondition,
): Promise<boolean> => {
  const res = await fetch(`/api/workspace/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestration: patch, ...condition }),
  });
  await checkResponse(res);
  await useWorkspaceStore.getState().syncWorkspaces();
  return res.ok;
};

export interface IStartOrchestrationRequest extends IOrchestrationPrecondition {
  paneId: string;
  prompt: string;
  name?: string;
  model?: string;
  /** claude --effort for the orchestrator session; omitted = the user's global default. */
  effort?: string;
  template?: string;
}

export const startOrchestration = async (
  workspaceId: string,
  body: IStartOrchestrationRequest,
): Promise<ITab | null> => {
  const res = await fetch(`/api/workspace/${workspaceId}/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await checkResponse(res);
  const tab = (await res.json()) as ITab;
  await useWorkspaceStore.getState().syncWorkspaces();
  return tab;
};

export const fetchOrchestrationNudges = async (workspaceId: string): Promise<IOrchestrationNudge[]> => {
  const res = await fetch(`/api/workspace/${workspaceId}/orchestration`);
  if (!res.ok) return [];
  const data = (await res.json()) as { nudges?: IOrchestrationNudge[] };
  return data.nudges ?? [];
};
