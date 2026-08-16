import { useRef, useEffect, useMemo } from 'react';
import { isAgentPanelType } from '@/lib/agent-panel-types';
import { Globe, GitCompareArrows, History } from 'lucide-react';
import useTabStore, { selectTabDisplayStatus } from '@/hooks/use-tab-store';
import { cn } from '@/lib/utils';
import ProcessIcon from '@/components/icons/process-icon';
import Spinner from '@/components/ui/spinner';
import type { IWorkspace, IPaneNode, TPanelType } from '@/types/terminal';

interface IMobileWorkspaceTabBarProps {
  workspaces: IWorkspace[];
  activeWorkspaceId: string | null;
  workspaceLayouts: Record<string, IPaneNode[]>;
  selectedPaneId: string | null;
  selectedTabId: string | null;
  onSelect: (workspaceId: string, paneId: string, tabId: string) => void;
}

interface ITabDot {
  workspaceId: string;
  paneId: string;
  tabId: string;
  panelType?: TPanelType;
}

const MobileWorkspaceTabBar = ({
  workspaces,
  activeWorkspaceId,
  workspaceLayouts,
  selectedPaneId,
  selectedTabId,
  onSelect,
}: IMobileWorkspaceTabBarProps) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  const statusTabs = useTabStore((s) => s.tabs);
  const items = useMemo(() => {
    const result: (ITabDot | 'divider')[] = [];

    for (const ws of workspaces) {
      const panes = workspaceLayouts[ws.id] ?? [];
      const wsTabs: ITabDot[] = [];

      for (const pane of panes) {
        const sorted = [...pane.tabs].sort((a, b) => a.order - b.order);
        for (const tab of sorted) {
          wsTabs.push({ workspaceId: ws.id, paneId: pane.id, tabId: tab.id, panelType: tab.panelType });
        }
      }

      if (wsTabs.length > 0) {
        if (result.length > 0) result.push('divider');
        result.push(...wsTabs);
      }
    }

    return result;
  }, [workspaces, workspaceLayouts]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selectedTabId]);

  const totalTabs = items.filter((i) => i !== 'divider').length;
  if (totalTabs === 0) return null;

  return (
    <div className="shrink-0 border-t bg-background">
      <div
        className="flex h-10 items-center justify-center overflow-x-auto px-4"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
      >
        {items.map((item, i) => {
          if (item === 'divider') {
            return (
              <span
                key={`d-${i}`}
                className="mx-0.5 h-3 w-px shrink-0 bg-border"
              />
            );
          }

          const isActive =
            item.workspaceId === activeWorkspaceId &&
            item.paneId === selectedPaneId &&
            item.tabId === selectedTabId;
          const isAgent = isAgentPanelType(item.panelType);
          const status = selectTabDisplayStatus(statusTabs, item.tabId);
          const termStatus = statusTabs[item.tabId]?.terminalStatus;
          const currentProcess = statusTabs[item.tabId]?.currentProcess;
          const iconColorClass = termStatus === 'server'
            ? 'text-ui-green'
            : termStatus === 'running'
              ? 'text-ui-blue'
              : 'text-muted-foreground/50';

          return (
            <button
              key={item.tabId}
              ref={isActive ? activeRef : undefined}
              className="flex h-8 w-8 shrink-0 items-center justify-center"
              onClick={() => onSelect(item.workspaceId, item.paneId, item.tabId)}
              aria-current={isActive ? 'true' : undefined}
            >
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full',
                  isActive && 'bg-foreground/15',
                )}
              >
                {isAgent && status === 'busy' ? (
                  <Spinner className="h-2 w-2 text-muted-foreground" />
                ) : isAgent && status === 'ready-for-review' ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-claude-active" />
                ) : isAgent && status === 'needs-input' ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-ui-amber" />
                ) : isAgent && status === 'unknown' ? (
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                ) : isAgent ? (
                  <span className="h-2 w-2 rounded-full border border-muted-foreground/40" />
                ) : item.panelType === 'web-browser' ? (
                  <Globe className="h-2.5 w-2.5 text-muted-foreground/50" />
                ) : item.panelType === 'diff' ? (
                  <GitCompareArrows className="h-2.5 w-2.5 text-muted-foreground/50" />
                ) : item.panelType === 'agent-sessions' ? (
                  <History className="h-2.5 w-2.5 text-muted-foreground/50" />
                ) : (
                  <ProcessIcon process={currentProcess} className={cn('h-3 w-3', iconColorClass)} />
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ height: 'env(safe-area-inset-bottom)' }} />
    </div>
  );
};

export default MobileWorkspaceTabBar;
