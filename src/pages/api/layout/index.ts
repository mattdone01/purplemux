import { requireMissionHuman, sendMissionError } from '@/lib/mission-control-http';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getLayout, patchLayout } from '@/lib/layout-store';
import { getActiveWorkspaceId, getWorkspaceById } from '@/lib/workspace-store';
import { createLogger } from '@/lib/logger';

const log = createLogger('layout');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  const wsId = (req.query.workspace as string) || await getActiveWorkspaceId();
  if (!wsId) {
    return res.status(400).json({ error: 'No workspace found' });
  }

  if (req.method === 'GET') {
    if (!req.headers['x-pmux-token']) {
      try {
        await requireMissionHuman(req);
      } catch (error) {
        sendMissionError(res, error);
        return;
      }
    }
    try {
      if (req.headers['x-pmux-token']) {
        if (!(await authorizeWorkspace(req, res, wsId))) return;
        const existing = await readWorkspaceLayout(wsId);
        return existing ? res.status(200).json(existing) : res.status(404).json({ error: 'Layout not found' });
      }
      const ws = await getWorkspaceById(wsId);
      const layout = await getLayout(wsId, ws?.directories[0]);
      return res.status(200).json(layout);
    } catch (err) {
      log.error(`GET failed: ${err instanceof Error ? err.message : err}`);
      return res.status(500).json({ error: 'Failed to load layout' });
    }
  }

  if (req.method === 'PATCH') {
    const { activePaneId, ratioUpdate, equalize, diffSettings } = req.body ?? {};
    const result = await patchLayout(wsId, { activePaneId, ratioUpdate, equalize, diffSettings });
    if (!result) {
      return res.status(404).json({ error: 'Target not found' });
    }
    return res.status(200).json(result);
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
