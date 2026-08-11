import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';
import { parseStandupReport } from '@/lib/standup';
import { readStandups } from '@/lib/standup-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  if (req.method === 'GET') {
    const standups = await readStandups(workspaceId);
    return res.status(200).json({ latest: standups[0] ?? null, history: standups });
  }

  if (req.method === 'POST') {
    const standup = parseStandupReport(req.body, workspaceId, Date.now());
    if (!standup) {
      return res.status(400).json({
        error: 'Invalid standup report: "state" (on-track|at-risk|blocked|awaiting-human|done) and a non-empty "headline" are required',
      });
    }
    await getStatusManager().reportStandup(standup);
    return res.status(200).json({ ok: true, standup });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
