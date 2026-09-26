import useSWR, { type SWRConfiguration } from 'swr';
import { fetchGrantsView, GrantsReadError, type IGrantsView } from '@/lib/grants-client';

/**
 * The grants and grantee tabs (story 28). ONE poller owns the 30 s refresh (the
 * sidebar mounts it); the badges and the dialog read the shared SWR cache. A
 * refused read is thrown, so SWR keeps the last good view: a failed refresh
 * marks it stale instead of hiding active grants (review r1).
 */
export const grantsFetcher = async (): Promise<IGrantsView> => {
  const r = await fetchGrantsView();
  if (!r.ok) throw new GrantsReadError(r);
  return r.value;
};

export type TGrantsRole = 'poller' | 'reader' | 'fresh';

export const GRANTS_POLL_MS = 30_000;

// One pending retry for the key: each failed focus or reconnect read would otherwise start its own 30 s chain (review r3).
let pendingRetry: ReturnType<typeof setTimeout> | null = null;

/**
 * A flat 30 s retry. SWR skips its interval while the cache holds an error and
 * backs off retries for up to ~32 min, so the poll cadence would stop through an
 * outage (review r2). SWR runs the retry on the key's FIRST subscriber, which may
 * be any role, so every role carries it (review r3).
 */
export const flatGrantsRetry: NonNullable<SWRConfiguration<IGrantsView>['onErrorRetry']> = (_error, _key, _config, revalidate, revalidateOptions) => {
  if (pendingRetry) return;
  pendingRetry = setTimeout(() => {
    pendingRetry = null;
    void revalidate(revalidateOptions);
  }, GRANTS_POLL_MS);
};

export const GRANTS_SWR_OPTIONS: Record<TGrantsRole, SWRConfiguration<IGrantsView>> = {
  // The one owner of the refresh.
  poller: { refreshInterval: GRANTS_POLL_MS, revalidateOnFocus: true, onErrorRetry: flatGrantsRetry },
  // Tab badges: the cache only, no request of their own.
  reader: { refreshInterval: 0, revalidateOnMount: false, revalidateIfStale: false, revalidateOnFocus: false, onErrorRetry: flatGrantsRetry },
  // The dialog: one fresh read when it opens.
  fresh: { refreshInterval: 0, revalidateOnFocus: false, onErrorRetry: flatGrantsRetry },
};

export interface IGrantsHookState {
  view: IGrantsView | null;
  failure: { status: number; code: string | null; reason: string | null } | null;
  /** The view shown is the last good one, and the latest read failed. */
  stale: boolean;
}

/** What the hook returns for SWR's `data` and `error`: an error never clears the last good view. */
export const grantsHookState = (data: IGrantsView | undefined, error: unknown): IGrantsHookState => {
  const failure = error instanceof GrantsReadError
    ? error.failure
    : error
      ? { status: 0, code: null, reason: error instanceof Error ? error.message : String(error) }
      : null;
  return { view: data ?? null, failure, stale: !!data && !!failure };
};

/** The server's clock for a client time: grant activity is judged on the time the server keeps. */
export const serverTimeOf = (view: IGrantsView | null, clientNow: number): number => clientNow + (view?.skewMs ?? 0);

const useGrants = (role: TGrantsRole = 'reader') => {
  const { data, error, mutate, isLoading } = useSWR<IGrantsView>('/api/grants', grantsFetcher, GRANTS_SWR_OPTIONS[role]);
  return {
    ...grantsHookState(data, error),
    isLoading,
    refresh: () => mutate(),
  };
};

export default useGrants;
