import type { NextApiRequest, NextApiResponse } from 'next';
import { getDeployAnnouncer } from '@/lib/deploy-announce';
import { sendDeployError } from '@/lib/deploy-http';
import { requireCaller, requireMethod } from '@/lib/lease-http';

/** The reason and, per recipient, the notice's delivery state and the tab's cliState. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    return res.status(200).json(await (await getDeployAnnouncer()).status(caller, id));
  } catch (err) {
    return sendDeployError(res, err);
  }
};

export default handler;
