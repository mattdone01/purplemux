import type { NextApiRequest, NextApiResponse } from 'next';
import { requireMissionHumanMutation, sendMissionError } from '@/lib/mission-control-http';
import { parseRestartRequest, restartTab } from '@/lib/tab-restart';

/**
 * Cookie twin of `POST /api/cli/tabs/[tabId]/restart` (ADR-0028), for the web
 * tab menu and the phone: a human session and this server's Origin. CLI tokens
 * do not authorize it; agents use the scoped CLI route.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let actor: string;
  try {
    ({ actor } = await requireMissionHumanMutation(req));
  } catch (error) {
    return sendMissionError(res, error);
  }
  const parsed = parseRestartRequest(req.query, req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid-request' });
  const result = await restartTab({
    workspaceId: parsed.workspaceId,
    tabId: parsed.tabId,
    clear: parsed.clear,
    interrupt: parsed.interrupt,
    by: { kind: 'human', actor },
  });
  return res.status(result.status).json(result.body);
};

export default handler;
