import useTabStore from '@/hooks/use-tab-store';
import {
  isAgentPanelType,
  providerIdForPanelType,
  type TAgentPanelType,
} from '@/lib/agent-panel-types';

export type { TAgentPanelType };
export { isAgentPanelType };

export interface IAgentCheckResponse {
  running?: boolean;
  checkedAt?: number;
  sessionId?: unknown;
  resumable?: unknown;
  providerId?: unknown;
  providerDisplayName?: unknown;
  providerPanelType?: unknown;
}

export interface IAgentCheckOutcome {
  running: boolean;
  checkedAt: number;
}

export const applyAgentCheckResult = (
  tabId: string,
  data: IAgentCheckResponse,
): IAgentCheckOutcome => {
  const checkedAt = typeof data.checkedAt === 'number' ? data.checkedAt : Date.now();
  if (data.running === true && isAgentPanelType(data.providerPanelType)) {
    const providerId = typeof data.providerId === 'string' && data.providerId
      ? data.providerId
      : providerIdForPanelType(data.providerPanelType) ?? 'claude';
    const detectedSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined;
    useTabStore.getState().setDetectedAgent(tabId, {
      running: true,
      checkedAt,
      providerId,
      panelType: data.providerPanelType,
      ...(detectedSessionId !== undefined ? { sessionId: detectedSessionId } : {}),
    });
    return { running: true, checkedAt };
  }

  useTabStore.getState().setDetectedAgent(tabId, { running: false, checkedAt });
  return { running: false, checkedAt };
};
