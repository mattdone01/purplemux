import { memo, useMemo } from 'react';
import { isAgentPanelType } from '@/lib/agent-panel-types';
import { GitCompareArrows, Globe } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useTabStore, { selectTabDisplayStatus } from '@/hooks/use-tab-store';
import ProcessIcon from '@/components/icons/process-icon';
import Spinner from '@/components/ui/spinner';
import type { TTabDisplayStatus, TTerminalStatus } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

interface IWorkspaceStatusIndicatorProps {
  workspaceId: string;
  tabs?: ITab[];
}

const DotByStatus = ({ status, panelType, terminalStatus, process }: { status: TTabDisplayStatus; panelType?: TPanelType; terminalStatus?: TTerminalStatus; process?: string | null }) => {
  let inner: React.ReactNode;

  if (isAgentPanelType(panelType)) {
    if (status === 'busy') {
      inner = <Spinner className="h-2 w-2 text-muted-foreground" />;
    } else if (status === 'ready-for-review') {
      inner = <span className="h-2 w-2 rounded-full bg-claude-active animate-pulse" aria-hidden="true" />;
    } else if (status === 'needs-input') {
      inner = <span className="h-2 w-2 rounded-full bg-ui-amber animate-pulse" aria-hidden="true" />;
    } else if (status === 'unknown') {
      inner = <span className="h-2 w-2 rounded-full bg-muted-foreground/50" aria-hidden="true" />;
    } else {
      inner = <span className="h-2 w-2 rounded-full border border-muted-foreground/40" aria-hidden="true" />;
    }
  } else if (panelType === 'web-browser') {
    inner = <Globe className="h-2.5 w-2.5 text-muted-foreground/50" aria-hidden="true" />;
  } else if (panelType === 'diff') {
    inner = <GitCompareArrows className="h-2.5 w-2.5 text-muted-foreground/50" aria-hidden="true" />;
  } else {
    const colorClass =
      terminalStatus === 'server' ? 'text-ui-green'
      : terminalStatus === 'running' ? 'text-ui-blue'
      : 'text-muted-foreground/50';
    inner = <ProcessIcon process={process} className={`h-2.5 w-2.5 ${colorClass}`} />;
  }

  return (
    <span className="flex h-3 w-3 items-center justify-center">
      {inner}
    </span>
  );
};

const WorkspaceStatusIndicator = ({ workspaceId, tabs: layoutTabs }: IWorkspaceStatusIndicatorProps) => {
  const t = useTranslations('terminal');
  const wsConnected = useTabStore((state) => state.statusWsConnected);
  const tabs = useTabStore((state) => state.tabs);
  const tabOrder = useTabStore((state) => state.tabOrders[workspaceId]);
  const tabEntries = useMemo(() => {
    if (layoutTabs) {
      return layoutTabs.map((tab) => ({
        tabId: tab.id,
        status: selectTabDisplayStatus(tabs, tab.id),
        panelType: tab.panelType ?? tabs[tab.id]?.panelType,
        terminalStatus: tabs[tab.id]?.terminalStatus,
        currentProcess: tabs[tab.id]?.currentProcess,
      }));
    }

    const wsTabIds = new Set<string>();
    for (const [tabId, entry] of Object.entries(tabs)) {
      if (entry.workspaceId === workspaceId) wsTabIds.add(tabId);
    }

    const ordered = (tabOrder ?? []).filter((id) => wsTabIds.has(id));
    for (const id of wsTabIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }

    return ordered.map((tabId) => ({
      tabId,
      status: selectTabDisplayStatus(tabs, tabId),
      panelType: tabs[tabId]?.panelType,
      terminalStatus: tabs[tabId]?.terminalStatus,
      currentProcess: tabs[tabId]?.currentProcess,
    }));
  }, [tabs, tabOrder, workspaceId, layoutTabs]);

  if (wsConnected && tabEntries.length === 0) return null;

  return (
    <span className="mt-1 flex h-3 items-center gap-0.5" aria-label={t('tabStatus')}>
      {tabEntries.map(({ tabId, status, panelType, terminalStatus, currentProcess }) => (
        <DotByStatus key={tabId} status={status} panelType={panelType} terminalStatus={terminalStatus} process={currentProcess} />
      ))}
    </span>
  );
};

export default memo(WorkspaceStatusIndicator);
