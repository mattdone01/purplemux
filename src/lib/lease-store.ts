import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { LeasePolicyError, parseLeaseName, policyFor, resolveEpic, resolveNote, resolveTtl } from '@/lib/lease-policy';
import type { ICaller } from '@/lib/caller';
import type {
  ILease,
  ILeaseHolder,
  ILeaseState,
  ILeaseView,
  THolderState,
  TLeaseErrorCode,
  TLeaseReleaseReason,
} from '@/types/lease';

const log = createLogger('lease-store');

export class LeaseError extends Error {
  constructor(
    readonly code: TLeaseErrorCode,
    message: string,
    readonly lease: ILease | null = null,
  ) {
    super(message);
  }
}

export interface IReleasedLease {
  lease: ILease;
  reason: TLeaseReleaseReason;
}

// ─── pure state transitions ──────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

export const sameHolder = (a: ILeaseHolder, b: ILeaseHolder): boolean => {
  if (a.admin || b.admin) return a.admin && b.admin;
  return a.tabId !== null && a.tabId === b.tabId && a.workspaceId === b.workspaceId;
};

export const holderLabel = (h: ILeaseHolder): string =>
  h.admin ? 'admin' : `${h.workspaceId ?? '?'}/${h.tabId ?? 'no-tab'}${h.tabName ? ` (${h.tabName})` : ''}${h.verified ? '' : ' unverified'}`;

const ageLabel = (lease: ILease, now: number): string => {
  const s = Math.max(0, Math.round((now - Date.parse(lease.acquiredAt)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
};

const heldError = (lease: ILease, now: number): LeaseError =>
  new LeaseError('lease-held', `${lease.name} is held by ${holderLabel(lease.holder)} for ${ageLabel(lease, now)}`, lease);

export interface IAcquireRequest {
  name: string;
  kind: string;
  resource: string;
  holder: ILeaseHolder;
  ttlSeconds: number | null;
  epic: string | null;
  note: string | null;
}

const expiryOf = (ttlSeconds: number | null, now: number): string | null =>
  ttlSeconds === null ? null : iso(now + ttlSeconds * 1000);

export const acquireInState = (
  state: ILeaseState,
  req: IAcquireRequest,
  now: number,
): { state: ILeaseState; lease: ILease; outcome: 'acquired' | 'renewed' } => {
  const existing = state.leases.find((l) => l.name === req.name);
  if (existing) {
    if (!sameHolder(existing.holder, req.holder)) throw heldError(existing, now);
    const lease: ILease = {
      ...existing,
      holder: { ...existing.holder, tabName: req.holder.tabName ?? existing.holder.tabName, verified: existing.holder.verified || req.holder.verified },
      epic: req.epic ?? existing.epic,
      note: req.note ?? existing.note,
      renewedAt: iso(now),
      ttlSeconds: req.ttlSeconds,
      expiresAt: expiryOf(req.ttlSeconds, now),
    };
    return { state: { leases: state.leases.map((l) => (l === existing ? lease : l)) }, lease, outcome: 'renewed' };
  }
  const lease: ILease = {
    name: req.name,
    kind: req.kind,
    resource: req.resource,
    holder: req.holder,
    epic: req.epic,
    note: req.note,
    acquiredAt: iso(now),
    renewedAt: iso(now),
    ttlSeconds: req.ttlSeconds,
    expiresAt: expiryOf(req.ttlSeconds, now),
    survivesTab: policyFor(req.kind).survivesTab,
  };
  return { state: { leases: [...state.leases, lease] }, lease, outcome: 'acquired' };
};

const findHeld = (state: ILeaseState, name: string, holder: ILeaseHolder, now: number): ILease => {
  const lease = state.leases.find((l) => l.name === name);
  if (!lease) throw new LeaseError('lease-not-found', `no lease named ${name}`);
  if (!sameHolder(lease.holder, holder)) {
    throw new LeaseError('lease-held-by-other', `${name} is held by ${holderLabel(lease.holder)} for ${ageLabel(lease, now)}`, lease);
  }
  return lease;
};

/** `ttlSeconds` undefined keeps the lease's own TTL. */
export const renewInState = (
  state: ILeaseState,
  name: string,
  holder: ILeaseHolder,
  ttlSeconds: number | null,
  now: number,
): { state: ILeaseState; lease: ILease } => {
  const existing = findHeld(state, name, holder, now);
  const lease: ILease = { ...existing, renewedAt: iso(now), ttlSeconds, expiresAt: expiryOf(ttlSeconds, now) };
  return { state: { leases: state.leases.map((l) => (l === existing ? lease : l)) }, lease };
};

export const releaseInState = (
  state: ILeaseState,
  name: string,
  holder: ILeaseHolder,
  now: number,
): { state: ILeaseState; lease: ILease } => {
  const lease = findHeld(state, name, holder, now);
  return { state: { leases: state.leases.filter((l) => l !== lease) }, lease };
};

export const removeInState = (state: ILeaseState, name: string): { state: ILeaseState; lease: ILease } => {
  const lease = state.leases.find((l) => l.name === name);
  if (!lease) throw new LeaseError('lease-not-found', `no lease named ${name}`);
  return { state: { leases: state.leases.filter((l) => l !== lease) }, lease };
};

/** The survives-tab claims of an epic (optionally one kind). */
export const epicClaims = (state: ILeaseState, epic: string, kind?: string): ILease[] =>
  state.leases.filter((l) => l.survivesTab && l.epic === epic && (!kind || l.kind === kind));

export interface ISweepFacts {
  now: number;
  liveTabIds: ReadonlySet<string>;
  /** True when the holder tab's agent has been inactive past the grace. */
  agentGone: (tabId: string) => boolean;
}

/**
 * Pure: which leases a sweep ends. Expiry applies to every lease. Only a
 * tab-bound lease with a holder tab dies with the tab or its agent; a
 * survives-tab lease and an admin lease end only by TTL or release.
 */
export const sweepState = (state: ILeaseState, facts: ISweepFacts): { state: ILeaseState; released: IReleasedLease[] } => {
  const released: IReleasedLease[] = [];
  const kept: ILease[] = [];
  for (const lease of state.leases) {
    const tabId = lease.holder.tabId;
    let reason: TLeaseReleaseReason | null = null;
    if (lease.expiresAt !== null && Date.parse(lease.expiresAt) <= facts.now) reason = 'expired';
    else if (!lease.survivesTab && tabId && !lease.holder.admin) {
      if (!facts.liveTabIds.has(tabId)) reason = 'holder-tab-gone';
      else if (facts.agentGone(tabId)) reason = 'holder-agent-gone';
    }
    if (reason) released.push({ lease, reason });
    else kept.push(lease);
  }
  return { state: { leases: kept }, released };
};

export const releaseTabInState = (state: ILeaseState, tabId: string): { state: ILeaseState; released: ILease[] } => {
  const released = state.leases.filter((l) => !l.survivesTab && !l.holder.admin && l.holder.tabId === tabId);
  return { state: { leases: state.leases.filter((l) => !released.includes(l)) }, released };
};

export interface IViewFacts {
  now: number;
  liveTabIds: ReadonlySet<string>;
  /** Currently inactive agent (no grace): what a reader should see now. */
  agentInactive: (tabId: string) => boolean;
  workspaceName: (workspaceId: string) => string | null;
}

export const holderStateOf = (lease: ILease, facts: IViewFacts): THolderState => {
  if (lease.holder.admin) return 'admin';
  const tabId = lease.holder.tabId;
  if (!tabId) return 'live';
  if (!facts.liveTabIds.has(tabId)) return 'closed';
  return facts.agentInactive(tabId) ? 'agent-gone' : 'live';
};

export const toLeaseView = (lease: ILease, facts: IViewFacts): ILeaseView => ({
  ...lease,
  holder: { ...lease.holder, workspaceName: lease.holder.workspaceId ? facts.workspaceName(lease.holder.workspaceId) : null },
  ageSeconds: Math.max(0, Math.floor((facts.now - Date.parse(lease.acquiredAt)) / 1000)),
  expiresInSeconds: lease.expiresAt === null ? null : Math.max(0, Math.floor((Date.parse(lease.expiresAt) - facts.now) / 1000)),
  holderState: holderStateOf(lease, facts),
});

// ─── file store ──────────────────────────────────────────────────────────

const g = globalThis as unknown as {
  __ptLeaseLock?: Promise<void>;
  __ptLeaseListeners?: { acquired: Set<TLeaseAcquiredListener>; released: Set<TLeaseReleasedListener> };
};
if (!g.__ptLeaseLock) g.__ptLeaseLock = Promise.resolve();
if (!g.__ptLeaseListeners) g.__ptLeaseListeners = { acquired: new Set(), released: new Set() };

export const leasesFile = (): string => path.join(os.homedir(), '.purplemux', 'leases.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptLeaseLock!;
  g.__ptLeaseLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isLease = (value: unknown): value is ILease => {
  if (!value || typeof value !== 'object') return false;
  const l = value as Record<string, unknown>;
  return typeof l.name === 'string' && typeof l.kind === 'string' && typeof l.acquiredAt === 'string'
    && !!l.holder && typeof l.holder === 'object';
};

/**
 * Absent file = no leases. An unparseable file is refused rather than read as
 * empty: an empty read would hand every held resource to the next caller.
 */
export const readLeaseState = async (): Promise<ILeaseState> => {
  let raw: string;
  try {
    raw = await fs.readFile(leasesFile(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { leases: [] };
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<ILeaseState>;
  return { leases: Array.isArray(parsed.leases) ? parsed.leases.filter(isLease) : [] };
};

const writeLeaseState = async (state: ILeaseState): Promise<void> => {
  const file = leasesFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Serialised read-modify-write. `fn` returns null to leave the file untouched. */
const mutate = <T>(fn: (state: ILeaseState) => { state: ILeaseState; value: T } | null): Promise<T | null> =>
  withLock(async () => {
    const result = fn(await readLeaseState());
    if (!result) return null;
    await writeLeaseState(result.state);
    return result.value;
  });

// ─── hooks ───────────────────────────────────────────────────────────────

export type TLeaseAcquiredListener = (lease: ILease, outcome: 'acquired' | 'renewed') => void;
export type TLeaseReleasedListener = (lease: ILease, reason: TLeaseReleaseReason) => void;

export const onLeaseAcquired = (listener: TLeaseAcquiredListener): (() => void) => {
  g.__ptLeaseListeners!.acquired.add(listener);
  return () => { g.__ptLeaseListeners!.acquired.delete(listener); };
};

export const onLeaseReleased = (listener: TLeaseReleasedListener): (() => void) => {
  g.__ptLeaseListeners!.released.add(listener);
  return () => { g.__ptLeaseListeners!.released.delete(listener); };
};

const notify = <A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void => {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (err) {
      log.warn(`lease listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }
};

const auditHolder = (h: ILeaseHolder) => ({ workspaceId: h.workspaceId, tabId: h.tabId, verified: h.verified, admin: h.admin });

const recordReleased = async (released: IReleasedLease[], by: ILeaseHolder | null, extra: Record<string, unknown> = {}): Promise<void> => {
  for (const { lease, reason } of released) {
    await appendCoordinationAudit({
      event: 'lease-release', name: lease.name, reason, holder: auditHolder(lease.holder), by: by ? auditHolder(by) : null, ...extra,
    });
    notify(g.__ptLeaseListeners!.released, lease, reason);
  }
};

// ─── operations ──────────────────────────────────────────────────────────

export interface ILeaseAuthority {
  now: () => number;
  /** The workspace's orchestration is enabled and names this tab. */
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>;
}

export const holderFromCaller = (caller: ICaller): ILeaseHolder => ({
  workspaceId: caller.admin ? null : caller.workspaceId,
  tabId: caller.admin ? null : caller.tabId,
  tabName: caller.admin ? null : caller.tabName,
  verified: caller.admin ? false : caller.verified,
  admin: caller.admin,
});

export interface IAcquireInput {
  name: unknown;
  ttlSeconds?: number | null;
  epic?: unknown;
  note?: unknown;
}

export const acquireLease = async (
  input: IAcquireInput,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
): Promise<{ lease: ILease; outcome: 'acquired' | 'renewed' }> => {
  const { name, kind, resource } = parseLeaseName(input.name);
  const ttlSeconds = resolveTtl(kind, input.ttlSeconds, holder);
  const epic = resolveEpic(kind, input.epic);
  const note = resolveNote(input.note);
  if (policyFor(kind).orchestratorOnly && !holder.admin) {
    const allowed = holder.tabId && holder.workspaceId
      ? await authority.isWorkspaceOrchestrator(holder.workspaceId, holder.tabId)
      : false;
    if (!allowed) throw new LeasePolicyError(`${kind} leases need the admin token or the workspace's enabled orchestrator tab`);
  }
  const result = await mutate((state) => {
    const r = acquireInState(state, { name, kind, resource, holder, ttlSeconds, epic, note }, authority.now());
    return { state: r.state, value: r };
  });
  const { lease, outcome } = result!;
  await appendCoordinationAudit({ event: outcome === 'acquired' ? 'lease-acquire' : 'lease-renew', name, holder: auditHolder(holder), ttlSeconds, epic });
  notify(g.__ptLeaseListeners!.acquired, lease, outcome);
  return { lease, outcome };
};

export const renewLease = async (
  rawName: unknown,
  ttlSeconds: number | null | undefined,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
): Promise<ILease> => {
  const { name, kind } = parseLeaseName(rawName);
  const lease = await mutate((state) => {
    const existing = findHeld(state, name, holder, authority.now());
    const ttl = ttlSeconds === undefined ? existing.ttlSeconds : resolveTtl(kind, ttlSeconds, holder);
    const r = renewInState(state, name, holder, ttl, authority.now());
    return { state: r.state, value: r.lease };
  });
  await appendCoordinationAudit({ event: 'lease-renew', name, holder: auditHolder(holder), ttlSeconds: lease!.ttlSeconds });
  notify(g.__ptLeaseListeners!.acquired, lease!, 'renewed');
  return lease!;
};

export const releaseLease = async (rawName: unknown, holder: ILeaseHolder, authority: ILeaseAuthority): Promise<ILease> => {
  const { name } = parseLeaseName(rawName);
  const lease = await mutate((state) => {
    const r = releaseInState(state, name, holder, authority.now());
    return { state: r.state, value: r.lease };
  });
  await recordReleased([{ lease: lease!, reason: 'released' }], holder);
  return lease!;
};

/** Admin only, with a reason. Cooperative: the admin token is readable by every agent (C-312 class). */
export const breakLease = async (rawName: unknown, reason: unknown, holder: ILeaseHolder): Promise<ILease> => {
  if (!holder.admin) throw new LeaseError('forbidden', 'breaking a lease needs the admin token');
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw new LeasePolicyError('break needs a reason');
  const { name } = parseLeaseName(rawName);
  const lease = await mutate((state) => {
    const r = removeInState(state, name);
    return { state: r.state, value: r.lease };
  });
  await recordReleased([{ lease: lease!, reason: 'broken' }], holder, { breakReason: text.slice(0, 500) });
  return lease!;
};

/**
 * Release an epic's survives-tab claims. Allowed to the holder of
 * `epic:<slug>`, to any tab of a workspace that holds one of the claims, or to
 * admin.
 */
export const releaseEpicClaims = async (rawEpic: unknown, holder: ILeaseHolder, kind?: string): Promise<ILease[]> => {
  const epic = resolveEpic('epic', rawEpic);
  if (!epic) throw new LeasePolicyError('release-epic needs an epic slug');
  const released = await mutate((state) => {
    const claims = epicClaims(state, epic, kind);
    const owner = state.leases.find((l) => l.name === `epic:${epic}`);
    const allowed = holder.admin
      || (owner && sameHolder(owner.holder, holder))
      || (holder.workspaceId !== null && claims.some((c) => c.holder.workspaceId === holder.workspaceId));
    if (!allowed) {
      throw new LeaseError('forbidden', `release-epic ${epic} needs the epic:${epic} holder, a tab of a workspace holding its claims, or the admin token`);
    }
    if (claims.length === 0) return { state, value: [] as ILease[] };
    return { state: { leases: state.leases.filter((l) => !claims.includes(l)) }, value: claims };
  });
  await recordReleased(released!.map((lease) => ({ lease, reason: 'release-epic' as const })), holder, { epic });
  return released!;
};

export const listLeases = async (prefix?: string): Promise<ILease[]> => {
  const { leases } = await readLeaseState();
  const p = prefix?.trim().toLowerCase();
  return (p ? leases.filter((l) => l.name.startsWith(p)) : leases).sort((a, b) => a.name.localeCompare(b.name));
};

/** Exact name only: a prefix match would also answer for `merge:x/y-z`. */
export const findLease = async (rawName: unknown): Promise<ILease | null> => {
  const { name } = parseLeaseName(rawName);
  const { leases } = await readLeaseState();
  return leases.find((l) => l.name === name) ?? null;
};

export const releaseTabLeases = async (tabId: string, reason: TLeaseReleaseReason): Promise<ILease[]> => {
  const released = await mutate((state) => {
    const r = releaseTabInState(state, tabId);
    return r.released.length ? { state: r.state, value: r.released } : null;
  });
  if (released) await recordReleased(released.map((lease) => ({ lease, reason })), null);
  return released ?? [];
};

export const sweepLeases = async (facts: ISweepFacts): Promise<IReleasedLease[]> => {
  const released = await mutate((state) => {
    const r = sweepState(state, facts);
    return r.released.length ? { state: r.state, value: r.released } : null;
  });
  if (released) await recordReleased(released, null, { sweep: true });
  return released ?? [];
};
