import useSWR, { type SWRConfiguration } from 'swr';
import { fetchGrantsView, GrantsReadError, type IGrantsView } from '@/lib/grants-client';

/**
 * The grants and grantee tabs (story 28). ONE poller owns the 30 s refresh (the
 * sidebar mounts it); the badges and the dialog read the shared SWR cache. A
 * refused read is thrown, so SWR keeps the last good view: a failed refresh
 * marks it stale instead of hiding active grants (review r1).
 */
const fetcher = async (): Promise<IGrantsView> => {
  const r = await fetchGrantsView();
  if (!r.ok) throw new GrantsReadError(r);
  return r.value;
};

export type TGrantsRole = 'poller' | 'reader' | 'fresh';

const OPTIONS: Record<TGrantsRole, SWRConfiguration<IGrantsView>> = {
  // The one owner of the refresh.
  poller: { refreshInterval: 30_000, revalidateOnFocus: true },
  // Tab badges: the cache only, no request of their own.
  reader: { refreshInterval: 0, revalidateOnMount: false, revalidateIfStale: false, revalidateOnFocus: false },
  // The dialog: one fresh read when it opens.
  fresh: { refreshInterval: 0, revalidateOnFocus: false },
};

const useGrants = (role: TGrantsRole = 'reader') => {
  const { data, error, mutate, isLoading } = useSWR<IGrantsView>('/api/grants', fetcher, OPTIONS[role]);
  const failure = error instanceof GrantsReadError ? error.failure : error ? { status: 0, code: null, reason: String(error) } : null;
  return {
    view: data ?? null,
    failure,
    /** The view shown is the last good one, and the latest read failed. */
    stale: !!data && !!failure,
    isLoading,
    refresh: () => mutate(),
  };
};

export default useGrants;
