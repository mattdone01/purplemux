import type { NextApiRequest } from 'next';
import { collectAllTabs, findTabBySessionName, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import type { ITab } from '@/types/terminal';
import { resolveCliScope, type TCliScope } from '@/lib/workspace-token';

export interface ICaller {
  scope: TCliScope;
  workspaceId: string | null;
  tabId: string | null;
  tabName: string | null;
  /** True only for a per-tab token. An asserted session is a hint, never proof. */
  verified: boolean;
  /**
   * The global token. Every process of this user can read it, so it is labelled
   * `admin` and is never evidence of a human.
   */
  admin: boolean;
}

/** Read-only: never creates a layout, unlike `getLayout`. */
const findTabById = async (workspaceId: string, tabId: string): Promise<ITab | null> => {
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  return layout ? collectAllTabs(layout.root).find((t) => t.id === tabId) ?? null : null;
};

const sessionHeader = (req: NextApiRequest): string | null => {
  const value = req.headers['x-pmux-session'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * Who is calling (ADR-0010). A tab token names its tab outright. A workspace
 * token plus an `X-Pmux-Session` header naming a session of a tab IN THAT
 * WORKSPACE names the tab unverified — the fallback for tabs created before
 * tab tokens existed. A session of another workspace is ignored, not trusted.
 */
export const resolveCaller = async (req: NextApiRequest): Promise<ICaller | null> => {
  const scope = resolveCliScope(req);
  if (!scope) return null;
  if (scope.type === 'admin') {
    return { scope, workspaceId: null, tabId: null, tabName: null, verified: false, admin: true };
  }

  const base = { scope, workspaceId: scope.workspaceId, admin: false };
  if (scope.tabVerified && scope.tabId) {
    const tab = await findTabById(scope.workspaceId, scope.tabId).catch(() => null);
    return { ...base, tabId: scope.tabId, tabName: tab?.name || null, verified: true };
  }

  const session = sessionHeader(req);
  const tab = session ? await findTabBySessionName(session, scope.workspaceId).catch(() => null) : null;
  return { ...base, tabId: tab?.id ?? null, tabName: tab ? tab.name || null : null, verified: false };
};
