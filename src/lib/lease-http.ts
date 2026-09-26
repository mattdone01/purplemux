import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller, type ICaller } from '@/lib/caller';
import { LeasePolicyError } from '@/lib/lease-policy';
import {
  LeaseError,
  LeaseFileError,
  holderFromCaller,
  toLeaseView,
  type ILeaseAuthority,
  type IViewFacts,
} from '@/lib/lease-store';
import { getLeaseSweeper } from '@/lib/lease-sweeper';
import { readLiveTabs } from '@/lib/tab-lifecycle';
import { createLogger } from '@/lib/logger';
import type { ILease, ILeaseHolder, ILeaseView } from '@/types/lease';

const log = createLogger('lease-http');

export const leaseAuthority: ILeaseAuthority = {
  now: () => Date.now(),
  isWorkspaceOrchestrator: async (workspaceId, tabId) => {
    const { getWorkspaceById } = await import('@/lib/workspace-store');
    const orchestration = (await getWorkspaceById(workspaceId))?.orchestration;
    return !!orchestration?.enabled && orchestration.orchestratorTabId === tabId;
  },
};

/**
 * Facts for `holderState` and names. When the live-tab snapshot cannot be
 * read, every holder's workspace counts as uncertain, so no holder is shown
 * `closed` on a read error.
 */
export const viewFacts = async (leases: readonly ILease[]): Promise<IViewFacts> => {
  const now = Date.now();
  const { getWorkspaces } = await import('@/lib/workspace-store');
  const [snapshot, { workspaces }] = await Promise.all([
    readLiveTabs().catch((err) => {
      log.warn(`live tabs unreadable for a lease view: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
    getWorkspaces(),
  ]);
  const names = new Map(workspaces.map((ws) => [ws.id, ws.name]));
  const sweeper = getLeaseSweeper();
  return {
    now,
    liveTabIds: new Set(snapshot?.tabs.map((t) => t.tabId) ?? []),
    uncertainWorkspaceIds: snapshot
      ? snapshot.uncertainWorkspaceIds
      : new Set(leases.map((l) => l.holder.workspaceId).filter((id): id is string => !!id)),
    agentInactive: (tabId) => sweeper.isAgentInactive(tabId),
    workspaceName: (id) => names.get(id) ?? null,
  };
};

export const viewsOf = async (leases: readonly ILease[]): Promise<ILeaseView[]> => {
  const facts = await viewFacts(leases);
  return leases.map((l) => toLeaseView(l, facts));
};

export const viewOf = async (lease: ILease): Promise<ILeaseView> => (await viewsOf([lease]))[0];

/** Any valid CLI scope, or a 403 with a machine code; null means the response is written. */
export const requireCaller = async (req: NextApiRequest, res: NextApiResponse): Promise<ICaller | null> => {
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  return caller;
};

export const holderOf = (caller: ICaller): ILeaseHolder => holderFromCaller(caller);

export const requireMethod = (req: NextApiRequest, res: NextApiResponse, method: 'GET' | 'POST'): boolean => {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  res.status(405).json({ error: 'Method not allowed' });
  return false;
};

const STATUS: Record<string, number> = {
  'lease-policy': 400,
  'lease-held': 409,
  'lease-held-by-other': 409,
  'lease-not-found': 404,
  'caller-unresolved': 403,
  forbidden: 403,
};

/** Every lease refusal carries `code`, which the CLI maps to its exit (ADR-0016). */
export const sendLeaseError = async (res: NextApiResponse, err: unknown): Promise<void> => {
  if (err instanceof LeasePolicyError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof LeaseError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.lease) {
      const view = await viewOf(err.lease).catch(() => null);
      body.lease = view;
      body.holder = view?.holder ?? err.lease.holder;
    }
    res.status(STATUS[err.code] ?? 500).json(body);
    return;
  }
  if (err instanceof LeaseFileError) {
    // Fail closed: an unreadable store answers no question about who holds what.
    res.status(500).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`lease route failed: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'lease operation failed', code: 'lease-internal' });
};

export const bodyOf = (req: NextApiRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};

/** `ttlSeconds` is optional, a whole number, or null (no expiry). */
export const ttlOf = (body: Record<string, unknown>): number | null | undefined => {
  if (!('ttlSeconds' in body) || body.ttlSeconds === undefined) return undefined;
  const ttl = body.ttlSeconds;
  if (ttl === null || typeof ttl === 'number') return ttl;
  throw new LeasePolicyError('ttlSeconds must be a number or null');
};
