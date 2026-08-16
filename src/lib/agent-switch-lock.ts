import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import type { TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import {
  agentDisplayName,
  isAgentPanelType,
  panelTypeForProviderId,
  type TAgentPanelType,
} from '@/lib/agent-panel-types';

export const isAgentPanel = (
  panelType: TPanelType | undefined,
): panelType is TAgentPanelType => isAgentPanelType(panelType);

export const isAgentRunning = (cliState: TCliState | undefined): boolean =>
  cliState !== undefined && cliState !== 'inactive' && cliState !== 'unknown';

export const getAgentPanelTypeFromProvider = panelTypeForProviderId;

interface IAgentSwitchInput {
  current: TPanelType | undefined;
  target: TPanelType;
  cliState: TCliState | undefined;
  agentProcess?: boolean | null | undefined;
  runningAgentPanelType?: TAgentPanelType | undefined;
}

export const isAgentSwitchBlocked = ({
  current,
  target,
  cliState,
  agentProcess,
  runningAgentPanelType,
}: IAgentSwitchInput): boolean => {
  if (!current || current === target) return false;
  if (agentProcess !== true && !isAgentRunning(cliState)) return false;
  if (isAgentPanel(current) && isAgentPanel(target)) return true;
  if (current === 'terminal' && isAgentPanel(target) && runningAgentPanelType) {
    return target !== runningAgentPanelType;
  }
  return false;
};

export const tryAgentSwitch = (input: IAgentSwitchInput): boolean => {
  if (!isAgentSwitchBlocked(input)) return true;
  const name = agentDisplayName(isAgentPanel(input.current) ? input.current : input.runningAgentPanelType);
  toast.error(t('terminal', 'switchAgentBlocked').replace('{name}', name), {
    id: 'agent-switch-blocked',
    duration: 5000,
  });
  return false;
};
