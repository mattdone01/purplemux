import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { removeTabFromPane, updateTabAgentLaunchConfig } from '@/lib/layout-store';
import { getProviderByPanelType } from '@/lib/providers';
import { isValidModelName } from '@/lib/claude-command-shared';
import { isValidReasoningForPanelType, reasoningErrorForPanelType } from '@/lib/agent-effort';
import type { IAgentLaunchConfig } from '@/types/terminal';
import { withCodexTargetLock } from '@/lib/providers/codex/launch-lifecycle';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;

  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }
  const authorized = req.method === 'PATCH'
    ? await authorizeWorkspaceInput(req, res, workspaceId)
    : await authorizeWorkspace(req, res, workspaceId);
  if (!authorized) return;

  if (req.method === 'GET') {
    const found = await findTab(workspaceId, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    const provider = getProviderByPanelType(found.tab.panelType);
    return res.status(200).json({
      tabId: found.tab.id,
      workspaceId: found.workspaceId,
      paneId: found.paneId,
      name: found.tab.name,
      sessionName: found.tab.sessionName,
      panelType: found.tab.panelType,
      agentProviderId: provider?.id ?? null,
      agentSessionId: provider?.readSessionId(found.tab) ?? null,
      agentLaunchConfig: found.tab.agentLaunchConfig,
    });
  }

  if (req.method === 'DELETE') {
    const found = await findTab(workspaceId, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    const ok = await removeTabFromPane(workspaceId, found.paneId, tabId);
    return res.status(200).json({ ok });
  }

  if (req.method === 'PATCH') {
    return withCodexTargetLock(workspaceId, tabId, async () => {
      const found = await findTab(workspaceId, tabId);
      if (!found) return res.status(404).json({ error: 'Tab not found' });
      if (!getProviderByPanelType(found.tab.panelType)) {
        return res.status(400).json({ error: 'Tab is not an agent panel' });
      }
      const value = req.body?.agentLaunchConfig as unknown;
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return res.status(400).json({ error: 'agentLaunchConfig must be an object or null' });
      }
      const config = value as Record<string, unknown> | null;
      if (config) {
        const unknownKeys = Object.keys(config).filter((key) => key !== 'model' && key !== 'effort');
        if (unknownKeys.length > 0) {
          return res.status(400).json({ error: 'agentLaunchConfig supports only model and effort' });
        }
        if (config.model !== undefined && !isValidModelName(config.model)) {
          return res.status(400).json({ error: 'Invalid model' });
        }
        if (config.effort !== undefined && !isValidReasoningForPanelType(found.tab.panelType!, config.effort)) {
          return res.status(400).json({ error: reasoningErrorForPanelType(found.tab.panelType!) });
        }
      }
      const nextConfig: IAgentLaunchConfig | null = config && (config.model !== undefined || config.effort !== undefined)
        ? {
            ...(config.model !== undefined ? { model: config.model as string } : {}),
            ...(config.effort !== undefined ? { effort: config.effort as string } : {}),
          }
        : null;
      const tab = await updateTabAgentLaunchConfig(workspaceId, found.paneId, tabId, nextConfig);
      if (!tab) return res.status(404).json({ error: 'Tab not found' });
      return res.status(200).json({
        tabId,
        workspaceId,
        agentLaunchConfig: tab.agentLaunchConfig ?? null,
        appliesTo: 'future-launches',
        runningProcessChanged: false,
      });
    });
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
