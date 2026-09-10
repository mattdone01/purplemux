import type { NextApiRequest, NextApiResponse } from 'next';
import { codexProvider } from '@/lib/providers/codex';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { getActiveWorkspaceId } from '@/lib/workspace-store';
import { createLogger } from '@/lib/logger';
import { authorizeWorkspaceInput } from '@/lib/cli-utils';
import { prepareCodexManagedLaunch } from '@/lib/providers/codex/managed-launch';

const log = createLogger('codex-launch-command');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as { workspaceId?: unknown; resumeSessionId?: unknown; tabId?: unknown } | undefined;
  const bodyWorkspaceId = typeof body?.workspaceId === 'string' && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : null;
  const resumeSessionId = typeof body?.resumeSessionId === 'string' && body.resumeSessionId.trim()
    ? body.resumeSessionId.trim()
    : null;
  const tabId = typeof body?.tabId === 'string' && body.tabId.trim()
    ? body.tabId.trim()
    : null;
  const workspaceId = bodyWorkspaceId ?? await getActiveWorkspaceId();
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
  if (!tabId && resumeSessionId) {
    return res.status(400).json({ error: 'tabId is required to resume a Codex session' });
  }
  const hasCliToken = typeof req.headers?.['x-pmux-token'] === 'string';
  if (hasCliToken) {
    if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;
  }

  try {
    const availability = await checkAgentAvailabilityForPanelType(codexProvider.panelType);
    if (!availability.ok) {
      return res.status(availability.status).json(toAgentAvailabilityError(availability));
    }
    if (!tabId) {
      const command = await codexProvider.buildLaunchCommand({ workspaceId });
      return res.status(200).json({ command });
    }
    const prepared = await prepareCodexManagedLaunch(workspaceId, tabId, resumeSessionId);
    if (!prepared.ok) {
      const status = prepared.reason === 'tab-not-found' ? 404 : 409;
      return res.status(status).json({ error: 'Failed to prepare Codex launch', reason: prepared.reason });
    }
    const { launch } = prepared;
    return res.status(200).json({
      command: launch.command,
      generation: launch.generation,
      workspaceId: launch.workspaceId,
      tabId: launch.tabId,
      sessionName: launch.sessionName,
      resumeSessionId: launch.resumeSessionId,
    });
  } catch (err) {
    log.error(`codex launch command build failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to build Codex launch command' });
  }
};

export default handler;
