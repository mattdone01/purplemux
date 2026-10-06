import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { reorderGroups } from '@/lib/workspace-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { groupIds } = req.body ?? {};
  if (!Array.isArray(groupIds)) {
    return res.status(400).json({ error: 'groupIds array required' });
  }

  const ok = await reorderGroups(groupIds.map(String));
  if (!ok) return res.status(400).json({ error: 'Invalid order' });
  return res.status(200).json({ ok: true });
};

export default handler;
