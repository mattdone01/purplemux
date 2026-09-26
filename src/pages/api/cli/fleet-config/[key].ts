import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteValue, putValue, sendFleetConfigError } from '@/lib/fleet-config-http';
import { bodyOf, requireCaller } from '@/lib/lease-http';

/** PUT sets, DELETE unsets; the admin token or the workspace's enabled orchestrator tab (ADR-0019). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const key = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
  try {
    const result = req.method === 'PUT'
      ? await putValue(caller, key, bodyOf(req))
      : await deleteValue(caller, key, bodyOf(req));
    return res.status(200).json(result);
  } catch (err) {
    return sendFleetConfigError(res, err);
  }
};

export default handler;
