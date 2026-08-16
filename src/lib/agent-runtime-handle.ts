import { providerIdForPanelType } from '@/lib/agent-panel-types';
import type { TPanelType } from '@/types/terminal';

export interface IRuntimeHandleSource {
  jsonlPath?: string | null;
  sessionId?: string | null;
}

/**
 * The handle a provider reads its runtime view from. Every provider is now
 * file-backed — grok's ACP `updates.jsonl` included — so the handle is the
 * transcript path.
 *
 * The indirection stays because every caller that wants a runtime snapshot asks
 * through it: a provider whose handle is not a path would otherwise have to be
 * special-cased at each call site, which is how `readTabMetadata` once came to
 * leave grok tabs permanently blank.
 */
export const runtimeHandleFor = (
  _providerId: string | null | undefined,
  { jsonlPath }: IRuntimeHandleSource,
): string | null => jsonlPath ?? null;

/** The provider a status entry belongs to, from its recorded id or its panel type. */
export const runtimeProviderId = (
  agentProviderId: string | null | undefined,
  panelType: TPanelType | undefined,
): string | null => agentProviderId ?? providerIdForPanelType(panelType) ?? null;
