import type { ITab, IWorkspaceOrchestration } from '@/types/terminal';
import type { IOrchestrationNudge } from '@/types/status';
import useWorkspaceStore from '@/hooks/use-workspace-store';

export const patchWorkspaceOrchestration = async (
  workspaceId: string,
  patch: Partial<IWorkspaceOrchestration>,
): Promise<boolean> => {
  const res = await fetch(`/api/workspace/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestration: patch }),
  });
  if (res.ok) await useWorkspaceStore.getState().syncWorkspaces();
  return res.ok;
};

export interface IStartOrchestrationRequest {
  paneId: string;
  prompt: string;
  name?: string;
  model?: string;
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
  if (!res.ok) return null;
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
