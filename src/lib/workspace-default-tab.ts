import { readLayoutFile, resolveLayoutFile, collectAllTabs } from '@/lib/layout-store';
import { getProviderByPanelType } from '@/lib/providers';
import { getStatusManager } from '@/lib/status-manager';
import type { ITab, IWorkspace } from '@/types/terminal';

export const readDefaultTab = async (workspaceId: string): Promise<ITab | null> => {
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  return layout ? collectAllTabs(layout.root)[0] ?? null : null;
};

/**
 * Registers a new workspace's first tab with the status manager. The human UI
 * (POST /api/workspace) and the CLI (POST /api/cli/workspaces) both call it, so a
 * workspace leaves the same state whichever surface created it.
 */
export const registerDefaultTab = (workspace: IWorkspace, defaultTab: ITab | null): void => {
  if (!defaultTab || defaultTab.panelType === 'web-browser') return;
  const tabProvider = getProviderByPanelType(defaultTab.panelType);
  getStatusManager().registerTab(defaultTab.id, {
    cliState: 'inactive',
    workspaceId: workspace.id,
    tabName: defaultTab.name,
    tmuxSession: defaultTab.sessionName,
    panelType: defaultTab.panelType,
    agentProviderId: tabProvider?.id,
    agentSessionId: tabProvider?.readSessionId(defaultTab) ?? null,
    lastEvent: null,
    eventSeq: 0,
  });
};
