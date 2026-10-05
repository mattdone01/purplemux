import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { reorderTabsInPane } from '@/lib/layout-store';
import { getActiveWorkspaceId } from '@/lib/workspace-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wsId = (req.query.workspace as string) || await getActiveWorkspaceId();
  if (!wsId) {
    return res.status(400).json({ error: 'No workspace found' });
  }

  const paneId = req.query.paneId as string;
  const { tabIds } = req.body ?? {};

  if (!Array.isArray(tabIds) || tabIds.length === 0) {
    return res.status(400).json({ error: 'tabIds array required' });
  }

  const result = await reorderTabsInPane(wsId, paneId, tabIds);
  if (!result) {
    return res.status(404).json({ error: 'Target not found' });
  }
  return res.status(200).json(result);
};

export default handler;
