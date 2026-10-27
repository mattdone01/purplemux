import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { createLogger } from '@/lib/logger';
import {
  createGrantInState,
  GRANT_DEFAULT_HOURS,
  GRANT_MAX_HOURS,
  GRANT_REASON_MAX,
  GRANT_STORES,
  GrantError,
  grantsSnapshot,
  isActive,
  isGrantError,
  mutateGrants,
  newGrantId,
  OWNER_GRANT_WORKSPACES,
  reloadGrants,
  revokeForTabInState,
  revokeInState,
  sweepInState,
  type TGrantStore,
} from '@/lib/grant-store';
import type { IGrant, IGrantParty } from '@/types/grant';

// The human operations on grants (ADR-0014): the step-up password with its
// lockout, create and revoke, and the sweeps that end a grant with its tab or
// its expiry. Every change is one line in ~/.purplemux/audit/coordination.jsonl.

const log = createLogger('grants');

export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_LOCK_MS = 15 * 60 * 1000;
export const GRANT_SWEEP_MS = 60 * 1000;
/** At most one `owner-read` audit line per (grant, workspace) in this window (ADR-0029 §5). */
export const OWNER_READ_AUDIT_MS = 60 * 60 * 1000;

export interface IGrantDeps {
  now: () => number;
  /** The stored scrypt hash of the purplemux password, or null when none is set. */
  passwordHash: () => Promise<string | null>;
  verifyPassword: (plain: string, stored: string) => Promise<boolean>;
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  /** The tab is in that workspace's layout. */
  tabExists: (workspaceId: string, tabId: string) => Promise<boolean>;
  /** `launch` only for a tab token the server bound at session creation (ADR-0010). */
  tabIdentity: (workspaceId: string, tabId: string) => 'launch' | 'hook' | 'none';
  /** Resolves when written; the coordination append answers whether it was (`auditOwnerRead` reads that). */
  audit: (entry: Record<string, unknown>) => Promise<unknown>;
}

interface IStepUpState {
  failures: number[];
  lockedUntil: number;
}

const g = globalThis as unknown as {
  __ptGrantStepUp?: IStepUpState;
  __ptGrantStepUpLock?: Promise<void>;
  __ptGrantRuntime?: { timer: ReturnType<typeof setInterval> | null; unsubscribe: (() => void) | null };
  /** `<grantId> <workspaceId>` → when its last `owner-read` line was written. */
  __ptOwnerReadAudit?: Map<string, number>;
};
if (!g.__ptGrantStepUpLock) g.__ptGrantStepUpLock = Promise.resolve();

/** One password check at a time: a burst of guesses cannot all pass the lock check before any failure is counted. */
const withStepUpLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptGrantStepUpLock!;
  g.__ptGrantStepUpLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};
const stepUp = (): IStepUpState => {
  if (!g.__ptGrantStepUp) g.__ptGrantStepUp = { failures: [], lockedUntil: 0 };
  return g.__ptGrantStepUp;
};

/** Tests only. */
export const resetStepUp = (): void => {
  g.__ptGrantStepUp = { failures: [], lockedUntil: 0 };
};

/**
 * The step-up factor: the purplemux password, checked against its scrypt hash
 * (the one factor a same-uid process cannot recover from disk). 5 wrong
 * passwords in 10 min lock grant creation and revocation for 15 min.
 */
export const checkStepUp = (deps: IGrantDeps, subject: string, password: unknown, action: 'create'): Promise<void> =>
  withStepUpLock(() => checkStepUpLocked(deps, subject, password, action));

const checkStepUpLocked = async (deps: IGrantDeps, subject: string, password: unknown, action: 'create'): Promise<void> => {
  const state = stepUp();
  const now = deps.now();
  if (state.lockedUntil > now) {
    throw new GrantError('grant-locked', `grant changes are locked until ${new Date(state.lockedUntil).toISOString()} after ${STEP_UP_MAX_FAILURES} wrong passwords`);
  }
  const hash = await deps.passwordHash();
  const ok = typeof password === 'string' && password.length > 0 && hash !== null && await deps.verifyPassword(password, hash);
  if (ok) return;
  state.failures = [...state.failures.filter((t) => now - t < STEP_UP_WINDOW_MS), now];
  const locked = state.failures.length >= STEP_UP_MAX_FAILURES;
  if (locked) {
    state.lockedUntil = now + STEP_UP_LOCK_MS;
    state.failures = [];
  }
  await deps.audit({ event: 'grant-password-invalid', action, by: subject, locked });
  if (locked) await deps.audit({ event: 'grant-locked', until: state.lockedUntil });
  throw new GrantError('grant-password-invalid', 'the purplemux password is wrong or missing');
};

export interface ICreateGrantRequest {
  capability?: unknown;
  granteeWorkspaceId?: unknown;
  granteeTabId?: unknown;
  workspaces?: unknown;
  reason?: unknown;
  expiresInHours?: unknown;
  password?: unknown;
}

const invalid = (message: string) => new GrantError('grant-invalid', message);

const reasonOf = (body: ICreateGrantRequest): string => {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > GRANT_REASON_MAX) throw invalid(`reason is required, at most ${GRANT_REASON_MAX} characters`);
  return reason;
};

const hoursOf = (body: ICreateGrantRequest): number => {
  const hours = body.expiresInHours === undefined || body.expiresInHours === null ? GRANT_DEFAULT_HOURS : body.expiresInHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > GRANT_MAX_HOURS) {
    throw invalid(`expiresInHours must be more than 0 and at most ${GRANT_MAX_HOURS}`);
  }
  return hours;
};

const granteeOf = (body: ICreateGrantRequest): IGrantParty => {
  const { granteeWorkspaceId: ws, granteeTabId: tab } = body;
  if (typeof ws !== 'string' || !ws || typeof tab !== 'string' || !tab) throw invalid('granteeWorkspaceId and granteeTabId are required');
  return { workspaceId: ws, tabId: tab };
};

const requireLaunchGrantee = async (deps: IGrantDeps, { workspaceId: ws, tabId: tab }: IGrantParty): Promise<void> => {
  if (!(await deps.tabExists(ws, tab))) throw invalid(`no tab ${tab} in ${ws}`);
  const identity = deps.tabIdentity(ws, tab);
  if (identity !== 'launch') {
    throw new GrantError('grant-tab-unverified', `tab ${tab} has no launch identity (it is ${identity}); a grant needs a tab created after per-tab tokens — recreate the tab`);
  }
};

/** Audit, then end the grant if its tab closed between the check and the write (its close event found nothing to end). */
const settleCreated = async (deps: IGrantDeps, subject: string, grant: IGrant): Promise<IGrant> => {
  await deps.audit({
    event: 'grant-created', grantId: grant.id, capability: grant.capability, grantee: grant.grantee,
    workspaces: grant.workspaces, reason: grant.reason, expiresAt: grant.expiresAt, by: subject,
  });
  if (!(await deps.tabExists(grant.grantee.workspaceId, grant.grantee.tabId))) {
    await revokeForClosedTab(deps, grant.grantee);
    throw invalid(`tab ${grant.grantee.tabId} closed while the grant was being created`);
  }
  log.info({ grantId: grant.id, capability: grant.capability, grantee: grant.grantee, workspaces: grant.workspaces }, 'grant created');
  return grant;
};

const createDriveGrant = async (deps: IGrantDeps, subject: string, body: ICreateGrantRequest): Promise<IGrant> => {
  const grantee = granteeOf(body);
  if (!Array.isArray(body.workspaces) || body.workspaces.length === 0 || !body.workspaces.every((w) => typeof w === 'string' && w)) {
    throw invalid('workspaces must name at least one workspace');
  }
  const workspaces = [...new Set(body.workspaces as string[])];
  if (workspaces.includes('*')) throw invalid('"*" (every workspace) is valid only on an owner grant');
  if (workspaces.includes(grantee.workspaceId)) throw invalid('a tab can read its own workspace already; name only other workspaces');
  const reason = reasonOf(body);
  const hours = hoursOf(body);
  for (const id of [grantee.workspaceId, ...workspaces]) {
    if (!(await deps.workspaceExists(id))) throw invalid(`no workspace ${id}`);
  }
  await requireLaunchGrantee(deps, grantee);
  const now = deps.now();
  const grant = await mutateGrants((state) => {
    const created = createGrantInState(state, {
      granteeWorkspaceId: grantee.workspaceId, granteeTabId: grantee.tabId, workspaces, reason, expiresInHours: hours, createdBy: subject,
    }, now, newGrantId());
    return { state: created.state, value: created.grant };
  });
  return settleCreated(deps, subject, grant);
};

/**
 * The owner grant (ADR-0029): one launch-verified tab reads every workspace and
 * sends notes as the owner. At most one is active at a time; the server sets
 * `workspaces: ['*']`, so a body that names any other list is refused.
 */
const createOwnerGrant = async (deps: IGrantDeps, subject: string, body: ICreateGrantRequest): Promise<IGrant> => {
  const grantee = granteeOf(body);
  if (body.workspaces !== undefined
    && !(Array.isArray(body.workspaces) && body.workspaces.length === 1 && body.workspaces[0] === '*')) {
    throw invalid('an owner grant reads every workspace; send no workspaces');
  }
  const reason = reasonOf(body);
  const hours = hoursOf(body);
  if (!(await deps.workspaceExists(grantee.workspaceId))) throw invalid(`no workspace ${grantee.workspaceId}`);
  await requireLaunchGrantee(deps, grantee);
  const now = deps.now();
  const grant = await mutateGrants((state) => {
    const active = state.grants.find((candidate) => candidate.capability === 'owner' && isActive(candidate, now));
    if (active) {
      throw new GrantError('grant-owner-active', `owner grant ${active.id} is active until ${new Date(active.expiresAt).toISOString()}; revoke it first`);
    }
    const created = createGrantInState(state, {
      granteeWorkspaceId: grantee.workspaceId, granteeTabId: grantee.tabId, workspaces: [...OWNER_GRANT_WORKSPACES],
      reason, expiresInHours: hours, createdBy: subject, capability: 'owner',
    }, now, newGrantId());
    return { state: created.state, value: created.grant };
  }, 'owner');
  return settleCreated(deps, subject, grant);
};

export const createGrant = async (deps: IGrantDeps, subject: string, body: ICreateGrantRequest): Promise<IGrant> => {
  await checkStepUp(deps, subject, body.password, 'create');
  if (body.capability === 'owner') return createOwnerGrant(deps, subject, body);
  if (body.capability !== undefined && body.capability !== 'drive') throw invalid('capability must be drive or owner');
  return createDriveGrant(deps, subject, body);
};

/**
 * Run `fn` on every grant file. One refused file never stops the others (an
 * unreadable owner file refuses owner grants only); its error is rethrown last.
 */
const eachStore = async <T>(fn: (store: TGrantStore) => Promise<T[]>): Promise<T[]> => {
  const out: T[] = [];
  let failure: unknown = null;
  for (const store of GRANT_STORES) {
    try {
      out.push(...(await fn(store)));
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return out;
};

/**
 * Revoke needs the human session and this server's Origin, not the password
 * (review r1): it only takes power away, and a password check here would let a
 * grantee lock the human out of revoking (5 wrong guesses) or, exempt from the
 * lockout, become an unlimited guessing channel.
 */
export const revokeGrant = async (deps: IGrantDeps, subject: string, id: unknown): Promise<IGrant> => {
  if (typeof id !== 'string' || !/^g-[A-Za-z0-9_-]{4,32}$/.test(id)) throw new GrantError('grant-not-found', `no grant ${String(id)}`);
  const now = deps.now();
  let refused: unknown = null;
  for (const store of GRANT_STORES) {
    let found: { grant: IGrant; changed: boolean } | null;
    try {
      found = await mutateGrants<{ grant: IGrant; changed: boolean } | null>((state) => {
        const match = state.grants.find((candidate) => candidate.id === id);
        if (!match) return { state, value: null };
        if (match.revokedAt !== null) return { state, value: { grant: match, changed: false } };
        const r = revokeInState(state, id, subject, 'revoked', now);
        return { state: r.state, value: { grant: r.grant!, changed: true } };
      }, store);
    } catch (err) {
      if (!isGrantError(err) || err.code !== 'grant-store-unreadable') throw err;
      refused ??= err;
      continue;
    }
    if (!found) continue;
    if (found.changed) await deps.audit({ event: 'grant-revoked', grantId: id, reason: 'revoked', by: subject });
    return found.grant;
  }
  // Not in any readable file: with a refused file the grant may be there, so the answer is unknown.
  throw refused ?? new GrantError('grant-not-found', `no grant ${id}`);
};

/** A request that passed the drive check only because of a grant (ADR-0014: audited on every use). */
export const auditGrantUse = (grant: IGrant, use: { route: string; targetWorkspaceId: string; targetTabId: string | null }): Promise<boolean> =>
  appendCoordinationAudit({
    event: 'grant-used',
    grantId: grant.id,
    grantee: grant.grantee,
    route: use.route,
    targetWorkspaceId: use.targetWorkspaceId,
    targetTabId: use.targetTabId,
  });

/**
 * A read of another workspace admitted only by an owner grant. Audited at most
 * once per (grant, workspace) per hour, not per call; a failed write (the append
 * answers false) is retried on the next read and never refuses the read itself.
 */
export const auditOwnerRead = async (
  grant: IGrant,
  workspaceId: string,
  now: number = Date.now(),
  audit: (entry: Record<string, unknown>) => Promise<boolean> = appendCoordinationAudit,
): Promise<void> => {
  if (!g.__ptOwnerReadAudit) g.__ptOwnerReadAudit = new Map();
  const seen = g.__ptOwnerReadAudit;
  const key = `${grant.id} ${workspaceId}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < OWNER_READ_AUDIT_MS) return;
  for (const [k, at] of seen) if (now - at >= OWNER_READ_AUDIT_MS) seen.delete(k);
  seen.set(key, now);
  let written: boolean;
  try {
    written = await audit({ event: 'owner-read', grantId: grant.id, grantee: grant.grantee, workspaceId });
  } catch (err) {
    log.warn(`owner-read audit failed: ${err instanceof Error ? err.message : err}`);
    written = false;
  }
  if (written === false && seen.get(key) === now) seen.delete(key);
};

/** Tests only. */
export const resetOwnerReadAudit = (): void => {
  g.__ptOwnerReadAudit = new Map();
};

/** End the grants of a closed tab; audit each. */
export const revokeForClosedTab = async (deps: Pick<IGrantDeps, 'now' | 'audit'>, tab: { workspaceId: string; tabId: string }): Promise<IGrant[]> => {
  const now = deps.now();
  return eachStore(async (store) => {
    const revoked = await mutateGrants((state) => {
      const r = revokeForTabInState(state, tab, now);
      return { state: r.state, value: r.revoked };
    }, store);
    for (const grant of revoked) await deps.audit({ event: 'grant-revoked', grantId: grant.id, reason: 'grantee-tab-closed', by: 'system' });
    return revoked;
  });
};

/** Note expiries once (audit) and prune long-ended grants. */
export const sweepGrants = async (deps: Pick<IGrantDeps, 'now' | 'audit'>): Promise<IGrant[]> => {
  const now = deps.now();
  return eachStore(async (store) => {
    const expired = await mutateGrants((state) => {
      const r = sweepInState(state, now);
      return { state: r.state, value: r.expired };
    }, store);
    for (const grant of expired) await deps.audit({ event: 'grant-expired', grantId: grant.id, grantee: grant.grantee, expiresAt: grant.expiresAt });
    return expired;
  });
};

// ─── the server's runtime ─────────────────────────────────────────────────

/**
 * Boot: reload the file, end the grants whose grantee tab is gone (a tab that
 * closed while the server was down), sweep expiries, then follow tab closes and
 * sweep every minute. A workspace whose layout cannot be read keeps its grants
 * (unknown, not gone); the grantee's tab token dies with the tab anyway.
 */
export const startGrants = async (): Promise<void> => {
  if (g.__ptGrantRuntime) return;
  const runtime: { timer: ReturnType<typeof setInterval> | null; unsubscribe: (() => void) | null } = { timer: null, unsubscribe: null };
  g.__ptGrantRuntime = runtime;
  reloadGrants();
  const deps = { now: () => Date.now(), audit: appendCoordinationAudit };
  const { onTabClosed, readLiveTabs } = await import('@/lib/tab-lifecycle');
  let gone: IGrantParty[] = [];
  try {
    const snapshot = await readLiveTabs();
    const live = new Set(snapshot.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
    const keys = new Set<string>();
    for (const grant of GRANT_STORES.flatMap((store) => grantsSnapshot(store).grants)) {
      const key = `${grant.grantee.workspaceId}/${grant.grantee.tabId}`;
      if (grant.revokedAt !== null || snapshot.uncertainWorkspaceIds.has(grant.grantee.workspaceId) || live.has(key) || keys.has(key)) continue;
      keys.add(key);
      gone.push(grant.grantee);
    }
  } catch (err) {
    gone = [];
    log.warn(`grant boot sweep could not read the live tabs: ${err instanceof Error ? err.message : err}`);
  }
  // Each grantee and the expiry sweep on their own: `eachStore` revokes in the readable file before it
  // rethrows a refused one, so one refused file never stops the other file's sweep (ADR-0029 §1).
  for (const grantee of gone) {
    try {
      await revokeForClosedTab(deps, grantee);
    } catch (err) {
      log.warn(`grant boot sweep for ${grantee.workspaceId}/${grantee.tabId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  try {
    await sweepGrants(deps);
  } catch (err) {
    log.warn(`grant boot expiry sweep: ${err instanceof Error ? err.message : err}`);
  }
  runtime.unsubscribe = onTabClosed((event) => {
    revokeForClosedTab(deps, { workspaceId: event.workspaceId, tabId: event.tabId }).catch((err) => {
      log.warn(`grant revoke on tab close failed: ${err instanceof Error ? err.message : err}`);
    });
  });
  runtime.timer = setInterval(() => {
    sweepGrants(deps).catch((err) => log.warn(`grant sweep failed: ${err instanceof Error ? err.message : err}`));
  }, GRANT_SWEEP_MS);
  runtime.timer.unref?.();
};

export const stopGrants = (): void => {
  const runtime = g.__ptGrantRuntime;
  if (!runtime) return;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.unsubscribe?.();
  g.__ptGrantRuntime = undefined;
};
