import type { NextApiRequest, NextApiResponse } from 'next';
import { getMissionSnapshot } from '@/lib/mission-control-runtime';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { parseIncludeTest } from '@/lib/mission-control-validation';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await requireMissionHuman(req);
    // The owner's default view never serves a test-only run (story 57); the acceptance app asks with ?includeTest=1.
    const includeTest = parseIncludeTest(req.query.includeTest);
    return res.status(200).json(await getMissionSnapshot(undefined, { includeTest }));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
