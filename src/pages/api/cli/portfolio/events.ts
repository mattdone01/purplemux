import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller } from '@/lib/caller';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { reportPortfolioBlocker, requirePortfolioProducer, resolvePortfolioCapacity } from '@/lib/portfolio-service';
import { getPortfolioStore } from '@/lib/portfolio-store';
import { parsePortfolioApplied, parsePortfolioReport, parsePortfolioResolution } from '@/lib/portfolio-validation';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const caller = await resolveCaller(req, res);
    if (!caller) throw new MissionControlError(401, 'unauthorized', 'Workspace tab token required');
    const body = req.body as Record<string, unknown> | null;
    if (body?.type === 'applied') {
      const applied = parsePortfolioApplied({ schemaVersion: body.schemaVersion, workspaceId: body.workspaceId, runId: body.runId,
        bindingGeneration: body.bindingGeneration, impactId: body.impactId, noteId: body.noteId,
        eventId: body.eventId, expectedRevision: body.expectedRevision });
      await requirePortfolioProducer(caller, applied.workspaceId, applied.runId, applied.bindingGeneration);
      const impact = getPortfolioStore().impact(applied.impactId);
      if (!impact || impact.workspaceId !== applied.workspaceId || impact.runId !== applied.runId) {
        throw new MissionControlError(404, 'not-found', 'blocker not found in this run');
      }
      return res.status(200).json({ impact: getPortfolioStore().markApplied(applied.impactId, applied.noteId,
        applied.eventId, applied.expectedRevision) });
    }
    if (body?.type === 'resolved') {
      return res.status(200).json({ impact: await resolvePortfolioCapacity(caller, parsePortfolioResolution(body)) });
    }
    return res.status(200).json(await reportPortfolioBlocker(caller, parsePortfolioReport(body)));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
