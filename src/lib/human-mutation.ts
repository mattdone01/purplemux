import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHuman, requireMissionSameOrigin, sendMissionError } from '@/lib/mission-control-http';

/** Global CLI credentials are not evidence of a human browser session. */
export const authorizeHumanMutation = async (req: NextApiRequest, res: NextApiResponse): Promise<boolean> => {
  try {
    await requireMissionHuman(req);
    requireMissionSameOrigin(req);
    return true;
  } catch (error) {
    sendMissionError(res, error);
    return false;
  }
};
