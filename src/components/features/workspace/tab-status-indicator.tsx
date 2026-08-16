import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { isAgentPanelType } from '@/lib/agent-panel-types';
import Spinner from '@/components/ui/spinner';
import useTabStore, { selectTabDisplayStatus } from '@/hooks/use-tab-store';
import type { TPanelType } from '@/types/terminal';

interface ITabStatusIndicatorProps {
  tabId: string;
  panelType?: TPanelType;
}

const TabStatusIndicator = ({ tabId, panelType }: ITabStatusIndicatorProps) => {
  const t = useTranslations('terminal');
  const status = useTabStore(
    (state) => selectTabDisplayStatus(state.tabs, tabId),
  );

  const isAgent = isAgentPanelType(panelType);
  const visible = isAgent && status !== 'idle';

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden transition-all duration-200 ease-in-out"
      style={{
        width: visible ? 12 : 0,
        marginRight: visible ? 0 : -6,
        opacity: visible ? 1 : 0,
      }}
      aria-hidden={!visible || undefined}
    >
      {!isAgent ? null : status === 'busy' ? (
        <Spinner className="h-2.5 w-2.5 text-muted-foreground" />
      ) : status === 'ready-for-review' ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-claude-active animate-pulse"
          aria-hidden="true"
        />
      ) : status === 'needs-input' ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-ui-amber animate-pulse"
          aria-hidden="true"
        />
      ) : status === 'unknown' ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50"
          aria-hidden="true"
        />
      ) : null}
      {visible && <span className="sr-only">{status === 'busy' ? t('statusBusy') : status === 'needs-input' ? t('statusNeedsInput') : status === 'unknown' ? '?' : t('statusNeedsReview')}</span>}
    </span>
  );
};

export default memo(TabStatusIndicator);
