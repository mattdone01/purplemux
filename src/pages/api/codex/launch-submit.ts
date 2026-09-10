import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput } from '@/lib/cli-utils';
import {
  submitCodexManagedLaunch,
  waitForCodexManagedLaunch,
} from '@/lib/providers/codex/managed-launch';

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = nonEmptyString(req.body?.workspaceId);
  const tabId = nonEmptyString(req.body?.tabId);
  const generation = nonEmptyString(req.body?.generation);
  if (!workspaceId || !tabId || !generation) {
    return res.status(400).json({ error: 'workspaceId, tabId, and generation are required' });
  }
  const hasCliToken = typeof req.headers?.['x-pmux-token'] === 'string';
  if (hasCliToken && !(await authorizeWorkspaceInput(req, res, workspaceId))) return;

  const submitted = await submitCodexManagedLaunch(workspaceId, tabId, generation);
  if (!submitted.ok) {
    const status = submitted.reason === 'tab-not-found' ? 404
      : submitted.phase === 'held' && submitted.reason.startsWith('terminal-submit') ? 500
        : 409;
    return res.status(status).json({
      error: 'Failed to submit Codex launch',
      reason: submitted.reason,
      phase: submitted.phase,
    });
  }
  const activated = await waitForCodexManagedLaunch(workspaceId, tabId, generation);
  if (!activated.ok) {
    return res.status(activated.phase === 'held' ? 409 : 503).json({
      error: 'Codex launch was not confirmed',
      reason: activated.reason,
      phase: activated.phase,
    });
  }
  return res.status(202).json({ generation: submitted.generation, phase: submitted.phase });
};

export default handler;
