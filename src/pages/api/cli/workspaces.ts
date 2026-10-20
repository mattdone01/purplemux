import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createWorkspace, getWorkspaces, isWorkspaceNameTakenError, validateDirectory } from '@/lib/workspace-store';
import { resolveCliScope } from '@/lib/workspace-token';
import { canAccessWorkspace } from '@/lib/cli-utils';
import { isDirectoryError } from '@/lib/path-safety';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { createLogger } from '@/lib/logger';

const log = createLogger('cli-workspaces');

const WORKSPACE_NAME_MAX = 100;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

type TCreateBody = { name: string; directories: string[] };

const parseCreateBody = (raw: unknown): TCreateBody | string => {
  const body = (raw ?? {}) as { name?: unknown; directories?: unknown };
  if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  const name = body.name.trim();
  if (name.length > WORKSPACE_NAME_MAX) return `name is longer than ${WORKSPACE_NAME_MAX} characters`;
  if (hasControlCharacter(name)) return 'name contains control characters';
  if (!Array.isArray(body.directories) || body.directories.length === 0) {
    return 'directories must be a non-empty array of absolute paths';
  }
  const directories: string[] = [];
  for (const entry of body.directories) {
    if (typeof entry !== 'string' || !entry.trim() || !path.isAbsolute(entry.trim())) {
      return `directories must be absolute paths: ${JSON.stringify(entry)}`;
    }
    directories.push(path.resolve(entry.trim()));
  }
  return { name, directories: [...new Set(directories)] };
};

const list = async (req: NextApiRequest, res: NextApiResponse) => {
  const scope = resolveCliScope(req, { response: res });
  if (!scope) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { workspaces } = await getWorkspaces();
  const visible = (
    await Promise.all(workspaces.map(async (ws) => ((await canAccessWorkspace(scope, ws.id)) ? ws : null)))
  ).filter((ws): ws is (typeof workspaces)[number] => ws !== null);
  const result = visible.map((ws) => ({
    id: ws.id,
    name: ws.name,
    directories: ws.directories,
  }));
  return res.status(200).json({ workspaces: result });
};

/**
 * Creating a workspace is the one workspace write the host's admin token holds
 * (ADR-0024): no workspace exists yet to scope a token to, and a workspace or tab
 * token must never mint a sibling it would then not own. Like every admin-token
 * authority this is cooperative, not a security boundary (ADR-0019).
 */
const create = async (req: NextApiRequest, res: NextApiResponse) => {
  const scope = resolveCliScope(req, { response: res });
  if (!scope || scope.type !== 'admin') {
    return res.status(403).json({
      error: 'workspace create needs the host admin token (~/.purplemux/cli-token); a workspace or tab token cannot create workspaces',
      code: 'forbidden',
    });
  }
  const parsed = parseCreateBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed, code: 'invalid-request' });

  const [primary, ...extra] = parsed.directories;
  for (const dir of parsed.directories) {
    const check = await validateDirectory(dir);
    if (!check.valid) {
      const role = dir === primary ? 'primary directory' : 'directory';
      return res.status(400).json({ error: `${role} ${dir}: ${check.error}`, code: 'invalid-request' });
    }
  }

  try {
    const workspace = await createWorkspace(primary, parsed.name, undefined, { uniqueName: true, extraDirectories: extra });
    // Loaded on create only: the provider registry pulls in the terminal server, which the read path never needs.
    const { readDefaultTab, registerDefaultTab } = await import('@/lib/workspace-default-tab');
    const defaultTab = await readDefaultTab(workspace.id);
    registerDefaultTab(workspace, defaultTab);
    await appendCoordinationAudit({
      event: 'workspace-create',
      workspaceId: workspace.id,
      name: workspace.name,
      directories: workspace.directories,
      by: 'admin',
    });
    log.info(`created ${workspace.id} (${workspace.name}) via CLI`);
    return res.status(200).json({
      id: workspace.id,
      name: workspace.name,
      directories: workspace.directories,
      defaultTabId: defaultTab?.id ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (isWorkspaceNameTakenError(err)) return res.status(409).json({ error: message, code: 'conflict' });
    if (isDirectoryError(err)) return res.status(400).json({ error: message, code: 'invalid-request' });
    log.error(`workspace create failed: ${message}`);
    return res.status(500).json({ error: message, code: 'workspace-create-failed' });
  }
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
