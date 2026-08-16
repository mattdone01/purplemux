import { useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import GrokIcon from '@/components/icons/grok-icon';
import useTabStore from '@/hooks/use-tab-store';
import useTimeline from '@/hooks/use-timeline';
import { useSessionMetaCompute } from '@/hooks/use-session-meta';
import TimelineView from '@/components/features/timeline/timeline-view';
import SessionMetaBar, { SessionMetaBarSkeleton } from '@/components/features/workspace/session-meta-bar';

interface IGrokPanelProps {
  tabId: string;
  sessionName: string;
  className?: string;
  onNewSession?: () => void;
  scrollToBottomRef?: React.MutableRefObject<(() => void) | undefined>;
  addPendingMessageRef?: React.MutableRefObject<((text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }) => string) | undefined>;
  removePendingMessageRef?: React.MutableRefObject<((id: string) => void) | undefined>;
}

/**
 * grok's chat face. It carries none of the Codex panel's boot-progress,
 * update-prompt or session-list machinery: grok fires `SessionStart` on the
 * first prompt rather than at launch, so a boot detector would sit on a tab
 * that is already usable, and grok's session list is not exposed over an API
 * purplemux can read.
 */
const GrokPanel = ({
  tabId,
  sessionName,
  className,
  onNewSession,
  scrollToBottomRef,
  addPendingMessageRef,
  removePendingMessageRef,
}: IGrokPanelProps) => {
  const t = useTranslations('terminal');
  const agentProcess = useTabStore((s) => s.tabs[tabId]?.agentProcess ?? null);
  const agentInstalled = useTabStore((s) => s.tabs[tabId]?.agentInstalled ?? true);
  const cliState = useTabStore((s) => s.tabs[tabId]?.cliState ?? 'inactive');
  const compactingSince = useTabStore((s) => s.tabs[tabId]?.compactingSince ?? null);
  const grokSessionId = useTabStore((s) => s.tabs[tabId]?.agentSessionId ?? null);
  const cachedSessionMeta = useTabStore((s) => s.tabs[tabId]?.sessionMetaCache ?? null);
  const tabAgentSummary = useTabStore((s) => s.tabs[tabId]?.agentSummary ?? null);
  const tabLastUserMessage = useTabStore((s) => s.tabs[tabId]?.lastUserMessage ?? null);

  const {
    entries,
    tasks,
    sessionId,
    jsonlPath,
    sessionSummary,
    initMeta,
    sessionStats,
    wsStatus,
    isLoading: isTimelineLoading,
    error: timelineError,
    loadMore: loadMoreTimeline,
    hasMore: timelineHasMore,
    retrySession,
    addPendingUserMessage,
    removePendingUserMessage,
  } = useTimeline({
    sessionName,
    agentSessionId: grokSessionId,
    panelType: 'grok-cli',
    enabled: !!sessionName,
    onSync: (state) => {
      const checkedAt = Date.now();
      if (state.agentProcess !== null) {
        useTabStore.getState().setAgentProcess(tabId, state.agentProcess, checkedAt);
      }
      if (!state.agentInstalled) {
        useTabStore.getState().setAgentInstalled(tabId, false);
      }
      useTabStore.getState().setTimelineLoading(tabId, state.isLoading);
    },
    getCliState: () => useTabStore.getState().tabs[tabId]?.cliState,
  });

  useEffect(() => {
    if (addPendingMessageRef) addPendingMessageRef.current = addPendingUserMessage;
    if (removePendingMessageRef) removePendingMessageRef.current = removePendingUserMessage;
    return () => {
      if (addPendingMessageRef) addPendingMessageRef.current = undefined;
      if (removePendingMessageRef) removePendingMessageRef.current = undefined;
    };
  }, [addPendingMessageRef, removePendingMessageRef, addPendingUserMessage, removePendingUserMessage]);

  const isHeaderLoading = agentProcess === null || (entries.length === 0 && isTimelineLoading);
  const freshMeta = useSessionMetaCompute(entries, sessionSummary, initMeta, sessionStats, tabAgentSummary, tabLastUserMessage);

  useEffect(() => {
    if (!isHeaderLoading) {
      useTabStore.getState().setSessionMetaCache(tabId, { meta: freshMeta, sessionId, jsonlPath });
    }
  }, [isHeaderLoading, freshMeta, sessionId, jsonlPath, tabId]);

  const handleStart = useCallback(() => {
    onNewSession?.();
  }, [onNewSession]);

  if (!agentInstalled) {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground',
          className,
        )}
        role="status"
      >
        <GrokIcon size={32} className="text-muted-foreground/60" />
        <span className="text-sm font-medium text-foreground">{t('grokNotInstalled')}</span>
      </div>
    );
  }

  if (cliState === 'inactive' && agentProcess === false && !grokSessionId && !isTimelineLoading) {
    return (
      <div
        className={cn('flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center', className)}
        role="status"
      >
        <GrokIcon size={32} className="text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">{t('grokInactiveMessage')}</p>
        {onNewSession && (
          <Button size="sm" onClick={handleStart}>
            <Plus className="size-3.5" />
            {t('grokStartSession')}
          </Button>
        )}
      </div>
    );
  }

  const displayMeta = isHeaderLoading
    ? cachedSessionMeta
    : { meta: freshMeta, sessionId, jsonlPath };

  return (
    <div className={cn('flex min-h-0 w-full flex-1 flex-col', className)}>
      {displayMeta ? (
        <SessionMetaBar
          meta={displayMeta.meta}
          sessionName={sessionName}
          sessionId={displayMeta.sessionId}
          jsonlPath={displayMeta.jsonlPath}
        />
      ) : (
        <SessionMetaBarSkeleton />
      )}
      <div className="min-h-0 flex-1">
        <TimelineView
          entries={entries}
          tasks={tasks}
          sessionId={sessionId}
          sessionName={sessionName}
          tabId={tabId}
          initMeta={initMeta}
          sessionStats={sessionStats}
          cliState={cliState}
          compactingSince={compactingSince}
          wsStatus={wsStatus}
          isLoading={isTimelineLoading}
          error={timelineError}
          onRetry={retrySession}
          onLoadMore={loadMoreTimeline}
          hasMore={timelineHasMore}
          scrollToBottomRef={scrollToBottomRef}
        />
      </div>
    </div>
  );
};

export default GrokPanel;
