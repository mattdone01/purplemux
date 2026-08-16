import { getProviderByPanelType } from '@/lib/providers';
import type { IAgentProvider } from '@/lib/providers';

export type TAgentAvailabilityFailureCode = 'agent-not-installed' | 'agent-path-missing' | 'agent-not-logged-in';

export interface IAgentAvailabilityOk {
  ok: true;
  provider: IAgentProvider | null;
}

export interface IAgentAvailabilityFailure {
  ok: false;
  status: 409;
  code: TAgentAvailabilityFailureCode;
  providerId: string;
  providerDisplayName: string;
  panelType: string;
  suggestedCommand: 'claude' | 'claude-path' | null;
}

export type TAgentAvailability = IAgentAvailabilityOk | IAgentAvailabilityFailure;

export const checkAgentAvailabilityForPanelType = async (
  panelType: string | undefined,
): Promise<TAgentAvailability> => {
  const provider = getProviderByPanelType(panelType);
  if (!provider) return { ok: true, provider: null };

  const status = await provider.preflight();
  if (status.installed) {
    // Grok Build refuses to open a session without a signed-in token, so
    // launching one would drop the user into an error screen inside the pane.
    if (provider.id === 'grok' && !status.loggedIn) {
      return {
        ok: false,
        status: 409,
        code: 'agent-not-logged-in',
        providerId: provider.id,
        providerDisplayName: provider.displayName,
        panelType: provider.panelType,
        suggestedCommand: null,
      };
    }
    return { ok: true, provider };
  }

  const isPathMissing = provider.id === 'claude' && !!status.binaryPath;
  return {
    ok: false,
    status: 409,
    code: isPathMissing ? 'agent-path-missing' : 'agent-not-installed',
    providerId: provider.id,
    providerDisplayName: provider.displayName,
    panelType: provider.panelType,
    suggestedCommand: isPathMissing ? 'claude-path' : provider.id === 'claude' ? 'claude' : null,
  };
};

export const toAgentAvailabilityError = (availability: IAgentAvailabilityFailure) => ({
  error: availability.code,
  providerId: availability.providerId,
  providerDisplayName: availability.providerDisplayName,
  panelType: availability.panelType,
  suggestedCommand: availability.suggestedCommand,
});
