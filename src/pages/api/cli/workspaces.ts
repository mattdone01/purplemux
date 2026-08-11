import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaces } from '@/lib/workspace-store';
import { resolveCliScope } from '@/lib/workspace-token';
import { canAccessWorkspace } from '@/lib/cli-utils';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req);
  if (!scope) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { workspaces } = await getWorkspaces();
  const visible = (
    await Promise.all(workspaces.map(async (ws) => ((await canAccessWorkspace(scope, ws.id)) ? ws : null)))
  ).filter((ws): ws is (typeof workspaces)[number] => ws !== null);
  const result = visible.map((ws) => ({
    id: ws.id,
    name: ws.name,
    directories: ws.directories,
  }));
  return res.status(200).json({ workspaces: result });
};

export default handler;
