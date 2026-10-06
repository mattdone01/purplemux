import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCliScope } from '@/lib/workspace-token';
import { getWorkspaceById, updateWorkspaceAllowedPeers } from '@/lib/workspace-store';

const parsePeers = (raw: unknown): string[] | null => {
  if (!Array.isArray(raw)) return null;
  if (raw.some((p) => typeof p !== 'string' || !p.trim())) return null;
  return raw.map((p) => (p as string).trim());
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'PATCH') {
    if (!(await authorizeHumanMutation(req, res))) return;
  } else {
    const scope = resolveCliScope(req, { response: res });
    if (scope?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
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
