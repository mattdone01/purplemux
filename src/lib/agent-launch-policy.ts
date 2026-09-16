import { collectAllTabs, parseSessionName, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import type { IAgentLaunchConfig, ITab } from '@/types/terminal';

export interface IResolvedAgentLaunchPolicy {
  workspaceId: string;
  tabId: string;
  sessionName: string;
  options: IAgentLaunchConfig;
}

export const agentLaunchConfigFromOptions = (
  model?: string,
  effort?: string,
): IAgentLaunchConfig | undefined => {
  if (model === undefined && effort === undefined) return undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
};

export const agentLaunchOptionsForTab = (
  tab: Pick<ITab, 'agentLaunchConfig'>,
): IAgentLaunchConfig => ({
  ...(tab.agentLaunchConfig?.model !== undefined ? { model: tab.agentLaunchConfig.model } : {}),
  ...(tab.agentLaunchConfig?.effort !== undefined ? { effort: tab.agentLaunchConfig.effort } : {}),
});

export const resolveAgentLaunchPolicy = async (
  workspaceId: string,
  tabId: string,
): Promise<IResolvedAgentLaunchPolicy | null> => {
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  if (!layout) return null;
  const tab = collectAllTabs(layout.root).find((candidate) => candidate.id === tabId);
  if (!tab) return null;
  return { workspaceId, tabId, sessionName: tab.sessionName, options: agentLaunchOptionsForTab(tab) };
};

export const resolveAgentLaunchPolicyForSession = async (
  sessionName: string,
): Promise<IResolvedAgentLaunchPolicy | null> => {
  const parsed = parseSessionName(sessionName);
  if (!parsed) return null;
  return resolveAgentLaunchPolicy(parsed.wsId, parsed.tabId);
};
