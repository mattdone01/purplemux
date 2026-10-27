import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import type { IGrant, IGrantRefusal, IGrantsState, TGrantCapability, TGrantEndReason, TGrantErrorCode } from '@/types/grant';

// Portfolio drive grants (ADR-0014, story 11). A human, through the web session
// plus the purplemux password, lets ONE verified tab drive other workspaces for
// at most 7 days. `canDriveWorkspace` is synchronous, so the grants live in a
// cache on globalThis that every write refreshes; the server bundle and each
// Next API route share it. A malformed grants.json means NO grants (fail
// closed) and refuses writes until it is repaired or moved aside.
//
// Owner grants (ADR-0029) live in their own file, owner-grants.json, with the
// same record shape, its own cache and its own lock: a release that predates
// them refuses the WHOLE grants.json on one non-`drive` record, so a rollback
// would honour no drive grant. Each file fails closed on its own.

export const GRANT_DEFAULT_HOURS = 24;
export const GRANT_MAX_HOURS = 168;
export const GRANT_REASON_MAX = 200;
/** Ended grants stay listed this long, then are pruned. */
export const GRANT_KEEP_ENDED_MS = 7 * 24 * 60 * 60 * 1000;

export class GrantError extends Error {
  constructor(readonly code: TGrantErrorCode, message: string) {
    super(message);
    this.name = 'GrantError';
  }
}

const GRANT_ERROR_CODES: ReadonlySet<string> = new Set<TGrantErrorCode>([
  'grant-invalid', 'grant-not-found', 'grant-tab-unverified', 'grant-password-invalid', 'grant-locked', 'grant-store-unreadable',
  'grant-owner-active',
]);

/** The one `workspaces` value of an owner grant: every workspace, including one created later. */
export const OWNER_GRANT_WORKSPACES: readonly string[] = Object.freeze(['*']);

/** By name as well as by class: the store may be reached from another bundle's module copy (story 22). */
export const isGrantError = (err: unknown): err is GrantError =>
  err instanceof GrantError
  || (err instanceof Error && err.name === 'GrantError' && GRANT_ERROR_CODES.has(String((err as { code?: unknown }).code)));

// ─── pure state ───────────────────────────────────────────────────────────

export const isActive = (grant: IGrant, now: number): boolean => grant.revokedAt === null && grant.expiresAt > now;

/** The active grant that lets this exact tab drive `targetWorkspaceId`, or null. */
export const findActiveDriveGrant = (
  state: IGrantsState,
  grantee: { workspaceId: string; tabId: string },
  targetWorkspaceId: string,
  now: number,
): IGrant | null =>
  state.grants.find((g) => isActive(g, now)
    && g.capability === 'drive'
    && g.grantee.workspaceId === grantee.workspaceId
    && g.grantee.tabId === grantee.tabId
    && g.workspaces.includes(targetWorkspaceId)) ?? null;

/** The active owner grant held by this exact tab, or null. */
export const findActiveOwnerGrant = (state: IGrantsState, grantee: { workspaceId: string; tabId: string }, now: number): IGrant | null =>
  state.grants.find((g) => isActive(g, now)
    && g.capability === 'owner'
    && g.grantee.workspaceId === grantee.workspaceId
    && g.grantee.tabId === grantee.tabId) ?? null;

export interface ICreateGrantInput {
  granteeWorkspaceId: string;
  granteeTabId: string;
  workspaces: string[];
  reason: string;
  expiresInHours: number;
  createdBy: string;
  capability?: TGrantCapability;
}

export const createGrantInState = (state: IGrantsState, input: ICreateGrantInput, now: number, id: string): { state: IGrantsState; grant: IGrant } => {
  const grant: IGrant = {
    id,
    capability: input.capability ?? 'drive',
    grantee: { workspaceId: input.granteeWorkspaceId, tabId: input.granteeTabId },
    workspaces: [...input.workspaces],
    reason: input.reason,
    createdAt: now,
    createdBy: input.createdBy,
    expiresAt: now + input.expiresInHours * 60 * 60 * 1000,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    expiryNotedAt: null,
  };
  return { state: { grants: [...state.grants, grant] }, grant };
};

export const revokeInState = (
  state: IGrantsState,
  id: string,
  by: string,
  reason: TGrantEndReason,
  now: number,
): { state: IGrantsState; grant: IGrant | null } => {
  const found = state.grants.find((g) => g.id === id);
  if (!found || found.revokedAt !== null) return { state, grant: null };
  const ended: IGrant = { ...found, revokedAt: now, revokedBy: by, revokeReason: reason };
  return { state: { grants: state.grants.map((g) => (g.id === id ? ended : g)) }, grant: ended };
};

/** Every active grant held by a tab that closed ends with `grantee-tab-closed`. */
export const revokeForTabInState = (
  state: IGrantsState,
  tab: { workspaceId: string; tabId: string },
  now: number,
): { state: IGrantsState; revoked: IGrant[] } => {
  const revoked: IGrant[] = [];
  const grants = state.grants.map((g) => {
    if (g.revokedAt !== null || g.grantee.workspaceId !== tab.workspaceId || g.grantee.tabId !== tab.tabId) return g;
    const ended: IGrant = { ...g, revokedAt: now, revokedBy: 'system', revokeReason: 'grantee-tab-closed' };
    revoked.push(ended);
    return ended;
  });
  return { state: revoked.length ? { grants } : state, revoked };
};

/** Grants past their expiry are noted once (for the audit); ended grants older than a week are pruned. */
export const sweepInState = (state: IGrantsState, now: number): { state: IGrantsState; expired: IGrant[]; pruned: number } => {
  const expired: IGrant[] = [];
  let changed = false;
  const kept: IGrant[] = [];
  for (const g of state.grants) {
    // An expiry is noted (audited) before anything prunes it, even one older than the keep window.
    const noted = g.revokedAt !== null || g.expiryNotedAt !== null;
    const endedAt = g.revokedAt ?? (g.expiresAt <= now ? g.expiresAt : null);
    if (noted && endedAt !== null && now - endedAt > GRANT_KEEP_ENDED_MS) {
      changed = true;
      continue;
    }
    if (g.revokedAt === null && g.expiresAt <= now && g.expiryNotedAt === null) {
      const noted = { ...g, expiryNotedAt: now };
      expired.push(noted);
      kept.push(noted);
      changed = true;
      continue;
    }
    kept.push(g);
  }
  return { state: changed ? { grants: kept } : state, expired, pruned: state.grants.length - kept.length };
};

// ─── the file stores and their caches ─────────────────────────────────────

interface IGrantsCache {
  state: IGrantsState;
  /** A malformed or unreadable file: no grant is honoured and no write happens. */
  refusal: string | null;
}

/** Which file a grant lives in: the drive file or the owner file. */
export type TGrantStore = TGrantCapability;

export const GRANT_STORES: readonly TGrantStore[] = ['drive', 'owner'];

const g = globalThis as unknown as {
  __ptGrants?: IGrantsCache;
  __ptGrantsLock?: Promise<void>;
  __ptOwnerGrants?: IGrantsCache;
  __ptOwnerGrantsLock?: Promise<void>;
};
if (!g.__ptGrantsLock) g.__ptGrantsLock = Promise.resolve();
if (!g.__ptOwnerGrantsLock) g.__ptOwnerGrantsLock = Promise.resolve();

const CACHE_KEY = { drive: '__ptGrants', owner: '__ptOwnerGrants' } as const;
const LOCK_KEY = { drive: '__ptGrantsLock', owner: '__ptOwnerGrantsLock' } as const;

export const grantsFile = (): string => path.join(os.homedir(), '.purplemux', 'grants.json');

export const ownerGrantsFile = (): string => path.join(os.homedir(), '.purplemux', 'owner-grants.json');

export const grantStoreFile = (store: TGrantStore): string => (store === 'owner' ? ownerGrantsFile() : grantsFile());

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A record of `store`: each file holds its own capability only, and an owner record reads exactly `['*']`. */
const isGrant = (v: unknown, store: TGrantStore): v is IGrant => {
  if (!isObject(v)) return false;
  const grantee = v.grantee;
  const workspaces = store === 'owner'
    ? Array.isArray(v.workspaces) && v.workspaces.length === 1 && v.workspaces[0] === '*'
    : Array.isArray(v.workspaces) && v.workspaces.every((w) => typeof w === 'string');
  return typeof v.id === 'string' && v.capability === store
    && isObject(grantee) && typeof grantee.workspaceId === 'string' && typeof grantee.tabId === 'string'
    && workspaces
    && typeof v.reason === 'string' && Number.isFinite(v.createdAt) && typeof v.createdBy === 'string'
    && Number.isFinite(v.expiresAt)
    && (v.revokedAt === null || Number.isFinite(v.revokedAt))
    && (v.expiryNotedAt === null || v.expiryNotedAt === undefined || Number.isFinite(v.expiryNotedAt));
};

/** Reads one file. Absent = no grants; malformed or unreadable = no grants AND refused writes. */
const load = (store: TGrantStore): IGrantsCache => {
  const file = grantStoreFile(store);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: { grants: [] }, refusal: null };
    return { state: { grants: [] }, refusal: `${file} is unreadable: ${err instanceof Error ? err.message : err}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.grants) || !parsed.grants.every((v) => isGrant(v, store))) {
    return { state: { grants: [] }, refusal: `${file} is malformed; no grant is honoured until it is repaired or moved aside` };
  }
  const grants = (parsed.grants as IGrant[]).map((grant) => ({ ...grant, expiryNotedAt: grant.expiryNotedAt ?? null }));
  return { state: { grants }, refusal: null };
};

const cache = (store: TGrantStore): IGrantsCache => {
  const key = CACHE_KEY[store];
  if (!g[key]) g[key] = load(store);
  return g[key]!;
};

/** The grants of one file as the predicates see them (fail closed: none while that file is refused). */
export const grantsSnapshot = (store: TGrantStore = 'drive'): IGrantsState => cache(store).state;

export const grantsRefusal = (store: TGrantStore = 'drive'): string | null => cache(store).refusal;

/**
 * Every grant of both files (ADR-0029 §1: each file fails alone). `grants` holds
 * the records of each readable file, drive then owner — the same cache the
 * predicates read, so its active entries are exactly the grants in force.
 * `refused` names each unreadable file; only both refused is a total failure.
 */
export const listAllGrants = (): { ok: true; grants: IGrant[]; refused: IGrantRefusal[] } | { ok: false; error: string } => {
  const refused: IGrantRefusal[] = [];
  const grants: IGrant[] = [];
  for (const store of GRANT_STORES) {
    const refusal = grantsRefusal(store);
    if (refusal) {
      refused.push({ capability: store, file: store === 'owner' ? 'owner-grants.json' : 'grants.json', error: refusal, code: 'grant-store-unreadable' });
    } else {
      grants.push(...grantsSnapshot(store).grants);
    }
  }
  if (refused.length === GRANT_STORES.length) return { ok: false, error: refused.map((r) => r.error).join('; ') };
  return { ok: true, grants, refused };
};

/** Drop both caches so the next read reloads the files (boot, tests). */
export const reloadGrants = (): void => {
  g.__ptGrants = undefined;
  g.__ptOwnerGrants = undefined;
};

const withLock = async <T>(store: TGrantStore, fn: () => Promise<T>): Promise<T> => {
  const key = LOCK_KEY[store];
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g[key]!;
  g[key] = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const write = async (store: TGrantStore, state: IGrantsState): Promise<void> => {
  const file = grantStoreFile(store);
  const tmp = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Read (fresh from disk), transform, write, refresh the cache — one lock per file. A refused file is never written. */
export const mutateGrants = <T>(
  fn: (state: IGrantsState) => { state: IGrantsState; value: T },
  store: TGrantStore = 'drive',
): Promise<T> =>
  withLock(store, async () => {
    const key = CACHE_KEY[store];
    const fresh = load(store);
    g[key] = fresh;
    if (fresh.refusal) throw new GrantError('grant-store-unreadable', fresh.refusal);
    const { state, value } = fn(fresh.state);
    if (state !== fresh.state) {
      await write(store, state);
      g[key] = { state, refusal: null };
    }
    return value;
  });

export const newGrantId = (): string => `g-${nanoid(10)}`;
