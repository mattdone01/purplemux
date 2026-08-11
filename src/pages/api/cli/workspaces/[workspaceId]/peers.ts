import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCliScope } from '@/lib/workspace-token';
import { getWorkspaceById, updateWorkspaceAllowedPeers } from '@/lib/workspace-store';

const parsePeers = (raw: unknown): string[] | null => {
  if (!Array.isArray(raw)) return null;
  if (raw.some((p) => typeof p !== 'string' || !p.trim())) return null;
  return raw.map((p) => (p as string).trim());
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  // Deliberately admin-only, not authorizeWorkspace: a workspace-scoped agent
  // that could edit allowedPeers could grant itself the access this exists to
  // withhold. Granting a peer is a human decision.
  const scope = resolveCliScope(req);
  if (!scope) return res.status(403).json({ error: 'Forbidden' });
  if (scope.type !== 'admin') {
    return res.status(403).json({
      error: 'Editing allowedPeers requires the global token — an agent cannot widen its own scope. Ask the human.',
    });
  }

  const workspaceId = req.query.workspaceId as string;

  if (req.method === 'GET') {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    return res.status(200).json({ workspaceId: ws.id, name: ws.name, allowedPeers: ws.allowedPeers ?? [] });
  }

  if (req.method === 'PATCH') {
    const peers = parsePeers(req.body?.allowedPeers);
    if (!peers) {
      return res.status(400).json({ error: 'allowedPeers must be an array of workspace ids' });
    }
    const ws = await updateWorkspaceAllowedPeers(workspaceId, peers);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    return res.status(200).json({ workspaceId: ws.id, name: ws.name, allowedPeers: ws.allowedPeers ?? [] });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
