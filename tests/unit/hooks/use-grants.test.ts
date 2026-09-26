import { afterEach, describe, expect, it, vi } from 'vitest';
import { flatGrantsRetry, GRANTS_POLL_MS, GRANTS_SWR_OPTIONS, grantsFetcher, grantsHookState, serverTimeOf } from '@/hooks/use-grants';
import { fetchGrantsView, GrantsReadError, type IGrantsView } from '@/lib/grants-client';
import { grantBadgeOf, grantDialogError, withoutKey } from '@/lib/grant-view';
import type { IGrant } from '@/types/grant';

// Story 28 review r2: the hook's behaviour, pinned without a DOM — the fetcher,
// the state it derives from SWR's data and error, the server clock, the roles.

const view = (over: Partial<IGrantsView> = {}): IGrantsView => ({
  grants: [], grantees: [], unreadableWorkspaceIds: [], granteesError: null, skewMs: 0, ...over,
});

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('grantsFetcher', () => {
  it('throws a refused read as GrantsReadError with the served status, code and reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'grants.json is malformed', code: 'grant-store-unreadable' })));
    const err = await grantsFetcher().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantsReadError);
    expect((err as GrantsReadError).failure).toEqual({ status: 500, code: 'grant-store-unreadable', reason: 'grants.json is malformed' });
  });

  it('returns the view on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { grants: [], grantees: [], unreadableWorkspaceIds: ['ws-2'], granteesError: null })));
    expect(await grantsFetcher()).toMatchObject({ unreadableWorkspaceIds: ['ws-2'] });
  });
});

describe('fetchGrantsView skew', () => {
  it('is the server clock minus the client clock at the read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { grants: [], grantees: [], serverNow: 1_090_000 })));
    const r = await fetchGrantsView();
    expect(r.ok && r.value.skewMs).toBe(90_000);
  });

  it('is 0 when the server sends no clock', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { grants: [], grantees: [] })));
    const r = await fetchGrantsView();
    expect(r.ok && r.value.skewMs).toBe(0);
  });
});

describe('grantsHookState', () => {
  const refused = new GrantsReadError({ status: 502, code: null, reason: 'bad gateway' });

  it('keeps the last good view after a failed refresh and marks it stale (review r1: a failed read never hides grants)', () => {
    const last = view({ grants: [{ id: 'g-1' } as IGrant] });
    expect(grantsHookState(last, refused)).toEqual({ view: last, failure: refused.failure, stale: true });
  });

  it('with no data yet, a failure means the lists are unknown (view null), never empty', () => {
    expect(grantsHookState(undefined, refused)).toEqual({ view: null, failure: refused.failure, stale: false });
  });

  it('a non-refusal error still reports a failure; no error is a fresh view', () => {
    expect(grantsHookState(undefined, new TypeError('offline')).failure).toEqual({ status: 0, code: null, reason: 'offline' });
    expect(grantsHookState(view(), undefined)).toEqual({ view: view(), failure: null, stale: false });
  });
});

describe('grants on the server clock', () => {
  const grant = { id: 'g-1', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], expiresAt: 1_050_000, revokedAt: null } as unknown as IGrant;

  it('a grant expired by the client clock but active by the server clock still shows its badge', () => {
    const v = view({ grants: [grant], skewMs: -100_000 });
    // Client clock 1_100_000 is past the expiry; the server clock (1_000_000) is not.
    expect(grantBadgeOf(v.grants, 'ws-1', 'tab-a', 1_100_000)).toBeNull();
    expect(grantBadgeOf(v.grants, 'ws-1', 'tab-a', serverTimeOf(v, 1_100_000))).toMatchObject({ count: 1 });
  });

  it('serverTimeOf without a view is the client clock', () => {
    expect(serverTimeOf(null, 5)).toBe(5);
  });
});

describe('the SWR roles', () => {
  it('only the poller refreshes; the badges read the cache and never request', () => {
    expect(GRANTS_SWR_OPTIONS.poller.refreshInterval).toBe(GRANTS_POLL_MS);
    expect(GRANTS_SWR_OPTIONS.reader).toMatchObject({ refreshInterval: 0, revalidateOnMount: false, revalidateIfStale: false, revalidateOnFocus: false });
    expect(GRANTS_SWR_OPTIONS.fresh).toMatchObject({ refreshInterval: 0, revalidateOnFocus: false });
  });

  it('every role retries a failed read every 30 s, flat (SWR runs the retry on the first subscriber, whatever its role)', () => {
    vi.useFakeTimers();
    try {
      for (const role of ['poller', 'reader', 'fresh'] as const) {
        expect(GRANTS_SWR_OPTIONS[role].onErrorRetry).toBe(flatGrantsRetry);
        expect(GRANTS_SWR_OPTIONS[role].shouldRetryOnError).not.toBe(false);
      }
      const revalidate = vi.fn(async () => true);
      for (const retryCount of [1, 5, 9]) {
        flatGrantsRetry(new Error('x'), '/api/grants', {} as never, revalidate, { retryCount, dedupe: false });
        vi.advanceTimersByTime(GRANTS_POLL_MS - 1);
        expect(revalidate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(revalidate).toHaveBeenCalledWith({ retryCount, dedupe: false });
        revalidate.mockClear();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('failures during an outage share one pending retry (focus reads do not pile up chains)', () => {
    vi.useFakeTimers();
    try {
      const revalidate = vi.fn(async () => true);
      for (let i = 0; i < 4; i++) flatGrantsRetry(new Error('x'), '/api/grants', {} as never, revalidate, { retryCount: 1, dedupe: false });
      vi.advanceTimersByTime(GRANTS_POLL_MS);
      expect(revalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('grant dialog errors', () => {
  it('a later revoke\'s success never wipes another grant\'s refusal', () => {
    const errors = { 'g-1': 'Not allowed: grant already ended' };
    // g-2 succeeded: only its own entry is cleared.
    expect(grantDialogError(null, withoutKey(errors, 'g-2'), null)).toBe('Not allowed: grant already ended');
    expect(grantDialogError(null, withoutKey(errors, 'g-1'), null)).toBeNull();
  });

  it('create refusal first, then revoke refusals, then the read failure', () => {
    expect(grantDialogError('bad password', { 'g-1': 'x' }, 'stale')).toBe('bad password');
    expect(grantDialogError(null, { 'g-1': 'x', 'g-2': 'y' }, 'stale')).toBe('x · y');
    expect(grantDialogError(null, {}, 'stale')).toBe('stale');
  });

  it('drops a refusal for a grant no longer listed; keeps all when the list is unknown', () => {
    expect(grantDialogError(null, { 'g-1': 'x', 'g-2': 'y' }, null, ['g-2'])).toBe('y');
    expect(grantDialogError(null, { 'g-1': 'x' }, null, null)).toBe('x');
  });
});
