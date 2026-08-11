import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import dayjs from 'dayjs';
import { CircleAlert, CircleCheck, CircleDashed, CircleDot, MoveRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import useStandupStore from '@/hooks/use-standup-store';
import { STANDUP_STALE_MS } from '@/lib/standup';
import type { TStandupItemStatus, TStandupState } from '@/types/status';

const STATE_DOT: Record<TStandupState, string> = {
  'on-track': 'bg-ui-green',
  'at-risk': 'bg-ui-amber',
  blocked: 'bg-ui-red',
  'awaiting-human': 'bg-ui-coral',
  done: 'bg-ui-purple',
};

const STATE_LABEL_KEY: Record<TStandupState, string> = {
  'on-track': 'stateOnTrack',
  'at-risk': 'stateAtRisk',
  blocked: 'stateBlocked',
  'awaiting-human': 'stateAwaitingHuman',
  done: 'stateDone',
};

const ITEM_ICON: Record<TStandupItemStatus, { icon: typeof CircleCheck; className: string }> = {
  done: { icon: CircleCheck, className: 'text-ui-green' },
  active: { icon: CircleDot, className: 'text-ui-blue' },
  blocked: { icon: CircleAlert, className: 'text-ui-red' },
  todo: { icon: CircleDashed, className: 'text-muted-foreground/60' },
};

interface IWorkspaceStandupProps {
  workspaceId: string;
}

const WorkspaceStandup = ({ workspaceId }: IWorkspaceStandupProps) => {
  const t = useTranslations('standup');
  const standup = useStandupStore((s) => s.standups[workspaceId]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!standup) return;
    const tick = () => setNow(Date.now());
    const timeout = setTimeout(tick, 0);
    const timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(timer);
    };
  }, [standup]);

  if (!standup) return null;

  // now === 0 until the effect's first run; treat that frame as fresh.
  const isStale = now > 0 && now - standup.at > STANDUP_STALE_MS;
  const doneCount = standup.items.filter((i) => i.status === 'done').length;
  const age = now > 0 ? dayjs(standup.at).from(dayjs(now), true) : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="mt-1 flex w-full min-w-0 items-center gap-1.5 text-left"
        aria-label={t('title')}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            STATE_DOT[standup.state],
            isStale && 'opacity-40',
          )}
        />
        <span
          className={cn(
            'truncate text-xs leading-tight',
            standup.needsHuman ? 'text-ui-coral' : 'text-muted-foreground/80',
            isStale && 'opacity-60',
          )}
        >
          {standup.items.length > 0 && `${doneCount}/${standup.items.length} · `}
          {standup.headline}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-3"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT[standup.state])} />
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(STATE_LABEL_KEY[standup.state])}
          </span>
          {standup.needsHuman && (
            <span className="rounded bg-[var(--ui-coral)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
              {t('needsYou')}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
            {age}
            {isStale && ` · ${t('stale')}`}
          </span>
        </div>

        <p className="mt-2 text-sm font-medium leading-snug">{standup.headline}</p>

        {standup.items.length > 0 && (
          <ul className="mt-2 space-y-1">
            {standup.items.map((item, i) => {
              const { icon: Icon, className } = ITEM_ICON[item.status];
              return (
                <li key={`${item.label}-${i}`} className="flex items-start gap-1.5 text-xs leading-snug">
                  <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', className)} />
                  <span className="min-w-0">
                    <span className={cn(item.status === 'done' && 'text-muted-foreground line-through')}>
                      {item.label}
                    </span>
                    {item.note && <span className="text-muted-foreground/70"> — {item.note}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {standup.blockers.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-ui-red/90">{t('blockers')}</p>
            <ul className="mt-1 space-y-1">
              {standup.blockers.map((blocker, i) => (
                <li key={`${blocker.what}-${i}`} className="text-xs leading-snug">
                  {blocker.what}
                  <span className="text-muted-foreground/70"> — {t('needs')}: {blocker.needs}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {standup.next.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('next')}</p>
            <ul className="mt-1 space-y-1">
              {standup.next.map((step, i) => (
                <li key={`${step}-${i}`} className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground">
                  <MoveRight className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default WorkspaceStandup;
