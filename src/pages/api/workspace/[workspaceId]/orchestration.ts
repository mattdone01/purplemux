import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaceById } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = req.query.workspaceId as string;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  return res.status(200).json({
    orchestration: ws.orchestration ?? { enabled: false, orchestratorTabId: null },
    nudges: getStatusManager().getOrchestrationNudges(workspaceId),
  });
};

export default handler;
