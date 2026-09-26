import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { steerSession } from '@/lib/agent-steer';
import { withAgentDispatchLock } from '@/lib/agent-dispatch-policy';
import { TAB_NOT_FOUND_BODY, targetChangedBody } from '@/lib/cli-error';

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
  if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;

  const { content, interrupt } = req.body as { content?: string; interrupt?: boolean };
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const found = await findTab(workspaceId, tabId);
  if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);

  return withAgentDispatchLock(workspaceId, found.tab, async (checkPolicy) => {
    const current = await findTab(workspaceId, tabId);
    if (!current || current.tab.sessionName !== found.tab.sessionName) {
      return res.status(409).json(targetChangedBody(tabId));
    }
    let policy = await checkPolicy();
    if (!policy.ok) return res.status(409).json(policy);

    const result = await steerSession(current.tab.sessionName, content, {
      interrupt,
      beforeDeliver: async () => {
        policy = await checkPolicy();
        return policy.ok;
      },
    });
    if (!policy.ok) return res.status(409).json(policy);
    if (!result.ok) {
      if (result.reason === 'session not found') {
        return res.status(409).json({ error: result.reason, code: 'session-not-running' });
      }
      return res.status(500).json({ error: result.reason ?? 'steer failed' });
    }
    return res.status(200).json({ status: 'steered', interrupted: result.interrupted });
  });
};

export default handler;
