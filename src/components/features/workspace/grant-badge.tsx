import { useFormatter, useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import useGrants, { serverTimeOf } from '@/hooks/use-grants';
import useNowTick from '@/hooks/use-now-tick';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { describeGrantFailure, grantBadgeOf, type IGrantBadge } from '@/lib/grant-view';
import { cn } from '@/lib/utils';

// "drives N workspaces" on a grantee tab (story 28; ADR-0014), with the
// workspaces and the expiry in its tooltip. A failed refresh keeps the badge
// from the last good read and marks it "not refreshed" (review r1).

export const GrantBadgeView = ({ badge, workspaceNames, staleReason = null }: {
  badge: IGrantBadge;
  workspaceNames: Record<string, string>;
  staleReason?: string | null;
}) => {
  const t = useTranslations('grants');
  const format = useFormatter();
  const detail = t('badgeTooltip', {
    workspaces: badge.workspaces.map((id) => workspaceNames[id] ?? id).join(', '),
    time: format.dateTime(new Date(badge.expiresAt), { dateStyle: 'medium', timeStyle: 'short' }),
  });
  const label = staleReason ? `${detail} (${t('staleSuffix', { reason: staleReason })})` : detail;
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          'ml-0.5 inline-flex h-3.5 shrink-0 items-center rounded bg-[var(--ui-amber)] px-1 text-[9px] font-medium leading-none text-white',
          staleReason && 'opacity-60',
        )}
        aria-label={label}
        data-grant-badge={badge.count}
        data-stale={staleReason ? 'true' : undefined}
      >
        {t('badge', { count: badge.count })}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};

const GrantBadge = ({ workspaceId, tabId }: { workspaceId: string | null; tabId: string }) => {
  // A reader: the sidebar's poller owns the refresh; badges only read the shared cache.
  const t = useTranslations('grants');
  const { view, failure, stale } = useGrants('reader');
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  // A minute clock: the badge goes at expiry without waiting for the next grants read.
  const now = useNowTick(60_000);
  if (!workspaceId || !view) return null;
  const badge = grantBadgeOf(view.grants, workspaceId, tabId, serverTimeOf(view, now));
  if (!badge) return null;
  return (
    <GrantBadgeView
      badge={badge}
      workspaceNames={Object.fromEntries(workspaces.map((w) => [w.id, w.name]))}
      staleReason={stale && failure ? describeGrantFailure(failure, (key, values) => t(key, values)) : null}
    />
  );
};

export default GrantBadge;
