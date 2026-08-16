import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import GrokIcon from '@/components/icons/grok-icon';
import useTabStore, { selectSessionView } from '@/hooks/use-tab-store';
import useTimeline from '@/hooks/use-timeline';
import useSessionMeta from '@/hooks/use-session-meta';
import useGitBranch from '@/hooks/use-git-branch';
import useGitStatus from '@/hooks/use-git-status';
import useTmuxInfo from '@/hooks/use-tmux-info';
import useQuickPrompts from '@/hooks/use-quick-prompts';
import TimelineView from '@/components/features/timeline/timeline-view';
import WebInputBar from '@/components/features/workspace/web-input-bar';
import QuickPromptBar from '@/components/features/workspace/quick-prompt-bar';
import { MetaCompact } from '@/components/features/workspace/session-meta-content';
import MobileMetaSheet from './mobile-meta-sheet';

interface IMobileGrokPanelProps {
  tabId?: string;
  wsId?: string;
  sessionName?: string;
  sendStdin: (data: string) => void;
  terminalWsConnected: boolean;
  focusTerminal: () => void;
  focusInputRef: React.MutableRefObject<(() => void) | undefined>;
  setInputValueRef: React.MutableRefObject<((v: string) => void) | undefined>;
  onNewSession?: () => void;
}

/**
 * Mobile chat face for a grok tab. The message-count sheet is driven from the
 * counts the timeline already carries rather than from a separate transcript
 * read, so it costs nothing on a tab that is already streaming.
 */
const MobileGrokPanel = ({
  tabId,
  wsId,
  sessionName,
  sendStdin,
  terminalWsConnected,
  focusTerminal,
  focusInputRef,
  setInputValueRef,
  onNewSession,
}: IMobileGrokPanelProps) => {
  const t = useTranslations('terminal');
  const agentProcess = useTabStore((s) => (tabId ? s.tabs[tabId]?.agentProcess ?? null : null));
  const agentInstalled = useTabStore((s) => (tabId ? s.tabs[tabId]?.agentInstalled ?? true : true));
  const cliState = useTabStore((s) => (tabId ? s.tabs[tabId]?.cliState ?? 'inactive' : 'inactive'));
  const compactingSince = useTabStore((s) => (tabId ? s.tabs[tabId]?.compactingSince ?? null : null));
  const grokSessionId = useTabStore((s) => (tabId ? s.tabs[tabId]?.agentSessionId ?? null : null));
  const tabAgentSummary = useTabStore((s) => (tabId ? s.tabs[tabId]?.agentSummary ?? null : null));
  const tabLastUserMessage = useTabStore((s) => (tabId ? s.tabs[tabId]?.lastUserMessage ?? null : null));
  const view = useTabStore((s) => (tabId ? selectSessionView(s.tabs, tabId) : 'timeline' as const));
  const [metaSheetOpen, setMetaSheetOpen] = useState(false);
  const scrollToBottomRef = useRef<(() => void) | undefined>(undefined);
  const { prompts: quickPrompts } = useQuickPrompts();

  const handleScrollToBottom = useCallback(() => {
    if (cliState !== 'idle') return;
    scrollToBottomRef.current?.();
  }, [cliState]);

  const handleSelectQuickPrompt = useCallback((prompt: string) => {
    setInputValueRef.current?.(prompt);
    focusInputRef.current?.();
  }, [setInputValueRef, focusInputRef]);

  const {
    entries,
    tasks,
    sessionId,
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
    sessionName: sessionName ?? '',
    agentSessionId: grokSessionId,
    panelType: 'grok-cli',
    enabled: !!sessionName,
    onSync: tabId ? (state) => {
      const checkedAt = Date.now();
      if (state.agentProcess !== null) {
        useTabStore.getState().setAgentProcess(tabId, state.agentProcess, checkedAt);
      }
      if (!state.agentInstalled) {
        useTabStore.getState().setAgentInstalled(tabId, false);
      }
      useTabStore.getState().setTimelineLoading(tabId, state.isLoading);
    } : undefined,
    getCliState: tabId ? () => useTabStore.getState().tabs[tabId]?.cliState : undefined,
  });

  const { meta } = useSessionMeta(entries, sessionSummary, initMeta, sessionStats, tabAgentSummary, tabLastUserMessage);
  const { branch, isLoading: isBranchLoading } = useGitBranch(sessionName ?? '');
  const { status: gitStatus } = useGitStatus(sessionName ?? '', metaSheetOpen);
  const tmuxInfo = useTmuxInfo(sessionName ?? '', metaSheetOpen);

  if (!agentInstalled) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-muted-foreground"
        role="status"
      >
        <GrokIcon size={32} className="text-muted-foreground/60" />
        <span className="text-sm font-medium text-foreground">{t('grokNotInstalled')}</span>
      </div>
    );
  }

  if (cliState === 'inactive' && agentProcess === false && !grokSessionId && !isTimelineLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-muted px-6 text-center" role="status">
        <GrokIcon size={32} className="text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">{t('grokInactiveMessage')}</p>
        {onNewSession && (
          <Button size="default" className="min-h-11" onClick={onNewSession}>
            <Plus className="size-4" />
            {t('grokStartSession')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted">
      <div
        className="flex shrink-0 cursor-pointer items-center justify-between border-b px-4 py-1.5 hover:bg-muted/30"
        role="button"
        tabIndex={0}
        onClick={() => setMetaSheetOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setMetaSheetOpen(true);
          }
        }}
      >
        <MetaCompact
          title={meta.title}
          totalCost={meta.totalCost}
          branch={branch}
          usedPercentage={meta.usedPercentage}
          currentContextTokens={meta.currentContextTokens}
          contextWindowSize={meta.contextWindowSize}
        />
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
      </div>
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
      <div className="shrink-0 pb-3">
        <WebInputBar
          tabId={tabId}
          wsId={wsId}
          sessionName={sessionName}
          agentSessionId={grokSessionId}
          provider="grok"
          cliState={cliState}
          sendStdin={sendStdin}
          terminalWsConnected={terminalWsConnected}
          visible={view === 'timeline'}
          focusTerminal={focusTerminal}
          focusInputRef={focusInputRef}
          setInputValueRef={setInputValueRef}
          maxRows={3}
          onSend={handleScrollToBottom}
          onOptimisticSend={addPendingUserMessage}
          onAddPendingMessage={addPendingUserMessage}
          onRemovePendingMessage={removePendingUserMessage}
        />
        <QuickPromptBar
          prompts={quickPrompts}
          visible={view === 'timeline'}
          onSelect={handleSelectQuickPrompt}
        />
      </div>
      <MobileMetaSheet
        open={metaSheetOpen}
        onOpenChange={setMetaSheetOpen}
        meta={meta}
        toolCount={null}
        toolBreakdown={null}
        branch={branch}
        isBranchLoading={isBranchLoading}
        sessionId={sessionId}
        gitStatus={gitStatus}
        tmuxInfo={tmuxInfo}
      />
    </div>
  );
};

export default MobileGrokPanel;
