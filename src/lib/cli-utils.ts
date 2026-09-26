import type { NextApiRequest, NextApiResponse } from 'next';
import { getLayout } from '@/lib/layout-store';
import { collectPanes, getFirstPaneId } from '@/lib/layout-tree';
import { getWorkspaceById } from '@/lib/workspace-store';
import { resolveCliScope, type TCliScope } from '@/lib/workspace-token';
import { getBrowserBridge, type IBrowserBridgeClient } from '@/lib/browser-bridge-client';
import type { ITab } from '@/types/terminal';
import { TAB_NOT_FOUND_BODY } from '@/lib/cli-error';
import { findActiveDriveGrant, grantsSnapshot } from '@/lib/grant-store';
import type { IGrant } from '@/types/grant';

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
export const canAccessWorkspace = async (scope: TCliScope, workspaceId: string): Promise<boolean> =>
  (await accessDecision(scope, workspaceId)).ok;

/**
 * The access answer and, when a grant was the ONLY reason, that grant (ADR-0014):
 * `authorizeWorkspace` audits or refuses a mutation made through it.
 */
export const accessDecision = async (scope: TCliScope, workspaceId: string): Promise<{ ok: boolean; grant: IGrant | null }> => {
  if (scope.type === 'admin') return { ok: true, grant: null };
  if (scope.workspaceId === workspaceId) return { ok: true, grant: null };
  const target = await getWorkspaceById(workspaceId);
  if (target?.allowedPeers?.includes(scope.workspaceId)) return { ok: true, grant: null };
  // A tab that may drive a workspace under a grant may also reach it through the read-gated routes.
  const grant = grantFor(scope, workspaceId);
  return grant ? { ok: true, grant } : { ok: false, grant: null };
};

/** The tab a request targets, for the grant-use audit: the route's `tabId`, or the body's (launch routes). */
const targetTabOf = (req: NextApiRequest): string | null => {
  if (typeof req.query?.tabId === 'string') return req.query.tabId;
  const body = req.body as { tabId?: unknown } | undefined;
  return body && typeof body === 'object' && typeof body.tabId === 'string' ? body.tabId : null;
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The active human grant that lets this caller drive `workspaceId` (ADR-0014):
 * only a VERIFIED tab (a launch-bound tab token), only over the named
 * workspaces, only until it expires, is revoked or its tab closes.
 */
const grantFor = (scope: TCliScope, workspaceId: string, now = Date.now()): IGrant | null =>
  scope.type === 'workspace' && scope.tabVerified === true && scope.tabId
    ? findActiveDriveGrant(grantsSnapshot(), { workspaceId: scope.workspaceId, tabId: scope.tabId }, workspaceId, now)
    : null;

/** The caller lives in `workspaceId` (no grant counts): Mission Control's producer events (ADR-0014). */
export const isOwnWorkspace = (scope: TCliScope, workspaceId: string): boolean =>
  scope.type === 'workspace' && scope.workspaceId === workspaceId;

/**
 * Whether `scope` may INJECT INPUT into a tab of `workspaceId`. A strictly
 * narrower question than {@link canAccessWorkspace}, which governs reads.
 *
 * Driving a tab means typing into somebody else's agent, so it is confined to
 * the workspace the caller itself lives in. Two crossings that reads allow are
 * refused here on purpose:
 *
 * - **The global token gets no bypass.** It is a file every process running as
 *   this user can read, so `admin` is not evidence of belonging to a workspace.
 *   Under it one epic's orchestrator can type into another epic's worker, and
 *   with several epics running at once that is indistinguishable from the
 *   worker's own operator talking to it.
 * - **`allowedPeers` does not carry.** A peer grant exists so a neighbouring
 *   workspace can READ. It has never meant "may take the keyboard", and
 *   silently widening it to input would make the grant far more dangerous than
 *   the thing it was added for.
 *
 * A human shell keeps working because `bin/cli.js` resolves the token for the
 * `-w` workspace before falling back to the global one; a tab keeps its own
 * `PMUX_TOKEN` and therefore stays confined.
 */
export const canDriveWorkspace = (scope: TCliScope, workspaceId: string): boolean =>
  driveDecision(scope, workspaceId).ok;

/** The drive answer and, when a grant was what allowed it, that grant (for the per-use audit). */
export const driveDecision = (scope: TCliScope, workspaceId: string, now = Date.now()): { ok: boolean; grant: IGrant | null } => {
  if (isOwnWorkspace(scope, workspaceId)) return { ok: true, grant: null };
  const grant = grantFor(scope, workspaceId, now);
  return grant ? { ok: true, grant } : { ok: false, grant: null };
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
  opts: { grant?: 'allow' | 'refuse' } = {},
): Promise<TCliScope | null> => {
  const scope = resolveCliScope(req);
  if (!scope) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  const access = await accessDecision(scope, workspaceId);
  if (access.ok && access.grant && !READ_METHODS.has(req.method ?? 'GET')) {
    // A mutation allowed ONLY by a drive grant (review r1): a workspace's settings stay its own (the
    // settings routes say so explicitly: a URL prefix could be dodged by an unnormalised path, review r2);
    // anything else on its tabs (close, create, browser) is a use of the grant, audited like input.
    const route = (req.url ?? '').split('?')[0];
    if (opts.grant === 'refuse') {
      res.status(403).json({
        error: `Grant ${access.grant.id} lets this tab drive ${workspaceId}'s tabs, not change its settings (${route}).`,
        code: 'forbidden',
      });
      return null;
    }
    const { auditGrantUse } = await import('@/lib/grant-service');
    await auditGrantUse(access.grant, { route, targetWorkspaceId: workspaceId, targetTabId: targetTabOf(req) });
  }
  if (!access.ok) {
    res.status(403).json({
      error: `Workspace ${workspaceId} is out of scope for this tab (scoped to ${
        scope.type === 'workspace' ? scope.workspaceId : 'admin'
      }). Ask the human to add it to that workspace's allowedPeers if cross-workspace access is intended.`,
      code: 'forbidden',
    });
    return null;
  }
  return scope;
};

/**
 * The {@link authorizeWorkspace} counterpart for the input-injecting routes
 * (`send`, `steer`). Same resolve-then-check shape, the stricter predicate.
 *
 * The denial names the fix rather than the rule, because the caller that trips
 * this is usually a human shell holding the global token, one export away from
 * being correct.
 */
export const authorizeWorkspaceInput = async (
  req: NextApiRequest,
  res: NextApiResponse,
  workspaceId: string,
): Promise<TCliScope | null> => {
  const scope = resolveCliScope(req);
  if (!scope) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  const decision = driveDecision(scope, workspaceId);
  if (decision.ok && decision.grant) {
    const { auditGrantUse } = await import('@/lib/grant-service');
    await auditGrantUse(decision.grant, { route: (req.url ?? '').split('?')[0], targetWorkspaceId: workspaceId, targetTabId: targetTabOf(req) });
  }
  if (!decision.ok) {
    const unverified = await unverifiedGrantHolder(req, scope, workspaceId);
    if (unverified) {
      res.status(403).json({
        error: `Grant ${unverified.grantId} lets tab ${unverified.tabId} drive ${workspaceId}, but this call is not from its launch identity `
          + `(identity: ${unverified.identity}). A grant needs a tab created after per-tab tokens: recreate the tab.`,
        code: 'grant-tab-unverified',
      });
      return null;
    }
    res.status(403).json({
      error:
        `Sending input to a tab in ${workspaceId} requires that workspace's own token (caller is ${
          scope.type === 'workspace' ? `scoped to ${scope.workspaceId}` : 'using the global token'
        }). Reads are unaffected. Set PMUX_TOKEN to the ${workspaceId} token (and unset PMUX_TAB_TOKEN, which takes precedence) to drive its tabs; ` +
        'allowedPeers deliberately does not grant input.',
      code: 'forbidden',
    });
    return null;
  }
  return scope;
};

/**
 * A caller that holds a grant but not a launch identity (a hook-time token, or
 * the session fallback of a tab created before per-tab tokens): its denial
 * names the grant and the fix (story 11 AC), not only "forbidden".
 */
const unverifiedGrantHolder = async (
  req: NextApiRequest,
  scope: TCliScope,
  workspaceId: string,
): Promise<{ grantId: string; tabId: string; identity: string } | null> => {
  if (scope.type !== 'workspace' || scope.tabVerified === true) return null;
  let tabId = scope.tabId ?? null;
  let identity = scope.tabIdentity ?? 'none';
  if (!tabId) {
    const { resolveCaller } = await import('@/lib/caller');
    const caller = await resolveCaller(req).catch(() => null);
    tabId = caller?.tabId ?? null;
    identity = caller?.identity ?? 'none';
  }
  if (!tabId) return null;
  const grant = findActiveDriveGrant(grantsSnapshot(), { workspaceId: scope.workspaceId, tabId }, workspaceId, Date.now());
  return grant ? { grantId: grant.id, tabId, identity } : null;
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
    res.status(404).json(TAB_NOT_FOUND_BODY);
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
