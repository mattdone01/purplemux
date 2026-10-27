import type { NextApiRequest, NextApiResponse } from 'next';
import { listAllGrants } from '@/lib/grant-store';
import { resolveCliScope } from '@/lib/workspace-token';

/**
 * `purplemux grant list` (read-only; ADR-0014). The admin token sees every
 * grant; a workspace or tab token sees the grants its workspace holds or is
 * read under — every owner grant reads every workspace (ADR-0029), so every
 * token sees it. `refused` names an unreadable grant file and is not filtered
 * by scope. Nothing here creates or revokes: that is the human route.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req, { response: res });
  if (!scope) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const listed = listAllGrants();
  if (!listed.ok) return res.status(500).json({ error: listed.error, code: 'grant-store-unreadable' });
  const grants = listed.grants.filter((g) => scope.type === 'admin'
    || g.grantee.workspaceId === scope.workspaceId
    || g.capability === 'owner'
    || g.workspaces.includes(scope.workspaceId));
  return res.status(200).json({ grants, refused: listed.refused });
};

export default handler;
