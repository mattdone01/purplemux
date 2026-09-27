import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyCliToken } from '@/lib/cli-token';
import { isRequestAllowed } from '@/lib/access-filter';
import { dispatchHook } from '@/lib/hook-dispatch';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!verifyCliToken(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!isRequestAllowed(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const outcome = await dispatchHook({ query: req.query, body: req.body });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  return res.status(outcome.status).end();
};

export default handler;
