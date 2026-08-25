import type { NextApiRequest, NextApiResponse } from 'next';
import { grokProvider } from '@/lib/providers/grok';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { createLogger } from '@/lib/logger';

const log = createLogger('grok-launch-command');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as { resumeSessionId?: unknown; model?: unknown; effort?: unknown } | undefined;
  const resumeSessionId = typeof body?.resumeSessionId === 'string' && body.resumeSessionId.trim()
    ? body.resumeSessionId.trim()
    : null;
  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const effort = typeof body?.effort === 'string' && body.effort.trim() ? body.effort.trim() : undefined;

  try {
    const availability = await checkAgentAvailabilityForPanelType(grokProvider.panelType);
    if (!availability.ok) {
      return res.status(availability.status).json(toAgentAvailabilityError(availability));
    }
    // grok scopes a session by working directory, not by workspace id — the
    // launch command reads the pane's own cwd, so no workspace is threaded here.
    const command = resumeSessionId
      ? await grokProvider.buildResumeCommand(resumeSessionId, { model, effort })
      : await grokProvider.buildLaunchCommand({ model, effort });
    return res.status(200).json({ command });
  } catch (err) {
    log.error(`grok launch command build failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to build Grok launch command' });
  }
};

export default handler;
