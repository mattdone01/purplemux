import useSWR from 'swr';
import { fetchGrantsView, type IGrantsView, type TGrantCall } from '@/lib/grants-client';

/**
 * The grants and grantee tabs, for the dialog and the tab badges (story 28).
 * One SWR key: every badge shares the one request. A refusal is data, not an
 * exception, so the dialog can show the served reason.
 */
const fetcher = (): Promise<TGrantCall<IGrantsView>> => fetchGrantsView();

const useGrants = () => {
  const { data, mutate, isLoading } = useSWR('/api/grants', fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  return {
    view: data?.ok ? data.value : null,
    failure: data && !data.ok ? data : null,
    isLoading,
    refresh: () => mutate(),
  };
};

export default useGrants;
