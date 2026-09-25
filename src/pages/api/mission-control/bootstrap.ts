import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { runMissionControlBootstrap } from '@/lib/mission-control-runtime';
import {
  requireMissionHuman,
  requireMissionSameOrigin,
  sendMissionError,
  setMissionHeaders,
} from '@/lib/mission-control-http';
import { MissionControlError } from '@/lib/mission-control-errors';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

const bodySchema = z.object({
  bootstrapId: z.string().trim().min(1).max(128),
  reconcile: z.boolean(),
}).strict();

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    await requireMissionHuman(req);
    requireMissionSameOrigin(req);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new MissionControlError(400, 'invalid-request', parsed.error.issues[0]?.message ?? 'invalid request');
    return res.status(200).json(await runMissionControlBootstrap(parsed.data));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
