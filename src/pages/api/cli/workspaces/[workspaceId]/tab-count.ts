import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { FleetConfigFileError } from '@/lib/fleet-config-store';
import { readTabCount } from '@/lib/tab-cap';
import { getWorkspaceById } from '@/lib/workspace-store';

// The workspace's agent tabs against the WIP cap (ADR-0027): what repository
// hooks read instead of counting tmux sessions.

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    return res.status(200).json(await readTabCount(workspaceId));
  } catch (err) {
    if (err instanceof FleetConfigFileError) return res.status(503).json({ error: err.message, code: err.code });
    return res.status(500).json({
      error: `tab count could not be read: ${err instanceof Error ? err.message : String(err)}`,
      code: 'tab-count-unreadable',
    });
  }
};

export default handler;
