import type { NextApiRequest, NextApiResponse } from 'next';
import { addTabToPane } from '@/lib/layout-store';
import { getWorkspaceById, updateWorkspaceOrchestration } from '@/lib/workspace-store';
import { resolveFirstPaneId } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { buildClaudeFlags, isValidClaudeEffort, isValidModelName } from '@/lib/claude-command';
import { createLogger } from '@/lib/logger';

const log = createLogger('orchestration');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = req.query.workspaceId as string;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const { paneId, prompt, name, model, effort, template } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt field required' });
  }
  if (model !== undefined && !isValidModelName(model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  if (effort !== undefined && !isValidClaudeEffort(effort)) {
    return res.status(400).json({ error: 'Invalid effort (low|medium|high|xhigh|max)' });
  }

  const availability = await checkAgentAvailabilityForPanelType('claude-code');
  if (!availability.ok) {
    return res.status(availability.status).json(toAgentAvailabilityError(availability));
  }

  const targetPaneId = typeof paneId === 'string' && paneId
    ? paneId
    : await resolveFirstPaneId(workspaceId);
  if (!targetPaneId) return res.status(404).json({ error: 'No pane found' });

  try {
    const flags = await buildClaudeFlags(workspaceId, { model, effort });
    const command = `claude ${flags}`;
    const tabName = typeof name === 'string' && name.trim() ? name.trim() : 'orchestrator';
    const tab = await addTabToPane(workspaceId, targetPaneId, tabName, ws.directories[0], 'claude-code', command);
    if (!tab) return res.status(404).json({ error: 'Pane not found' });

    const provider = getProviderByPanelType('claude-code');
    const manager = getStatusManager();
    manager.registerTab(tab.id, {
      cliState: 'inactive',
      workspaceId,
      tabName: tab.name,
      tmuxSession: tab.sessionName,
      panelType: tab.panelType,
      agentProviderId: provider?.id,
      agentSessionId: provider?.readSessionId(tab) ?? null,
      lastEvent: null,
      eventSeq: 0,
    });
    manager.markAgentLaunch(tab.id);

    await updateWorkspaceOrchestration(workspaceId, {
      enabled: true,
      orchestratorTabId: tab.id,
      ...(typeof template === 'string' ? { kickoffTemplate: template } : {}),
    });

    manager.queueKickoffPrompt(tab.id, prompt.trim());

    return res.status(200).json(tab);
  } catch (err) {
    log.error(`orchestrate failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to start orchestration' });
  }
};

export default handler;
