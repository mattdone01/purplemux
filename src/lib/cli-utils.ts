import type { NextApiRequest, NextApiResponse } from 'next';
import { getLayout } from '@/lib/layout-store';
import { collectPanes, getFirstPaneId } from '@/lib/layout-tree';
import { getWorkspaceById } from '@/lib/workspace-store';
import { resolveCliScope, type TCliScope } from '@/lib/workspace-token';
import { getBrowserBridge, type IBrowserBridgeClient } from '@/lib/browser-bridge-client';
import type { ITab } from '@/types/terminal';

export interface ITabLocation {
  workspaceId: string;
  paneId: string;
  tab: ITab;
}

/**
 * Whether `scope` may act on `workspaceId`. Default-deny for workspace-scoped
 * callers: an agent reaches its own workspace, plus any workspace that has named
 * it in `allowedPeers`. The global token stays unrestricted so the UI and the
 * user's own shell are unaffected.
 */
export const canAccessWorkspace = async (scope: TCliScope, workspaceId: string): Promise<boolean> => {
  if (scope.type === 'admin') return true;
  if (scope.workspaceId === workspaceId) return true;
  const target = await getWorkspaceById(workspaceId);
  return target?.allowedPeers?.includes(scope.workspaceId) ?? false;
};

/**
 * Resolve the caller and confirm it may act on `workspaceId`, writing the
 * response and returning null when it may not. A denial is a 403 naming the
 * caller's own workspace — a confused orchestrator should learn it reached out
 * of bounds, not that the target does not exist.
 */
export const authorizeWorkspace = async (
  req: NextApiRequest,
  res: NextApiResponse,
  workspaceId: string,
): Promise<TCliScope | null> => {
  const scope = resolveCliScope(req);
  if (!scope) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  if (!(await canAccessWorkspace(scope, workspaceId))) {
    res.status(403).json({
      error: `Workspace ${workspaceId} is out of scope for this tab (scoped to ${
        scope.type === 'workspace' ? scope.workspaceId : 'admin'
      }). Ask the human to add it to that workspace's allowedPeers if cross-workspace access is intended.`,
    });
    return null;
  }
  return scope;
};

export const findTab = async (
  workspaceId: string,
  tabId: string,
): Promise<ITabLocation | null> => {
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return null;
  const layout = await getLayout(workspaceId);
  for (const pane of collectPanes(layout.root)) {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) return { workspaceId, paneId: pane.id, tab };
  }
  return null;
};

export const resolveFirstPaneId = async (workspaceId: string): Promise<string | null> => {
  const layout = await getLayout(workspaceId);
  const paneId = getFirstPaneId(layout.root);
  return paneId || null;
};

interface IBrowserTabContext {
  tabId: string;
  bridge: IBrowserBridgeClient;
}

export const withBrowserTab = async (
  req: NextApiRequest,
  res: NextApiResponse,
  method: 'GET' | 'POST',
  handler: (ctx: IBrowserTabContext) => Promise<void> | void,
): Promise<void> => {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    res.status(400).json({ error: 'workspaceId is required' });
    return;
  }
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const found = await findTab(workspaceId, tabId);
  if (!found) {
    res.status(404).json({ error: 'Tab not found' });
    return;
  }
  if (found.tab.panelType !== 'web-browser') {
    res.status(400).json({ error: 'Tab is not a web-browser panel' });
    return;
  }
  const bridge = getBrowserBridge();
  if (!bridge) {
    res.status(503).json({ error: 'Browser bridge unavailable (Electron-only feature)' });
    return;
  }
  await handler({ tabId, bridge });
};
