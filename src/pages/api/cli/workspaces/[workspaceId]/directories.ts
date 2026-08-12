import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import { applyDirectoriesPatch } from '@/lib/workspace-patch';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;

  if (req.method === 'GET') {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    return res.status(200).json({ workspaceId: ws.id, name: ws.name, directories: ws.directories });
  }

  if (req.method === 'PATCH') {
    const result = await applyDirectoriesPatch(workspaceId, req.body?.directories);
    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(200).json({
      workspaceId: result.workspace.id,
      name: result.workspace.name,
      directories: result.workspace.directories,
    });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
