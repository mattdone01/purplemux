import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import useTabStore from '@/hooks/use-tab-store';
import { getAgentPanelTypeFromProvider, isAgentPanel, isAgentRunning, tryAgentSwitch } from '@/lib/agent-switch-lock';
import { applyAgentCheckResult, type IAgentCheckResponse } from '@/lib/agent-check';
import {
  AGENT_DISPLAY_NAME,
  AGENT_PANEL_TYPES,
  isAgentPanelType,
  processMatchesPanelType,
  providerIdForPanelType,
  type TAgentPanelType,
} from '@/lib/agent-panel-types';
import { cn } from '@/lib/utils';
import type { TPanelType } from '@/types/terminal';

type TModeButton = {
  type: Extract<TPanelType, 'terminal'> | TAgentPanelType;
  label: string;
  startAction?: boolean;
};

interface IAgentModeSwitcherProps {
  tabId: string;
  paneId?: string;
  sessionName: string;
  panelType: TPanelType;
  onSwitchPanelType: (type: TPanelType) => void;
}

const getButtonLabel = (mode: TModeButton) =>
  mode.startAction ? `Start ${mode.label}` : mode.label;

const getAgentLabel = (panelType: TPanelType): string =>
  (isAgentPanelType(panelType) ? 'Chat' : 'Terminal');

const getCurrentMode = (panelType: TPanelType): TModeButton => {
  if (isAgentPanelType(panelType)) {
    return { type: panelType, label: getAgentLabel(panelType) };
  }
  return { type: 'terminal', label: 'Terminal' };
};

const AgentModeSwitcher = ({
  tabId,
  paneId,
  sessionName,
  panelType,
  onSwitchPanelType,
}: IAgentModeSwitcherProps) => {
  const [open, setOpen] = useState(false);
  const tabEntry = useTabStore((s) => s.tabs[tabId]);
  const runtimeAgentPanelType = getAgentPanelTypeFromProvider(tabEntry?.agentProviderId);
  const hasDetectedAgent = !!runtimeAgentPanelType
    && (
      tabEntry?.agentProcess === true
      || isAgentRunning(tabEntry?.cliState)
      || processMatchesPanelType(runtimeAgentPanelType, tabEntry?.currentProcess)
    );
  const visibleAgentPanelType = isAgentPanel(panelType)
    ? panelType
    : hasDetectedAgent
      ? runtimeAgentPanelType
      : undefined;
  const currentMode = getCurrentMode(panelType);
  const modeButtons: TModeButton[] = [
    { type: 'terminal', label: 'Terminal' },
    ...(visibleAgentPanelType
      ? [{
          type: visibleAgentPanelType,
          label: getAgentLabel(visibleAgentPanelType),
        }]
      : AGENT_PANEL_TYPES.map((type) => ({
          type,
          label: AGENT_DISPLAY_NAME[type],
          startAction: true,
        }))),
  ];

  const refreshDetectedAgent = async () => {
    try {
      const res = await fetch(`/api/check-agent?session=${encodeURIComponent(sessionName)}`);
      if (!res.ok) return;
      const data = await res.json() as IAgentCheckResponse;
      applyAgentCheckResult(tabId, data);
    } catch {
      // keep the last known local state if the live check fails
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setOpen(false);
      return;
    }
    void refreshDetectedAgent().finally(() => setOpen(true));
  };

  const handleSelectMode = (mode: TModeButton) => {
    if (panelType === mode.type) {
      setOpen(false);
      return;
    }
    if (!tryAgentSwitch({
      current: panelType,
      target: mode.type,
      cliState: tabEntry?.cliState,
      agentProcess: tabEntry?.agentProcess,
      runningAgentPanelType: runtimeAgentPanelType,
    })) return;
    setOpen(false);
    if (mode.type === 'terminal' && isAgentPanel(panelType)) {
      useTabStore.getState().setDetectedAgent(tabId, {
        running: true,
        providerId: providerIdForPanelType(panelType),
        panelType,
      });
    }
    if (mode.startAction && isAgentPanelType(mode.type)) {
      window.dispatchEvent(new CustomEvent('purplemux-start-agent', {
        detail: {
          paneId,
          tabId,
          provider: providerIdForPanelType(mode.type),
        },
      }));
      return;
    }
    onSwitchPanelType(mode.type);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className="flex h-5 shrink-0 items-center rounded border border-border/70 bg-background/70 px-1.5 text-[10px] leading-none text-foreground hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Select tab mode"
        title="Select tab mode"
        onClick={(e) => e.stopPropagation()}
      >
        <span>{currentMode.label}</span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-max min-w-[var(--anchor-width)] max-w-[calc(100vw-1rem)] gap-0 p-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        {modeButtons.map((mode) => {
          const active = panelType === mode.type;
          return (
            <button
              key={mode.type}
              type="button"
              className={cn(
                'flex w-full items-center rounded-sm px-2 py-1 text-left text-[11px] leading-4 text-foreground whitespace-nowrap hover:bg-accent',
                active && 'bg-accent font-medium',
              )}
              aria-pressed={active}
              aria-label={getButtonLabel(mode)}
              onClick={(e) => {
                e.stopPropagation();
                handleSelectMode(mode);
              }}
            >
              <span>{getButtonLabel(mode)}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};

export default AgentModeSwitcher;
