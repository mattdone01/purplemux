// Shared directories-patch logic for the browser API (/api/workspace/[id])
// and the token-authenticated CLI API (/api/cli/workspaces/[id]), so both
// enforce identical validation and conflict rules.
import {
  getWorkspaceById,
  updateWorkspaceDirectories,
  validateDirectory,
} from '@/lib/workspace-store';
import type { IWorkspace } from '@/types/terminal';

export const parseDirectoriesPatch = (raw: unknown): string[] | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const directories: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) return null;
    directories.push(entry.trim());
  }
  return directories;
};

export type TDirectoriesPatchResult =
  | { status: 200; workspace: IWorkspace }
  | { status: 400 | 404 | 409; error: string };

export const applyDirectoriesPatch = async (
  workspaceId: string,
  raw: unknown,
): Promise<TDirectoriesPatchResult> => {
  const directories = parseDirectoriesPatch(raw);
  if (!directories) {
    return { status: 400, error: 'directories must be a non-empty array of paths' };
  }
  for (const dir of directories) {
    const check = await validateDirectory(dir);
    if (!check.valid) {
      return { status: 400, error: `${dir}: ${check.error}` };
    }
  }
  try {
    const found = await updateWorkspaceDirectories(workspaceId, directories);
    if (!found) return { status: 404, error: 'Workspace not found' };
  } catch (err) {
    return { status: 409, error: err instanceof Error ? err.message : 'Directory conflict' };
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) return { status: 404, error: 'Workspace not found' };
  return { status: 200, workspace };
};
