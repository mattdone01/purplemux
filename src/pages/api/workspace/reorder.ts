import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { reorderWorkspaces, type IReorderItem } from '@/lib/workspace-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body ?? {};

  let items: IReorderItem[] | null = null;
  if (Array.isArray(body.items) && body.items.length > 0) {
    items = body.items.map((it: { id: unknown; groupId?: unknown }) => ({
      id: String(it.id),
      groupId: it.groupId === null ? null : typeof it.groupId === 'string' ? it.groupId : undefined,
    }));
  } else if (Array.isArray(body.workspaceIds) && body.workspaceIds.length > 0) {
    items = body.workspaceIds.map((id: string) => ({ id: String(id) }));
  }

  if (!items) {
    return res.status(400).json({ error: 'items array required' });
  }

  const ok = await reorderWorkspaces(items);
  if (!ok) {
    return res.status(400).json({ error: 'Invalid order' });
  }

  return res.status(200).json({ ok: true });
};

export default handler;
