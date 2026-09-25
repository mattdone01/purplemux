import type { NextApiRequest, NextApiResponse } from 'next';
import { canDriveWorkspace } from '@/lib/cli-utils';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { resolveMissionTargetIdentity } from '@/lib/mission-control-runtime';
import { getMissionControlStore } from '@/lib/mission-control-store';
import { parseMissionEvents } from '@/lib/mission-control-validation';
import { resolveCliScope } from '@/lib/workspace-token';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new MissionControlError(400, 'invalid-request', 'workspaceId is required');
    const scope = resolveCliScope(req);
    if (!scope) throw new MissionControlError(401, 'unauthorized', 'CLI token required');
    if (!canDriveWorkspace(scope, workspaceId)) {
      throw new MissionControlError(403, 'forbidden', 'Mission Control writes require this workspace token');
    }
    const body = req.body as { events?: unknown } | null;
    const events = parseMissionEvents(body?.events);
    if (events.some((event) => event.workspaceId !== workspaceId)) {
      throw new MissionControlError(403, 'forbidden', 'Every event must match the authorized workspace');
    }
    const bindings = new Map();
    await Promise.all(events.map(async (event) => {
      if (event.type !== 'run.started' && event.type !== 'run.resumed') return;
      bindings.set(event.eventId, await resolveMissionTargetIdentity(event.workspaceId, event.payload.tabId));
    }));
    return res.status(200).json(getMissionControlStore().applyEvents(events, bindings));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
