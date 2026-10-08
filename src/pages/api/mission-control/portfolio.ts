import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHuman, requireMissionHumanMutation, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { MissionControlError } from '@/lib/mission-control-errors';
import { assignPortfolioAction, confirmPortfolioMilestone, getPortfolioSnapshot, requirePortfolioCoverage, selectPortfolioScope } from '@/lib/portfolio-service';
import { getPortfolioStore } from '@/lib/portfolio-store';
import { parsePortfolioAction, parsePortfolioMilestone, parsePortfolioSelection } from '@/lib/portfolio-validation';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  try {
    const actor = await requireMissionHuman(req);
    if (req.method === 'GET') return res.status(200).json(await getPortfolioSnapshot());
    const authority = await requireMissionHumanMutation(req);
    if (req.method === 'PUT') {
      await selectPortfolioScope(actor, parsePortfolioSelection(req.body));
      return res.status(200).json(await getPortfolioSnapshot());
    }
    if (req.method === 'POST') {
      const body = req.body as Record<string, unknown> | null;
      if (body?.type === 'acknowledge') {
        const workspaceId = body.workspaceId;
        const impactId = body.impactId;
        const expectedRevision = body.expectedRevision;
        if (typeof workspaceId !== 'string' || typeof impactId !== 'string'
          || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
          throw new MissionControlError(400, 'invalid-request', 'workspaceId, impactId and expectedRevision are required');
        }
        await requirePortfolioCoverage(workspaceId);
        const impact = getPortfolioStore().impact(impactId);
        if (!impact || impact.workspaceId !== workspaceId) {
          throw new MissionControlError(404, 'not-found', 'blocker not found in selected workspace');
        }
        return res.status(200).json({ impact: getPortfolioStore().acknowledge(impactId, Number(expectedRevision)) });
      }
      if (body?.type === 'assign') {
        return res.status(200).json({ impact: await assignPortfolioAction(authority, parsePortfolioAction({
          actionId: body.actionId, workspaceId: body.workspaceId, impactId: body.impactId,
          expectedRevision: body.expectedRevision, decision: body.decision,
        })) });
      }
      if (body?.type === 'milestone') {
        return res.status(200).json({ milestone: await confirmPortfolioMilestone(authority,
          parsePortfolioMilestone({ eventId: body.eventId, workspaceId: body.workspaceId,
            runId: body.runId, stage: body.stage, evidence: body.evidence,
            observedAt: body.observedAt })) });
      }
      throw new MissionControlError(400, 'invalid-request', 'unknown portfolio action');
    }
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
