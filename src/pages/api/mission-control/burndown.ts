import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { MissionControlError } from '@/lib/mission-control-errors';
import { BurndownStoreError, readBurndown } from '@/lib/burndown-store';
import { getPortfolioStore } from '@/lib/portfolio-store';
import type { IMissionBurndownResponse } from '@/types/burndown';

/** The burndown the human-selected Scrum Master's workspace last published. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  try {
    await requireMissionHuman(req);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const workspaceId = getPortfolioStore().currentSelection()?.selection.managerWorkspaceId ?? null;
    let burndown: IMissionBurndownResponse['burndown'] = null;
    if (workspaceId) {
      try {
        burndown = await readBurndown(workspaceId);
      } catch (error) {
        if (error instanceof BurndownStoreError) throw new MissionControlError(503, 'storage-unavailable', error.message);
        throw error;
      }
    }
    const body: IMissionBurndownResponse = { workspaceId, burndown };
    return res.status(200).json(body);
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
