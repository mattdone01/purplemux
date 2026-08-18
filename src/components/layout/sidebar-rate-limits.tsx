import { useEffect, useState } from 'react';
import useRateLimitsStore from '@/hooks/use-rate-limits-store';
import type { IRateLimitWindow, IRateLimitsData, TRateLimitsProvider } from '@/types/status';
import ClaudeCodeIcon from '@/components/icons/claude-code-icon';
import OpenAIIcon from '@/components/icons/openai-icon';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const PERIOD_SECS = { '5h': 5 * 3600, '7d': 7 * 86400 } as const;
type TLimitLabel = keyof typeof PERIOD_SECS;

const getEffectiveWindow = (window: IRateLimitWindow, label: TLimitLabel) => {
  const nowSecs = Date.now() / 1000;
  if (window.resets_at > nowSecs) {
    return { resetsAt: window.resets_at, usedPct: window.used_percentage };
  }
  const elapsed = nowSecs - window.resets_at;
  const period = PERIOD_SECS[label];
  const nextResetsAt = window.resets_at + Math.ceil(elapsed / period) * period;
  return { resetsAt: nextResetsAt, usedPct: 0 };
};

const getProjectedPct = (
  usedPct: number,
  resetsAt: number,
  label: TLimitLabel,
): number => {
  const period = PERIOD_SECS[label];
  const remaining = Math.max(0, resetsAt - Date.now() / 1000);
  const elapsed = period - remaining;
  if (elapsed <= 0) return usedPct;
  return Math.min(100, (usedPct * period) / elapsed);
};

const formatRemaining = (resetsAt: number): string => {
  const secs = Math.max(0, Math.floor(resetsAt - Date.now() / 1000));
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const barColor = (pct: number): string => {
  if (pct >= 80) return 'bg-ui-red';
  if (pct >= 50) return 'bg-ui-amber';
  return 'bg-ui-teal';
};

const LimitBar = ({ label, window, scopeLabel }: { label: TLimitLabel; window: IRateLimitWindow; scopeLabel?: string }) => {
  const { resetsAt, usedPct } = getEffectiveWindow(window, label);
  const pct = Math.min(100, Math.round(usedPct));
  const projectedPct = Math.min(100, Math.round(getProjectedPct(usedPct, resetsAt, label)));
  const remaining = formatRemaining(resetsAt);
  const showProjection = projectedPct > pct;

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="w-full cursor-default space-y-0.5" />}>
        <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground/60">
          <span>{scopeLabel ? `${label} · ${scopeLabel}` : label}</span>
          <span>
            {remaining} ({pct}%
            {showProjection && (
              <span className="text-muted-foreground/40"> → {projectedPct}%</span>
            )}
            )
          </span>
        </div>
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted-foreground/10">
          {showProjection && (
            <div
              className={`absolute left-0 top-0 h-full rounded-full opacity-30 transition-all duration-300 ${barColor(projectedPct)}`}
              style={{ width: `${projectedPct}%` }}
            />
          )}
          <div
            className={`absolute left-0 top-0 h-full rounded-full transition-all duration-300 ${barColor(pct)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px]">
        <div className="flex flex-col gap-0.5 text-left">
          <div>
            {scopeLabel ? `${scopeLabel} weekly limit: ` : ''}{pct}% used · resets in {remaining}
          </div>
          <div className="opacity-70">
            Projected {projectedPct}% by reset at the current pace
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

const PROVIDER_LABELS: Record<TRateLimitsProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

const PROVIDER_ICONS = {
  claude: ClaudeCodeIcon,
  codex: OpenAIIcon,
} satisfies Record<TRateLimitsProvider, typeof ClaudeCodeIcon>;

const ProviderRateLimits = ({ provider, data }: { provider: TRateLimitsProvider; data: IRateLimitsData }) => {
  if (!data.five_hour && !data.seven_day) return null;

  const ProviderIcon = PROVIDER_ICONS[provider];

  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted-foreground/5 text-muted-foreground ring-1 ring-muted-foreground/10"
        aria-label={PROVIDER_LABELS[provider]}
        title={PROVIDER_LABELS[provider]}
      >
        <ProviderIcon size={18} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {data.five_hour && <LimitBar label="5h" window={data.five_hour} />}
        {data.seven_day && <LimitBar label="7d" window={data.seven_day} />}
        {(data.scoped ?? []).map((scoped) => (
          <LimitBar key={scoped.label} label="7d" scopeLabel={scoped.label} window={scoped} />
        ))}
      </div>
    </div>
  );
};

const SidebarRateLimits = () => {
  const data = useRateLimitsStore((s) => s.data);
  const [, setTick] = useState(0);
  const providers: TRateLimitsProvider[] = ['claude', 'codex'];
  const visibleProviders = providers.filter((provider) => {
    const limits = data?.[provider];
    return limits && (limits.five_hour || limits.seven_day);
  });

  useEffect(() => {
    if (visibleProviders.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [visibleProviders.length]);

  if (visibleProviders.length === 0) return null;

  return (
    <TooltipProvider delay={200}>
      <div className="px-3 py-1.5">
        {visibleProviders.map((provider, index) => (
          <div
            key={provider}
            className={index > 0 ? 'mt-2 border-t border-sidebar-border/70 pt-2' : undefined}
          >
            <ProviderRateLimits provider={provider} data={data![provider]!} />
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
};

export default SidebarRateLimits;
