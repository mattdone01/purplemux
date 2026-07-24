import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { X, Globe, GitCompareArrows, History, Crown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import ClaudeCodeIcon from '@/components/icons/claude-code-icon';
import OpenAIIcon from '@/components/icons/openai-icon';
import ProcessIcon from '@/components/icons/process-icon';
import { cn } from '@/lib/utils';
import type { ITab } from '@/types/terminal';
import TabStatusIndicator from '@/components/features/workspace/tab-status-indicator';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { useLayoutStore } from '@/hooks/use-layout';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { patchWorkspaceOrchestration } from '@/lib/orchestration-client';

interface IPaneTabItemProps {
  tab: ITab;
  isActive: boolean;
  isDragging: boolean;
  dropSide: 'left' | 'right' | null;
  displayTitle?: string;
  currentProcess?: string;
  modeSwitcher?: ReactNode;
  onSwitch: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onFocusPane: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
}

const PaneTabItem = ({
  tab,
  isActive,
  isDragging,
  dropSide,
  displayTitle,
  currentProcess,
  modeSwitcher,
  onSwitch,
  onDelete,
  onRename,
  onFocusPane,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
}: IPaneTabItemProps) => {
  const t = useTranslations('terminal');
  const to = useTranslations('orchestration');
  const wsId = useLayoutStore((s) => s.workspaceId);
  const orchestration = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === wsId)?.orchestration);
  const isAgentTab = tab.panelType === 'claude-code' || tab.panelType === 'codex-cli';
  const isOrchestrator = !!orchestration?.enabled && orchestration.orchestratorTabId === tab.id;
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [isEditing]);

  const startEditing = () => {
    setIsEditing(true);
    setEditName(tab.name);
  };

  const confirmRename = () => {
    const trimmed = editName.trim();
    setIsEditing(false);
    if (trimmed !== tab.name) {
      onRename(trimmed);
    }
  };

  const typeDisplayName = tab.panelType === 'agent-sessions' ? t('sessionList') : '';
  const displayName = tab.name || typeDisplayName || displayTitle || '';

  const handleToggleOrchestrator = () => {
    if (!wsId) return;
    void patchWorkspaceOrchestration(
      wsId,
      isOrchestrator
        ? { enabled: false, orchestratorTabId: null }
        : { enabled: true, orchestratorTabId: tab.id },
    );
  };

  const tabEl = (
    <div
      data-tab-id={tab.id}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      className={cn(
        'group relative flex min-w-[104px] max-w-[170px] cursor-pointer items-center gap-1 border-b-2 px-2 text-xs select-none',
        isActive && modeSwitcher && 'min-w-[136px] max-w-[210px] pr-1',
        isActive
          ? 'border-b-accent-color bg-secondary text-foreground'
          : 'border-b-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        isDragging && 'opacity-30',
      )}
      onClick={() => {
        if (!isEditing && !isActive) onSwitch();
        onFocusPane();
      }}
      onDoubleClick={startEditing}
      draggable={!isEditing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dropSide === 'left' && (
        <div className="absolute top-1 bottom-1 left-0 w-0.5 bg-ui-blue" />
      )}

      {isEditing ? (
        <input
          ref={inputRef}
          className="w-full min-w-0 border-b border-accent-color bg-transparent text-xs text-foreground outline-none"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirmRename();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          onBlur={confirmRename}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <TabStatusIndicator tabId={tab.id} panelType={tab.panelType} />
          {isOrchestrator && (
            <Crown className="h-3 w-3 shrink-0 text-ui-amber" aria-label={to('orchestratorBadge')} />
          )}
          {tab.panelType === 'claude-code' ? (
            <ClaudeCodeIcon className="mx-0.5 h-3 w-3 shrink-0" />
          ) : tab.panelType === 'codex-cli' ? (
            <OpenAIIcon className="mx-0.5 h-3 w-3 shrink-0 text-foreground" aria-label="Codex" />
          ) : tab.panelType === 'web-browser' ? (
            <Globe className="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          ) : tab.panelType === 'diff' ? (
            <GitCompareArrows className="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          ) : tab.panelType === 'agent-sessions' ? (
            <History className="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ProcessIcon
              process={currentProcess ?? displayTitle}
              className="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground"
            />
          )}
          <span
            className={cn(
              'mr-1 min-w-0 truncate',
              displayName ? 'opacity-100' : 'opacity-0',
            )}
          >
            {displayName}
          </span>
          {isActive && modeSwitcher}
        </>
      )}

      <button
        className={cn(
          '-mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground',
          isActive ? 'visible' : 'invisible group-hover:visible',
        )}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={t('closeTabLabel')}
      >
        <X className="h-3 w-3" />
      </button>

      {dropSide === 'right' && (
        <div className="absolute top-1 right-0 bottom-1 w-0.5 bg-ui-blue" />
      )}
    </div>
  );

  if (!isAgentTab) return tabEl;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={tabEl} />
      <ContextMenuContent>
        <ContextMenuItem onClick={handleToggleOrchestrator}>
          <Crown className="mr-2 h-3.5 w-3.5" />
          {isOrchestrator ? to('unsetOrchestrator') : to('setAsOrchestrator')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default PaneTabItem;
