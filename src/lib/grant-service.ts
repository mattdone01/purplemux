import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { createLogger } from '@/lib/logger';
import {
  createGrantInState,
  GRANT_DEFAULT_HOURS,
  GRANT_MAX_HOURS,
  GRANT_REASON_MAX,
  GrantError,
  grantsSnapshot,
  mutateGrants,
  newGrantId,
  reloadGrants,
  revokeForTabInState,
  revokeInState,
  sweepInState,
} from '@/lib/grant-store';
import type { IGrant } from '@/types/grant';

// The human operations on grants (ADR-0014): the step-up password with its
// lockout, create and revoke, and the sweeps that end a grant with its tab or
// its expiry. Every change is one line in ~/.purplemux/audit/coordination.jsonl.

const log = createLogger('grants');

export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_LOCK_MS = 15 * 60 * 1000;
export const GRANT_SWEEP_MS = 60 * 1000;

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
  audit: (entry: Record<string, unknown>) => Promise<void>;
}

interface IStepUpState {
  failures: number[];
  lockedUntil: number;
}

const g = globalThis as unknown as {
  __ptGrantStepUp?: IStepUpState;
  __ptGrantStepUpLock?: Promise<void>;
  __ptGrantRuntime?: { timer: ReturnType<typeof setInterval> | null; unsubscribe: (() => void) | null };
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
  granteeWorkspaceId?: unknown;
  granteeTabId?: unknown;
  workspaces?: unknown;
  reason?: unknown;
  expiresInHours?: unknown;
  password?: unknown;
}

const invalid = (message: string) => new GrantError('grant-invalid', message);

export const createGrant = async (deps: IGrantDeps, subject: string, body: ICreateGrantRequest): Promise<IGrant> => {
  await checkStepUp(deps, subject, body.password, 'create');
  const { granteeWorkspaceId: ws, granteeTabId: tab } = body;
  if (typeof ws !== 'string' || !ws || typeof tab !== 'string' || !tab) throw invalid('granteeWorkspaceId and granteeTabId are required');
  if (!Array.isArray(body.workspaces) || body.workspaces.length === 0 || !body.workspaces.every((w) => typeof w === 'string' && w)) {
    throw invalid('workspaces must name at least one workspace');
  }
  const workspaces = [...new Set(body.workspaces as string[])];
  if (workspaces.includes(ws)) throw invalid('a tab can read its own workspace already; name only other workspaces');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > GRANT_REASON_MAX) throw invalid(`reason is required, at most ${GRANT_REASON_MAX} characters`);
  const hours = body.expiresInHours === undefined || body.expiresInHours === null ? GRANT_DEFAULT_HOURS : body.expiresInHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > GRANT_MAX_HOURS) {
    throw invalid(`expiresInHours must be more than 0 and at most ${GRANT_MAX_HOURS}`);
  }
  for (const id of [ws, ...workspaces]) {
    if (!(await deps.workspaceExists(id))) throw invalid(`no workspace ${id}`);
  }
  if (!(await deps.tabExists(ws, tab))) throw invalid(`no tab ${tab} in ${ws}`);
  const identity = deps.tabIdentity(ws, tab);
  if (identity !== 'launch') {
    throw new GrantError('grant-tab-unverified', `tab ${tab} has no launch identity (it is ${identity}); a grant needs a tab created after per-tab tokens — recreate the tab`);
  }
  const now = deps.now();
  const grant = await mutateGrants((state) => {
    const created = createGrantInState(state, {
      granteeWorkspaceId: ws, granteeTabId: tab, workspaces, reason, expiresInHours: hours, createdBy: subject,
    }, now, newGrantId());
    return { state: created.state, value: created.grant };
  });
  await deps.audit({ event: 'grant-created', grantId: grant.id, grantee: grant.grantee, workspaces: grant.workspaces, reason, expiresAt: grant.expiresAt, by: subject });
  // The tab may have closed between the check and the write; its close event then found nothing to end.
  if (!(await deps.tabExists(ws, tab))) {
    await revokeForClosedTab(deps, { workspaceId: ws, tabId: tab });
    throw invalid(`tab ${tab} closed while the grant was being created`);
  }
  log.info({ grantId: grant.id, grantee: grant.grantee, workspaces: grant.workspaces }, 'drive grant created');
  return grant;
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
  const { grant, changed } = await mutateGrants((state) => {
    const found = state.grants.find((candidate) => candidate.id === id);
    if (!found) throw new GrantError('grant-not-found', `no grant ${id}`);
    if (found.revokedAt !== null) return { state, value: { grant: found, changed: false } };
    const r = revokeInState(state, id, subject, 'revoked', now);
    return { state: r.state, value: { grant: r.grant!, changed: true } };
  });
  if (changed) await deps.audit({ event: 'grant-revoked', grantId: id, reason: 'revoked', by: subject });
  return grant;
};

/** A request that passed the drive check only because of a grant (ADR-0014: audited on every use). */
export const auditGrantUse = (grant: IGrant, use: { route: string; targetWorkspaceId: string; targetTabId: string | null }): Promise<void> =>
  appendCoordinationAudit({
    event: 'grant-used',
    grantId: grant.id,
    grantee: grant.grantee,
    route: use.route,
    targetWorkspaceId: use.targetWorkspaceId,
    targetTabId: use.targetTabId,
  });

/** End the grants of a closed tab; audit each. */
export const revokeForClosedTab = async (deps: Pick<IGrantDeps, 'now' | 'audit'>, tab: { workspaceId: string; tabId: string }): Promise<IGrant[]> => {
  const now = deps.now();
  const revoked = await mutateGrants((state) => {
    const r = revokeForTabInState(state, tab, now);
    return { state: r.state, value: r.revoked };
  });
  for (const grant of revoked) await deps.audit({ event: 'grant-revoked', grantId: grant.id, reason: 'grantee-tab-closed', by: 'system' });
  return revoked;
};

/** Note expiries once (audit) and prune long-ended grants. */
export const sweepGrants = async (deps: Pick<IGrantDeps, 'now' | 'audit'>): Promise<IGrant[]> => {
  const now = deps.now();
  const expired = await mutateGrants((state) => {
    const r = sweepInState(state, now);
    return { state: r.state, value: r.expired };
  });
  for (const grant of expired) await deps.audit({ event: 'grant-expired', grantId: grant.id, grantee: grant.grantee, expiresAt: grant.expiresAt });
  return expired;
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
  try {
    const snapshot = await readLiveTabs();
    const live = new Set(snapshot.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
    const gone = grantsSnapshot().grants.filter((grant) => grant.revokedAt === null
      && !snapshot.uncertainWorkspaceIds.has(grant.grantee.workspaceId)
      && !live.has(`${grant.grantee.workspaceId}/${grant.grantee.tabId}`));
    for (const grant of gone) await revokeForClosedTab(deps, grant.grantee);
    await sweepGrants(deps);
  } catch (err) {
    log.warn(`grant boot sweep failed: ${err instanceof Error ? err.message : err}`);
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
