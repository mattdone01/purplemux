import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller } from '@/lib/lease-http';
import { sendWatchError } from '@/lib/watch-http';
import { getWatchManager } from '@/lib/watch-manager';

/** DELETE — the owner tab or admin clears a watch. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    return res.status(200).json({ removed: await (await getWatchManager()).clear(caller, id) });
  } catch (err) {
    return sendWatchError(res, err);
  }
};

export default handler;
