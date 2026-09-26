import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import type { IGrant, IGrantsState, TGrantEndReason, TGrantErrorCode } from '@/types/grant';

// Portfolio drive grants (ADR-0014, story 11). A human, through the web session
// plus the purplemux password, lets ONE verified tab drive other workspaces for
// at most 7 days. `canDriveWorkspace` is synchronous, so the grants live in a
// cache on globalThis that every write refreshes; the server bundle and each
// Next API route share it. A malformed grants.json means NO grants (fail
// closed) and refuses writes until it is repaired or moved aside.

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
]);

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

export interface ICreateGrantInput {
  granteeWorkspaceId: string;
  granteeTabId: string;
  workspaces: string[];
  reason: string;
  expiresInHours: number;
  createdBy: string;
}

export const createGrantInState = (state: IGrantsState, input: ICreateGrantInput, now: number, id: string): { state: IGrantsState; grant: IGrant } => {
  const grant: IGrant = {
    id,
    capability: 'drive',
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

// ─── the file store and its cache ─────────────────────────────────────────

interface IGrantsCache {
  state: IGrantsState;
  /** A malformed or unreadable file: no grant is honoured and no write happens. */
  refusal: string | null;
}

const g = globalThis as unknown as { __ptGrants?: IGrantsCache; __ptGrantsLock?: Promise<void> };
if (!g.__ptGrantsLock) g.__ptGrantsLock = Promise.resolve();

export const grantsFile = (): string => path.join(os.homedir(), '.purplemux', 'grants.json');

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const isGrant = (v: unknown): v is IGrant => {
  if (!isObject(v)) return false;
  const grantee = v.grantee;
  return typeof v.id === 'string' && v.capability === 'drive'
    && isObject(grantee) && typeof grantee.workspaceId === 'string' && typeof grantee.tabId === 'string'
    && Array.isArray(v.workspaces) && v.workspaces.every((w) => typeof w === 'string')
    && typeof v.reason === 'string' && Number.isFinite(v.createdAt) && typeof v.createdBy === 'string'
    && Number.isFinite(v.expiresAt)
    && (v.revokedAt === null || Number.isFinite(v.revokedAt))
    && (v.expiryNotedAt === null || v.expiryNotedAt === undefined || Number.isFinite(v.expiryNotedAt));
};

/** Reads the file into the cache. Absent = no grants; malformed or unreadable = no grants AND refused writes. */
const load = (): IGrantsCache => {
  const file = grantsFile();
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
  if (!isObject(parsed) || !Array.isArray(parsed.grants) || !parsed.grants.every(isGrant)) {
    return { state: { grants: [] }, refusal: `${file} is malformed; no grant is honoured until it is repaired or moved aside` };
  }
  const grants = (parsed.grants as IGrant[]).map((grant) => ({ ...grant, expiryNotedAt: grant.expiryNotedAt ?? null }));
  return { state: { grants }, refusal: null };
};

const cache = (): IGrantsCache => {
  if (!g.__ptGrants) g.__ptGrants = load();
  return g.__ptGrants;
};

/** The grants as the predicates see them (fail closed: none while the file is refused). */
export const grantsSnapshot = (): IGrantsState => cache().state;

export const grantsRefusal = (): string | null => cache().refusal;

/** Drop the cache so the next read reloads the file (boot, tests). */
export const reloadGrants = (): void => {
  g.__ptGrants = undefined;
};

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptGrantsLock!;
  g.__ptGrantsLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const write = async (state: IGrantsState): Promise<void> => {
  const file = grantsFile();
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

/** Read (fresh from disk), transform, write, refresh the cache — one lock. A refused file is never written. */
export const mutateGrants = <T>(fn: (state: IGrantsState) => { state: IGrantsState; value: T }): Promise<T> =>
  withLock(async () => {
    const fresh = load();
    g.__ptGrants = fresh;
    if (fresh.refusal) throw new GrantError('grant-store-unreadable', fresh.refusal);
    const { state, value } = fn(fresh.state);
    if (state !== fresh.state) {
      await write(state);
      g.__ptGrants = { state, refusal: null };
    }
    return value;
  });

export const newGrantId = (): string => `g-${nanoid(10)}`;
