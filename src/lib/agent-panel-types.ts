import type { TSessionHistoryProvider } from '@/types/session-history';
import type { TPanelType } from '@/types/terminal';

/**
 * The panel types that host an agent, and their provider ids. Client-safe: the
 * server registry (`@/lib/providers`) pulls in Node-only modules, so the UI
 * reads this table instead of importing a provider.
 */
export const AGENT_PANEL_TYPES = ['claude-code', 'codex-cli', 'grok-cli'] as const;

export type TAgentPanelType = Extract<TPanelType, typeof AGENT_PANEL_TYPES[number]>;

const AGENT_PANEL_TYPE_SET: ReadonlySet<string> = new Set(AGENT_PANEL_TYPES);

export const isAgentPanelType = (value: unknown): value is TAgentPanelType =>
  typeof value === 'string' && AGENT_PANEL_TYPE_SET.has(value);

export const PROVIDER_ID_BY_PANEL_TYPE: Record<TAgentPanelType, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'grok-cli': 'grok',
};

export const AGENT_DISPLAY_NAME: Record<TAgentPanelType, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  'grok-cli': 'Grok',
};

export const providerIdForPanelType = (panelType: TPanelType | undefined): string | undefined =>
  isAgentPanelType(panelType) ? PROVIDER_ID_BY_PANEL_TYPE[panelType] : undefined;

export const panelTypeForProviderId = (providerId: string | undefined): TAgentPanelType | undefined => {
  if (!providerId) return undefined;
  const found = AGENT_PANEL_TYPES.find((panelType) => PROVIDER_ID_BY_PANEL_TYPE[panelType] === providerId);
  return found;
};

export const agentDisplayName = (panelType: TPanelType | undefined): string =>
  isAgentPanelType(panelType) ? AGENT_DISPLAY_NAME[panelType] : '';

/**
 * The foreground process names a running agent can present as. An agent shipped
 * as a bundle reports its runtime rather than its own name — codex as `node` —
 * so a check against the provider id alone sees no agent at all in the common
 * case. Grok Build is a single binary and reports itself, under either of the
 * two names its installer links (`grok` and `agent`).
 */
export const AGENT_PROCESS_NAMES: Record<TAgentPanelType, readonly string[]> = {
  'claude-code': ['claude'],
  'codex-cli': ['codex', 'node'],
  'grok-cli': ['grok', 'agent'],
};

export const processMatchesPanelType = (
  panelType: TPanelType | undefined,
  process: string | undefined | null,
): boolean => {
  if (!process || !isAgentPanelType(panelType)) return false;
  const normalized = process.toLowerCase();
  return AGENT_PROCESS_NAMES[panelType].includes(normalized);
};

/** Narrows a free-form provider id to the ones session history and alerts record. */
export const toSessionHistoryProvider = (
  providerId: string | undefined | null,
): TSessionHistoryProvider =>
  providerId === 'codex' || providerId === 'grok' ? providerId : 'claude';
