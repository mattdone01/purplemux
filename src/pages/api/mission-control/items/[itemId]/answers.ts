import type { NextApiRequest, NextApiResponse } from 'next';
import { getMissionControlStore } from '@/lib/mission-control-store';
import {
  requireMissionHuman,
  requireMissionSameOrigin,
  sendMissionError,
  setMissionHeaders,
} from '@/lib/mission-control-http';
import { parseMissionAnswer } from '@/lib/mission-control-validation';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const actor = await requireMissionHuman(req);
    requireMissionSameOrigin(req);
    const itemId = Array.isArray(req.query.itemId) ? req.query.itemId[0] : req.query.itemId;
    if (!itemId) return res.status(400).json({ error: 'itemId is required', code: 'invalid-request' });
    const result = getMissionControlStore().submitAnswer(itemId, parseMissionAnswer(req.body), actor);
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
