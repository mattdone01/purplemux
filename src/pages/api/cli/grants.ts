import type { NextApiRequest, NextApiResponse } from 'next';
import { grantsRefusal, grantsSnapshot } from '@/lib/grant-store';
import { resolveCliScope } from '@/lib/workspace-token';

/**
 * `purplemux grant list` (read-only; ADR-0014). The admin token sees every
 * grant; a workspace or tab token sees the grants its workspace holds or is
 * driven under. Nothing here creates or revokes: that is the human route.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req);
  if (!scope) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const refusal = grantsRefusal();
  if (refusal) return res.status(500).json({ error: refusal, code: 'grant-store-unreadable' });
  const grants = grantsSnapshot().grants.filter((g) => scope.type === 'admin'
    || g.grantee.workspaceId === scope.workspaceId
    || g.workspaces.includes(scope.workspaceId));
  return res.status(200).json({ grants });
};

export default handler;
