import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaceById } from '@/lib/workspace-store';
import { readStandups } from '@/lib/standup-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = req.query.workspaceId as string;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const standups = await readStandups(workspaceId);
  return res.status(200).json({ latest: standups[0] ?? null, history: standups });
};

export default handler;
