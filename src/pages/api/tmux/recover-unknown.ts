import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger('tmux');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId : undefined;
  if (!tabId) {
    return res.status(400).json({ error: 'tabId required' });
  }

  try {
    const result = await getStatusManager().recoverUnknownIfPending(tabId);
    return res.status(200).json(result);
  } catch (err) {
    log.error(`recover-unknown failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'recover-unknown failed' });
  }
};

export default handler;
