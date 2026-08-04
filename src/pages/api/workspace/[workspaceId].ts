import type { NextApiRequest, NextApiResponse } from 'next';
import {
  deleteWorkspace,
  getWorkspaceById,
  renameWorkspace,
  setWorkspaceGroup,
  updateWorkspaceDirectories,
  updateWorkspaceOrchestration,
  validateDirectory,
} from '@/lib/workspace-store';
import type { IWorkspaceOrchestration } from '@/types/terminal';

export const parseDirectoriesPatch = (raw: unknown): string[] | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const directories: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) return null;
    directories.push(entry.trim());
  }
  return directories;
};

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
    const { name, groupId, orchestration, directories } = req.body ?? {};

    if (directories !== undefined) {
      const parsed = parseDirectoriesPatch(directories);
      if (!parsed) {
        return res.status(400).json({ error: 'directories must be a non-empty array of paths' });
      }
      for (const dir of parsed) {
        const check = await validateDirectory(dir);
        if (!check.valid) {
          return res.status(400).json({ error: `${dir}: ${check.error}` });
        }
      }
      try {
        const found = await updateWorkspaceDirectories(workspaceId, parsed);
        if (!found) return res.status(404).json({ error: 'Workspace not found' });
      } catch (err) {
        return res.status(409).json({ error: err instanceof Error ? err.message : 'Directory conflict' });
      }
      if (name === undefined && groupId === undefined && orchestration === undefined) {
        return res.status(200).json(await getWorkspaceById(workspaceId));
      }
    }

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

    return res.status(400).json({ error: 'name, groupId, orchestration, or directories required' });
  }

  res.setHeader('Allow', 'DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
