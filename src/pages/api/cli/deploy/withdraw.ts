import type { NextApiRequest, NextApiResponse } from 'next';
import { getDeployAnnouncer } from '@/lib/deploy-announce';
import { sendDeployError } from '@/lib/deploy-http';
import { bodyOf, requireCaller, requireMethod } from '@/lib/lease-http';

/** The admin token or the deploy lease holder takes back the notices still waiting (review round 1). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    return res.status(200).json(await (await getDeployAnnouncer()).withdraw(caller, bodyOf(req).id));
  } catch (err) {
    return sendDeployError(res, err);
  }
};

export default handler;
