import { useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import useGrants from '@/hooks/use-grants';
import useNowTick from '@/hooks/use-now-tick';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { grantBadgeOf, type IGrantBadge } from '@/lib/grant-view';

// "drives N workspaces" on a grantee tab (story 28; ADR-0014), with the
// workspaces and the expiry in its tooltip.

export const GrantBadgeView = ({ badge, workspaceNames }: { badge: IGrantBadge; workspaceNames: Record<string, string> }) => {
  const t = useTranslations('grants');
  const detail = t('badgeTooltip', {
    workspaces: badge.workspaces.map((id) => workspaceNames[id] ?? id).join(', '),
    time: new Date(badge.expiresAt).toLocaleString(),
  });
  return (
    <Tooltip>
      <TooltipTrigger
        className="ml-0.5 inline-flex h-3.5 shrink-0 items-center rounded bg-[var(--ui-amber)] px-1 text-[9px] font-medium leading-none text-white"
        aria-label={detail}
        data-grant-badge={badge.count}
      >
        {t('badge', { count: badge.count })}
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
};

const GrantBadge = ({ workspaceId, tabId }: { workspaceId: string | null; tabId: string }) => {
  const { view } = useGrants();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  // A minute clock: the badge goes at expiry without waiting for the next grants read.
  const now = useNowTick(60_000);
  if (!workspaceId || !view) return null;
  const badge = grantBadgeOf(view.grants, workspaceId, tabId, now);
  if (!badge) return null;
  return <GrantBadgeView badge={badge} workspaceNames={Object.fromEntries(workspaces.map((w) => [w.id, w.name]))} />;
};

export default GrantBadge;
