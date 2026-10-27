import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { getSpendView, parseCliSpendQuery, workspaceExists } from '@/lib/spend/spend-service';

/** Tokens and estimated cost for one workspace (ADR-0030); read scope on that workspace. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  if (!workspaceId) return res.status(400).json({ error: 'Invalid spend request: workspaceId is required', code: 'invalid-request' });
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const parsed = parseCliSpendQuery(req.query);
  if (!parsed.ok) return res.status(400).json({ error: `Invalid spend request: ${parsed.error}`, code: 'invalid-request' });
  if (!(await workspaceExists(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  return res.status(200).json(await getSpendView(parsed.query));
};

export default handler;
