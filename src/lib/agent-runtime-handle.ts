import { PROVIDER_ID_BY_PANEL_TYPE, providerIdForPanelType } from '@/lib/agent-panel-types';
import type { TPanelType } from '@/types/terminal';

const GROK_ID = PROVIDER_ID_BY_PANEL_TYPE['grok-cli'];

export interface IRuntimeHandleSource {
  jsonlPath?: string | null;
  sessionId?: string | null;
}

/**
 * The handle a provider reads its runtime view from. File-backed providers pass
 * a transcript path; grok keeps its transcript in SQLite, so its handle is the
 * session id.
 *
 * Every caller that wants a runtime snapshot asks this — a caller that reaches
 * for `jsonlPath` on its own silently returns nothing for grok, which is how
 * `readTabMetadata` came to leave grok tabs permanently blank.
 */
export const runtimeHandleFor = (
  providerId: string | null | undefined,
  { jsonlPath, sessionId }: IRuntimeHandleSource,
): string | null => (providerId === GROK_ID ? sessionId ?? null : jsonlPath ?? null);

/** The provider a status entry belongs to, from its recorded id or its panel type. */
export const runtimeProviderId = (
  agentProviderId: string | null | undefined,
  panelType: TPanelType | undefined,
): string | null => agentProviderId ?? providerIdForPanelType(panelType) ?? null;
