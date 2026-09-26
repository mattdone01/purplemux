import type { NextApiRequest, NextApiResponse } from 'next';
import { readValues, sendFleetConfigError } from '@/lib/fleet-config-http';
import { requireCaller, requireMethod } from '@/lib/lease-http';

/** Any valid CLI scope reads fleet config (ADR-0019). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  if (!(await requireCaller(req, res))) return;
  try {
    return res.status(200).json(await readValues(req.query));
  } catch (err) {
    return sendFleetConfigError(res, err);
  }
};

export default handler;
