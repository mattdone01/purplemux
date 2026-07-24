import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteWorkspace, renameWorkspace, setWorkspaceGroup, updateWorkspaceOrchestration } from '@/lib/workspace-store';
import type { IWorkspaceOrchestration } from '@/types/terminal';

const parseOrchestrationPatch = (raw: unknown): Partial<IWorkspaceOrchestration> | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const patch: Partial<IWorkspaceOrchestration> = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return null;
    patch.enabled = body.enabled;
  }
  if (body.orchestratorTabId !== undefined) {
    if (body.orchestratorTabId !== null && typeof body.orchestratorTabId !== 'string') return null;
    patch.orchestratorTabId = body.orchestratorTabId;
  }
  if (body.kickoffTemplate !== undefined) {
    if (body.kickoffTemplate !== null && typeof body.kickoffTemplate !== 'string') return null;
    patch.kickoffTemplate = body.kickoffTemplate;
  }
  return patch;
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const workspaceId = req.query.workspaceId as string;

  if (req.method === 'DELETE') {
    const found = await deleteWorkspace(workspaceId);
    if (!found) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    return res.status(204).end();
  }

  if (req.method === 'PATCH') {
    const { name, groupId, orchestration } = req.body ?? {};

    if (orchestration !== undefined) {
      const patch = parseOrchestrationPatch(orchestration);
      if (!patch) {
        return res.status(400).json({ error: 'Invalid orchestration settings' });
      }
      const ws = await updateWorkspaceOrchestration(workspaceId, patch);
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      if (name === undefined && groupId === undefined) return res.status(200).json(ws);
    }

    if (groupId !== undefined) {
      const next = groupId === null ? null : typeof groupId === 'string' ? groupId : undefined;
      if (next === undefined) {
        return res.status(400).json({ error: 'Invalid groupId' });
      }
      const ok = await setWorkspaceGroup(workspaceId, next);
      if (!ok) return res.status(404).json({ error: 'Workspace not found' });
      if (name === undefined) return res.status(200).json({ ok: true });
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name field required' });
      }
      const ws = await renameWorkspace(workspaceId, name.trim());
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      return res.status(200).json(ws);
    }

    return res.status(400).json({ error: 'name, groupId, or orchestration required' });
  }

  res.setHeader('Allow', 'DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
