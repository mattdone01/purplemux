import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { renameGroup, ungroupGroup, setGroupCollapsed } from '@/lib/workspace-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  const groupId = req.query.groupId as string;

  if (req.method === 'DELETE') {
    const ok = await ungroupGroup(groupId);
    if (!ok) return res.status(404).json({ error: 'Group not found' });
    return res.status(204).end();
  }

  if (req.method === 'PATCH') {
    const { name, collapsed } = req.body ?? {};

    if (collapsed !== undefined) {
      if (typeof collapsed !== 'boolean') {
        return res.status(400).json({ error: 'collapsed must be boolean' });
      }
      const ok = await setGroupCollapsed(groupId, collapsed);
      if (!ok) return res.status(404).json({ error: 'Group not found' });
      if (name === undefined) return res.status(200).json({ ok: true });
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name required' });
      }
      const group = await renameGroup(groupId, name.trim());
      if (!group) return res.status(404).json({ error: 'Group not found' });
      return res.status(200).json(group);
    }

    return res.status(400).json({ error: 'name or collapsed required' });
  }

  res.setHeader('Allow', 'DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
