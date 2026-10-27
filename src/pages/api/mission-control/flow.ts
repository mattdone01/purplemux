import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { MissionControlError, invalidMissionRequest, missionNotFound } from '@/lib/mission-control-errors';
import { FLOW_WINDOW_MINUTES, isFlowStale, parseFlowHistoryMode, selectFlowHistory } from '@/lib/flow';
import { FlowStoreError, readFlow } from '@/lib/flow-store';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import type { IMissionFlowDetailResponse, IMissionFlowListResponse } from '@/types/flow';

const listFlows = async (now: number): Promise<IMissionFlowListResponse> => {
  const { workspaces } = await getWorkspaces();
  const reads = await Promise.all(workspaces.map(async (ws) => {
    try {
      return { ws, ok: true as const, flow: await readFlow(ws.id) };
    } catch (error) {
      if (error instanceof FlowStoreError) return { ws, ok: false as const, error: error.message };
      throw error;
    }
  }));
  const body: IMissionFlowListResponse = { workspaces: [], errors: [] };
  for (const read of reads) {
    if (!read.ok) {
      body.errors.push({ workspaceId: read.ws.id, error: read.error });
    } else if (read.flow) {
      body.workspaces.push({
        workspaceId: read.ws.id,
        workspaceName: read.ws.name,
        receivedAt: read.flow.receivedAt,
        generatedAt: read.flow.snapshot.generatedAt,
        source: read.flow.snapshot.source,
        stale: isFlowStale(read.flow.receivedAt, now),
        producerFlagCount: read.flow.snapshot.flags.length,
      });
    }
  }
  return body;
};

const flowDetail = async (workspaceId: string, history: unknown, now: number): Promise<IMissionFlowDetailResponse> => {
  const mode = parseFlowHistoryMode(history, 'window')
    ?? invalidMissionRequest(`history: saw ${JSON.stringify(history)}, expected window, none or all`);
  // The id reaches a file path, so only a known workspace is read.
  if (!(await getWorkspaceById(workspaceId))) missionNotFound(`Workspace ${workspaceId} not found`);
  let flow;
  try {
    flow = await readFlow(workspaceId);
  } catch (error) {
    if (error instanceof FlowStoreError) throw new MissionControlError(503, 'storage-unavailable', error.message);
    throw error;
  }
  if (!flow) return { workspaceId, flow: null, stale: null };
  return { workspaceId, flow: selectFlowHistory(flow, mode, now, FLOW_WINDOW_MINUTES), stale: isFlowStale(flow.receivedAt, now) };
};

/** Every workspace's published flow for the human, or one workspace's record with `?workspaceId=`. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  try {
    await requireMissionHuman(req);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const now = Date.now();
    const { workspaceId } = req.query;
    if (workspaceId === undefined) return res.status(200).json(await listFlows(now));
    if (typeof workspaceId !== 'string' || !workspaceId) return invalidMissionRequest('workspaceId: expected one workspace id');
    return res.status(200).json(await flowDetail(workspaceId, req.query.history, now));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
