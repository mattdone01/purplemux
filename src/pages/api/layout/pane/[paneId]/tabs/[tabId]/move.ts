import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { moveTabBetweenPanes } from '@/lib/layout-store';
import { getActiveWorkspaceId } from '@/lib/workspace-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wsId = (req.query.workspace as string) || await getActiveWorkspaceId();
  if (!wsId) {
    return res.status(400).json({ error: 'No workspace found' });
  }

  const tabId = req.query.tabId as string;
  const fromPaneId = req.query.paneId as string;
  const { toPaneId, toIndex } = req.body ?? {};

  if (!toPaneId || toIndex === undefined) {
    return res.status(400).json({ error: 'toPaneId and toIndex required' });
  }

  const result = await moveTabBetweenPanes(wsId, tabId, fromPaneId, toPaneId, toIndex);
  if (!result) {
    return res.status(404).json({ error: 'Target not found' });
  }
  return res.status(200).json(result);
};

export default handler;
