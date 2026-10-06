import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getStatusManager } from '@/lib/status-manager';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tabId, resetAgentSession } = req.body as { tabId?: string; resetAgentSession?: boolean };
  if (!tabId) {
    return res.status(400).json({ error: 'tabId is required' });
  }

  getStatusManager().markAgentLaunch(tabId, { resetAgentSession: resetAgentSession === true });
  return res.status(204).end();
};

export default handler;
