import type { NextApiRequest, NextApiResponse } from 'next';
import { getMissionControlStore } from '@/lib/mission-control-store';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { parseMissionCursor, parseMissionLimit } from '@/lib/mission-control-validation';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await requireMissionHuman(req);
    const after = parseMissionCursor(req.query.after, 0);
    const limit = parseMissionLimit(req.query.limit, 100, 200);
    return res.status(200).json(getMissionControlStore().eventsAfter(after, limit));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
