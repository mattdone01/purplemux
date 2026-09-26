import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller } from '@/lib/lease-http';
import { sendWatchError } from '@/lib/watch-http';
import { getWatchManager } from '@/lib/watch-manager';

/** POST — a watch owned by the calling tab; GET — a workspace's watches (ADR-0015). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const manager = await getWatchManager();
    if (req.method === 'POST') return res.status(200).json({ watch: await manager.create(caller, bodyOf(req)) });
    const ws = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : null;
    return res.status(200).json({ watches: await manager.list(caller, ws) });
  } catch (err) {
    return sendWatchError(res, err);
  }
};

export default handler;
