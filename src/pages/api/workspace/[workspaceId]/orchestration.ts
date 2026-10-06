import type { NextApiRequest, NextApiResponse } from 'next';
import { getWorkspaceStrict } from '@/lib/workspace-store';
import { sendOrchestrationError } from '@/lib/orchestration-http';
import { getStatusManager } from '@/lib/status-manager';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = req.query.workspaceId as string;
  try {
  const ws = await getWorkspaceStrict(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  return res.status(200).json({
    orchestration: ws.orchestration ?? { enabled: false, orchestratorTabId: null },
    nudges: getStatusManager().getOrchestrationNudges(workspaceId),
  });
  } catch (error) { return sendOrchestrationError(res, error); }
};

export default handler;
