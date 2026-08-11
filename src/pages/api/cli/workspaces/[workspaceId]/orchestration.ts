import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { getWorkspaceById, updateWorkspaceOrchestration } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';
import { parseOrchestrationPatch } from '@/lib/orchestration';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  if (req.method === 'GET') {
    return res.status(200).json({
      orchestration: ws.orchestration ?? { enabled: false, orchestratorTabId: null },
      nudges: getStatusManager().getOrchestrationNudges(workspaceId),
    });
  }

  if (req.method === 'PATCH') {
    const patch = parseOrchestrationPatch(req.body);
    if (!patch) return res.status(400).json({ error: 'Invalid orchestration settings' });
    const updated = await updateWorkspaceOrchestration(workspaceId, patch);
    if (!updated) return res.status(404).json({ error: 'Workspace not found' });
    return res.status(200).json({ orchestration: updated.orchestration });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
