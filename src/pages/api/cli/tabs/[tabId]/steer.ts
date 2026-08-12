import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, findTab } from '@/lib/cli-utils';
import { steerSession } from '@/lib/agent-steer';

/**
 * Correct a worker mid-turn. Unlike `send`, which queues behind whatever the
 * agent is doing, this interrupts first so the correction is read immediately.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;

  const { content, interrupt } = req.body as { content?: string; interrupt?: boolean };
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const found = await findTab(workspaceId, tabId);
  if (!found) return res.status(404).json({ error: 'Tab not found' });

  const result = await steerSession(found.tab.sessionName, content, { interrupt });
  if (!result.ok) {
    const status = result.reason === 'session not found' ? 409 : 500;
    return res.status(status).json({ error: result.reason ?? 'steer failed' });
  }
  return res.status(200).json({ status: 'steered', interrupted: result.interrupted });
};

export default handler;
