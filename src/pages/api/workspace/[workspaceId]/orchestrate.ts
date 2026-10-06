import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { addTabToPane } from '@/lib/layout-store';
import { startOrchestrationTransaction } from '@/lib/orchestration-recovery';
import { parseOrchestrationPrecondition } from '@/lib/orchestration-contract';
import { sendOrchestrationError } from '@/lib/orchestration-http';
import { resolveFirstPaneId } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { buildClaudeFlags, isValidClaudeEffort, isValidModelName } from '@/lib/claude-command';
import { createLogger } from '@/lib/logger';
import { agentLaunchConfigFromOptions } from '@/lib/agent-launch-policy';

const log = createLogger('orchestration');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = req.query.workspaceId as string;

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

  try {
    const condition = parseOrchestrationPrecondition(req.body);
    const { tab, workspace } = await startOrchestrationTransaction(workspaceId, { ...condition, actor: { kind: 'human' } }, typeof template === 'string' ? template : undefined, async (ws) => {
      const targetPaneId = typeof paneId === 'string' && paneId
        ? paneId
        : await resolveFirstPaneId(workspaceId);
      if (!targetPaneId) throw new Error('No pane found');

      const flags = await buildClaudeFlags(workspaceId, { model, effort });
      const command = `claude ${flags}`;
      const tabName = typeof name === 'string' && name.trim() ? name.trim() : 'orchestrator';
      const tab = await addTabToPane(
        workspaceId,
        targetPaneId,
        tabName,
        ws.directories[0],
        'claude-code',
        command,
        { agentLaunchConfig: agentLaunchConfigFromOptions(model, effort) },
      );
      if (!tab) throw new Error('Pane not found');
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

      return tab;
    });

    const manager = getStatusManager();
    manager.queueKickoffPrompt(tab.id, prompt.trim());

    return res.status(200).json({ ...tab, orchestration: workspace.orchestration });
  } catch (err) {
    log.error(`orchestrate failed: ${err instanceof Error ? err.message : err}`);
    return sendOrchestrationError(res, err);
  }
};

export default handler;
