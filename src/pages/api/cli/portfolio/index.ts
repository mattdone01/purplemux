import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller } from '@/lib/caller';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { getPortfolioSnapshotForSelection } from '@/lib/portfolio-service';
import { parsePortfolioSelection } from '@/lib/portfolio-validation';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const caller = await resolveCaller(req, res);
    if (!caller?.verified || !caller.workspaceId || !caller.tabId) {
      throw new MissionControlError(403, 'forbidden', 'Portfolio reads require a launch-verified manager tab');
    }
    const raw = req.query.workspaces;
    const workspaceIds = typeof raw === 'string' ? raw.split(',').filter(Boolean) : [];
    if (workspaceIds.length === 0 || workspaceIds.length > 100 || new Set(workspaceIds).size !== workspaceIds.length) {
      throw new MissionControlError(400, 'invalid-request', 'Select 1–100 distinct workspace IDs');
    }
    return res.status(200).json(await getPortfolioSnapshotForSelection(parsePortfolioSelection({
      managerWorkspaceId: caller.workspaceId, managerTabId: caller.tabId, workspaceIds,
    })));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
