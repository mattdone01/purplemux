import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { MissionControlError } from '@/lib/mission-control-errors';
import { getSpendView, parseMissionSpendQuery, workspaceExists } from '@/lib/spend/spend-service';

/** The human face of `GET /api/cli/spend`: the same `ISpendView`, by period, for one workspace or all. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  try {
    await requireMissionHuman(req);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const parsed = parseMissionSpendQuery(req.query);
    if (!parsed.ok) throw new MissionControlError(400, 'invalid-request', `Invalid spend request: ${parsed.error}`);
    const { workspaceId } = parsed.query;
    if (workspaceId !== 'all' && !(await workspaceExists(workspaceId))) {
      throw new MissionControlError(400, 'invalid-request', `Invalid spend request: workspace ${workspaceId} does not exist`);
    }
    return res.status(200).json(await getSpendView(parsed.query));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
