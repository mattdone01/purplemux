import type { NextApiRequest, NextApiResponse } from 'next';
import { readCoordinationSnapshot } from '@/lib/coordination-snapshot';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';

/** The coordination panel's read (story 20): the human session only; a CLI token gets 401. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await requireMissionHuman(req);
    return res.status(200).json(await readCoordinationSnapshot());
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
