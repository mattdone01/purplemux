import type { NextApiRequest, NextApiResponse } from 'next';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { readConfig, verifyPassword } from '@/lib/config-store';
import type { IGrantDeps } from '@/lib/grant-service';
import { isGrantError } from '@/lib/grant-store';
import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { isMissionControlError } from '@/lib/mission-control-errors';
import { requireMissionHuman, requireMissionSameOrigin, sendMissionError } from '@/lib/mission-control-http';
import { tabIdentityOf } from '@/lib/tab-token';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import type { IGrantee } from '@/types/grant';

const log = createLogger('grants-http');

const STATUS: Record<string, number> = {
  'grant-invalid': 400,
  'grant-not-found': 404,
  'grant-tab-unverified': 409,
  'grant-password-invalid': 403,
  'grant-locked': 429,
  'grant-store-unreadable': 500,
};

export const defaultGrantDeps = (): IGrantDeps => ({
  now: () => Date.now(),
  passwordHash: async () => (await readConfig())?.authPassword ?? null,
  verifyPassword,
  workspaceExists: async (id) => !!(await getWorkspaceById(id)),
  // Read-only: never creates a default layout for an unreadable one.
  tabExists: async (ws, tab) => {
    const layout = await readLayoutFile(resolveLayoutFile(ws));
    return !!layout && collectAllTabs(layout.root).some((t) => t.id === tab);
  },
  tabIdentity: tabIdentityOf,
  audit: appendCoordinationAudit,
});

/**
 * Every tab a human may pick as a grantee, with its identity (story 28): only a
 * `launch` identity can hold a grant, and the dialog says so before a submit.
 * Read-only: an unreadable layout lists none of its tabs.
 */
export const listGrantees = async (): Promise<IGrantee[]> => {
  const { workspaces } = await getWorkspaces();
  const grantees: IGrantee[] = [];
  for (const ws of workspaces) {
    const layout = await readLayoutFile(resolveLayoutFile(ws.id)).catch(() => null);
    if (!layout) continue;
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.panelType === 'web-browser') continue;
      grantees.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        tabId: tab.id,
        name: tab.name,
        panelType: tab.panelType ?? 'terminal',
        identity: tabIdentityOf(ws.id, tab.id),
      });
    }
  }
  return grantees;
};

/** The human gate of every grant mutation (ADR-0014): a web session and this server's Origin. */
export const requireGrantHuman = async (req: NextApiRequest): Promise<string> => {
  const subject = await requireMissionHuman(req);
  requireMissionSameOrigin(req);
  return subject;
};

export const sendGrantError = (res: NextApiResponse, err: unknown): void => {
  if (isGrantError(err)) {
    res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
    return;
  }
  if (isMissionControlError(err)) {
    sendMissionError(res, err);
    return;
  }
  log.error(`grants route failed: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'grant operation failed', code: 'grant-internal' });
};

export const bodyOf = (req: NextApiRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
