import type { NextApiRequest, NextApiResponse } from 'next';
import { getMissionSnapshot } from '@/lib/mission-control-runtime';
import { getWorkspaceById } from '@/lib/workspace-store';
import { canAccessWorkspace } from '@/lib/cli-utils';
import { resolveCliScope } from '@/lib/workspace-token';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { getMissionControlStore } from '@/lib/mission-control-store';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new MissionControlError(400, 'invalid-request', 'workspaceId is required');
    const scope = resolveCliScope(req);
    if (!scope) throw new MissionControlError(401, 'unauthorized', 'CLI token required');
    if (!(await canAccessWorkspace(scope, workspaceId))) throw new MissionControlError(403, 'forbidden', 'Workspace is outside this token scope');
    if (!(await getWorkspaceById(workspaceId))) throw new MissionControlError(404, 'not-found', 'Workspace not found');
    return res.status(200).json({
      ...await getMissionSnapshot(workspaceId),
      humanInboxPolicy: getMissionControlStore().humanInboxPolicy(workspaceId),
    });
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
