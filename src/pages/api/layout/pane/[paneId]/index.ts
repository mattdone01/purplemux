import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { deletePane, patchPane, closePaneInLayout } from '@/lib/layout-store';
import { getActiveWorkspaceId } from '@/lib/workspace-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  const wsId = (req.query.workspace as string) || await getActiveWorkspaceId();
  const paneId = req.query.paneId as string;

  if (req.method === 'DELETE') {
    if (!wsId) {
      const sessions: string[] = req.body?.sessions ?? [];
      await deletePane(paneId, sessions);
      return res.status(204).end();
    }
    const result = await closePaneInLayout(wsId, paneId);
    if (!result) {
      return res.status(404).json({ error: 'Pane not found' });
    }
    return res.status(200).json(result);
  }

  if (req.method === 'PATCH') {
    if (!wsId) {
      return res.status(400).json({ error: 'No workspace found' });
    }
    const { activeTabId } = req.body ?? {};
    const result = await patchPane(wsId, paneId, { activeTabId });
    if (!result) {
      return res.status(404).json({ error: 'Target not found' });
    }
    return res.status(200).json(result);
  }

  res.setHeader('Allow', 'DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
