import type { IGrant } from '@/types/grant';

// Pure view logic of the grant dialog and badge (story 28), tested without a DOM.

export const GRANT_EXPIRY_HOURS = [1, 6, 24, 72, 168] as const;
export const GRANT_DEFAULT_EXPIRY_HOURS = 24;

export const isGrantActive = (grant: IGrant, now: number): boolean => grant.revokedAt === null && grant.expiresAt > now;

export interface IGrantBadge {
  /** Distinct workspaces this tab may drive now. */
  count: number;
  workspaces: string[];
  /** The latest expiry among its active grants (the badge lasts until then). */
  expiresAt: number;
}

/** The badge of one tab, or null when it holds no active grant. */
export const grantBadgeOf = (grants: IGrant[], workspaceId: string, tabId: string, now: number): IGrantBadge | null => {
  const mine = grants.filter((g) => isGrantActive(g, now) && g.grantee.workspaceId === workspaceId && g.grantee.tabId === tabId);
  if (!mine.length) return null;
  const workspaces = [...new Set(mine.flatMap((g) => g.workspaces))].sort();
  return { count: workspaces.length, workspaces, expiresAt: Math.max(...mine.map((g) => g.expiresAt)) };
};

/**
 * The label key for a refused request (never a raw code on the face): the
 * served reason is shown after it. An unknown code falls back to a neutral
 * word plus the status and the reason.
 */
export type TGrantErrorKey =
  | 'errorPassword'
  | 'errorLocked'
  | 'errorSession'
  | 'errorOrigin'
  | 'errorUnverified'
  | 'errorInvalid'
  | 'errorNotFound'
  | 'errorStore'
  | 'errorNetwork'
  | 'errorUnknown';

export const grantErrorKey = (status: number, code: string | null): TGrantErrorKey => {
  if (status === 0) return 'errorNetwork';
  if (code === 'grant-password-invalid') return 'errorPassword';
  if (code === 'grant-locked') return 'errorLocked';
  if (status === 401) return 'errorSession';
  if (code === 'grant-tab-unverified') return 'errorUnverified';
  if (code === 'grant-invalid') return 'errorInvalid';
  if (code === 'grant-not-found') return 'errorNotFound';
  if (code === 'grant-store-unreadable') return 'errorStore';
  if (status === 403) return 'errorOrigin';
  return 'errorUnknown';
};

/**
 * The dialog's text for a refused request: the label for its state, then the
 * SERVED reason when the server gave one (story 28 AC: never a generic failure).
 */
export const describeGrantFailure = (
  r: { status: number; code: string | null; reason: string | null },
  label: (key: TGrantErrorKey, values?: Record<string, string | number>) => string,
): string => {
  const key = grantErrorKey(r.status, r.code);
  const text = key === 'errorUnknown' ? label(key, { status: r.status }) : label(key);
  return r.reason ? `${text}: ${r.reason}` : text;
};
