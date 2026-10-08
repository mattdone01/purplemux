import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { getPortfolioStore } from '@/lib/portfolio-store';
import { tabIdentityOf } from '@/lib/tab-token';
import { hasSession } from '@/lib/tmux';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { TCliScope } from '@/lib/workspace-token';
import type { IPortfolioSelection } from '@/types/portfolio';

export const currentCoordinator = async (workspaceId: string, tabId: string): Promise<boolean> => {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace?.orchestration?.enabled || workspace.orchestration.orchestratorTabId !== tabId) return false;
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  const tab = layout && collectAllTabs(layout.root).find((entry) => entry.id === tabId);
  return !!tab?.sessionName && tabIdentityOf(workspaceId, tabId) === 'launch' && await hasSession(tab.sessionName);
};

/** A persisted human selection is effective only for its exact, still-current launch tab. */
export const selectedScrumMasterScope = async (scope: TCliScope): Promise<IPortfolioSelection | null> => {
  if (scope.type !== 'workspace' || !scope.tabVerified || !scope.tabId) return null;
  const designation = getPortfolioStore().currentSelection();
  if (!designation || designation.selection.managerWorkspaceId !== scope.workspaceId
    || designation.selection.managerTabId !== scope.tabId
    || !(await currentCoordinator(scope.workspaceId, scope.tabId))) return null;
  const stillCurrent = getPortfolioStore().currentSelection();
  return stillCurrent?.actor === designation.actor && stillCurrent.updatedAt === designation.updatedAt
    ? designation.selection : null;
};

export const selectedScrumMasterCanRead = async (scope: TCliScope, workspaceId: string): Promise<boolean> =>
  (await selectedScrumMasterScope(scope))?.workspaceIds.includes(workspaceId) ?? false;
