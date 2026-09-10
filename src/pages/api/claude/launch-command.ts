import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput } from '@/lib/cli-utils';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { resolveAgentLaunchPolicy } from '@/lib/agent-launch-policy';
import { updateTabAgentState } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { claudeProvider } from '@/lib/providers/claude';
import { getActiveWorkspaceId } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';

const log = createLogger('claude-launch-command');

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as {
    workspaceId?: unknown;
    resumeSessionId?: unknown;
    tabId?: unknown;
  } | undefined;
  const bodyWorkspaceId = nonEmptyString(body?.workspaceId);
  const resumeSessionId = nonEmptyString(body?.resumeSessionId);
  const tabId = nonEmptyString(body?.tabId);
  const workspaceId = bodyWorkspaceId ?? await getActiveWorkspaceId();
  const hasCliToken = typeof req.headers?.['x-pmux-token'] === 'string';
  if (hasCliToken) {
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
    if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;
  }

  try {
    const availability = await checkAgentAvailabilityForPanelType(claudeProvider.panelType);
    if (!availability.ok) {
      return res.status(availability.status).json(toAgentAvailabilityError(availability));
    }
    const launchPolicy = workspaceId && tabId
      ? await resolveAgentLaunchPolicy(workspaceId, tabId)
      : null;
    if (tabId && !launchPolicy) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    const options = {
      workspaceId: workspaceId ?? undefined,
      ...launchPolicy?.options,
    };
    const command = resumeSessionId
      ? await claudeProvider.buildResumeCommand(resumeSessionId, options)
      : await claudeProvider.buildLaunchCommand(options);
    if (resumeSessionId && launchPolicy) {
      await updateTabAgentState(launchPolicy.sessionName, claudeProvider, {
        sessionId: resumeSessionId,
        jsonlPath: null,
        summary: null,
        lastUserMessage: null,
      });
      getStatusManager().markAgentLaunch(launchPolicy.tabId, { resumeSessionId });
    }
    return res.status(200).json({ command });
  } catch (err) {
    log.error(`claude launch command build failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to build Claude launch command' });
  }
};

export default handler;
