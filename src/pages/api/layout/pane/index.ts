import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createPane, splitPaneInLayout } from '@/lib/layout-store';
import { getActiveWorkspaceId } from '@/lib/workspace-store';
import { createLogger } from '@/lib/logger';

const log = createLogger('layout');

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

  try {
    const { sourcePaneId, orientation, cwd, panelType } = req.body ?? {};

    if (sourcePaneId && orientation) {
      const result = await splitPaneInLayout(wsId, sourcePaneId, orientation, cwd, panelType);
      if (!result) {
        return res.status(404).json({ error: 'Target pane not found' });
      }
      return res.status(200).json(result);
    }

    const result = await createPane(wsId, cwd);
    return res.status(200).json(result);
  } catch (err) {
    log.error(`pane creation failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to create pane' });
  }
};

export default handler;
