import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, findTab } from '@/lib/cli-utils';
import { hasSession, getPaneCurrentCommand } from '@/lib/tmux';
import { getProviderByPanelType } from '@/lib/providers';
import { getLivenessManager } from '@/lib/liveness-manager';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;

  const found = await findTab(workspaceId, tabId);
  if (!found) return res.status(404).json({ error: 'Tab not found' });

  const provider = getProviderByPanelType(found.tab.panelType);
  const agentSessionId = provider?.readSessionId(found.tab) ?? null;
  const alive = await hasSession(found.tab.sessionName);
  // Registered liveness watch, so idle-done and idle-holding-dead-work are
  // distinguishable from the status read alone.
  const { probes, backgroundJobs } = await getLivenessManager().statusForTab(tabId);
  if (!alive) {
    return res.status(200).json({
      tabId,
      workspaceId,
      alive: false,
      agentProviderId: provider?.id ?? null,
      agentSessionId,
      claudeSessionId: agentSessionId,
      probes,
      backgroundJobs,
    });
  }

  const command = await getPaneCurrentCommand(found.tab.sessionName);
  return res.status(200).json({
    tabId,
    workspaceId,
    alive: true,
    command,
    cliState: found.tab.cliState ?? null,
    agentProviderId: provider?.id ?? null,
    agentSessionId,
    // Response key kept as `claudeSessionId` for back-compat with external CLI consumers.
    claudeSessionId: agentSessionId,
    probes,
    backgroundJobs,
  });
};

export default handler;
