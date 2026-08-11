import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, findTab } from '@/lib/cli-utils';
import { sendBracketedPaste, hasSession } from '@/lib/tmux';

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

  const { content } = req.body as { content?: string };
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const found = await findTab(workspaceId, tabId);
  if (!found) return res.status(404).json({ error: 'Tab not found' });

  const alive = await hasSession(found.tab.sessionName);
  if (!alive) return res.status(409).json({ error: 'Tab session is not running' });

  await sendBracketedPaste(found.tab.sessionName, content);
  return res.status(200).json({ status: 'sent' });
};

export default handler;
