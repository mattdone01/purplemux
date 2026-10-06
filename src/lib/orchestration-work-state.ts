import { observeProcessExistence } from '@/lib/process-utils';
import { collectAllTabs, isAgentPanelType } from '@/lib/layout-store';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { readLeaseEvidence } from '@/lib/lease-store';
import { readLatestStandupEvidence } from '@/lib/standup-store';
import { readLivenessEvidence } from '@/lib/liveness-store';
import { getStatusManager } from '@/lib/status-manager';
import { workStateOf } from '@/lib/orchestrator-presence';
import { observeOrchestrationRuntime } from '@/lib/orchestration-runtime';
import type { IWorkspace } from '@/types/terminal';
import type { IOrchestratorPresenceFacts } from '@/types/coordination';

/** Fresh source observations inside the mapping guard, never the dashboard's issue cache. */
export const readOrchestrationWorkState = async (workspace: IWorkspace): Promise<ReturnType<typeof workStateOf>> => {
  const [layout, leases, standup, background] = await Promise.all([
    readWorkspaceLayout(workspace.id).catch(() => null), readLeaseEvidence(),
    readLatestStandupEvidence(workspace.id), readLivenessEvidence(workspace.id),
  ]);
  const statuses = getStatusManager().getAllForClient();
  const tabs: IOrchestratorPresenceFacts['tabs'] = layout ? await Promise.all(collectAllTabs(layout.root).map(async (tab) => {
    const isAgent = isAgentPanelType(tab.panelType) || !!(tab.orchestrationActivity?.launch || tab.orchestrationActivity?.turn);
    const runtime = isAgent ? await observeOrchestrationRuntime(tab) : null;
    const status = statuses[tab.id]?.workspaceId === workspace.id ? statuses[tab.id].cliState : null;
    return { tabId: tab.id, tabName: tab.name, isAgent,
      cliState: tab.orchestrationActivity?.turn ? 'busy' as const
        : runtime?.state === 'absent' ? 'inactive' as const
        : runtime?.state === 'unknown' || runtime?.state === 'present' && status === 'inactive' ? null : status };
  })) : null;
  const liveBackgroundTabIds: string[] | null = background.known ? [] : null;
  let backgroundWorkIncomplete = !background.known;
  if (background.known) for (const job of background.data.jobs) {
    const observed = await observeProcessExistence(job.pid);
    if (observed.state === 'present') liveBackgroundTabIds!.push(job.tabId);
    if (observed.state === 'unknown') backgroundWorkIncomplete = true;
  }
  const result = workStateOf({ workspaceId: workspace.id, workspaceName: workspace.name,
    orchestration: workspace.orchestration ?? null,
    epicLeases: leases.known ? leases.leases.filter((lease) => lease.name.startsWith('epic:') && lease.holder.workspaceId === workspace.id).map((lease) => lease.name) : null,
    standupState: standup.known ? standup.standup?.state ?? null : undefined,
    tabs, liveBackgroundTabIds, backgroundWorkIncomplete,
  });
  if (layout && collectAllTabs(layout.root).some((tab) => tab.orchestrationActivity?.turn?.rawInput)) {
    result.evidence.push('Unresolved terminal input: even arrows or Escape retain ownership until a matching accepted turn completes or a confirmed close/reap abandons it');
  }
  return result;
};
