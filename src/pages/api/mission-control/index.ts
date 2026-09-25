import type { NextApiRequest, NextApiResponse } from 'next';
import { getMissionSnapshot } from '@/lib/mission-control-runtime';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await requireMissionHuman(req);
    return res.status(200).json(await getMissionSnapshot());
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
