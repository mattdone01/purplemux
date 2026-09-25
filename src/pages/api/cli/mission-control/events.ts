import type { NextApiRequest, NextApiResponse } from 'next';
import { canDriveWorkspace } from '@/lib/cli-utils';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { resolveMissionTargetIdentity } from '@/lib/mission-control-runtime';
import { getMissionControlStore, type IMissionEventAuthority } from '@/lib/mission-control-store';
import { parseMissionEvents } from '@/lib/mission-control-validation';
import { resolveCliScope } from '@/lib/workspace-token';
import { getWorkspaceById } from '@/lib/workspace-store';

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
    const store = getMissionControlStore();
    const unreplayed = store.unreplayedEventIds(events);
    const identities = new Map<string, Awaited<ReturnType<typeof resolveMissionTargetIdentity>>>();
    await Promise.all(events.map(async (event) => {
      if (!unreplayed.has(event.eventId)) return;
      const tabId = event.type === 'run.started' || event.type === 'run.resumed'
        ? event.payload.tabId
        : (event.type === 'attention.opened' || event.type === 'attention.updated')
          ? event.payload.humanReview?.reviewerTabId
          : undefined;
      if (tabId) identities.set(event.eventId, await resolveMissionTargetIdentity(event.workspaceId, tabId));
    }));
    const needsReviewAuthority = events.some((event) => unreplayed.has(event.eventId)
      && (event.type === 'attention.opened' || event.type === 'attention.updated')
      && event.payload.humanReview !== undefined);
    const configuredOrchestratorTabId = needsReviewAuthority
      ? (await getWorkspaceById(workspaceId))?.orchestration?.orchestratorTabId ?? null
      : null;
    const authorities = new Map<string, IMissionEventAuthority>();
    for (const event of events) {
      if (!unreplayed.has(event.eventId)) continue;
      authorities.set(event.eventId, {
        resolvedIdentity: identities.get(event.eventId) ?? null,
        configuredOrchestratorTabId,
      });
    }
    return res.status(200).json({
      ...store.applyEvents(events, authorities),
      humanInboxPolicy: store.humanInboxPolicy(workspaceId),
    });
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
