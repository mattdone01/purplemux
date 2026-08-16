import type { IOverviewResponse, IProviderUsage, TByProvider, TStatsProvider } from '@/types/stats';

type TModelTokens = IOverviewResponse['modelTokens'];
type TProviderTokens = Pick<
  IProviderUsage,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
>;

export const createEmptyProviderUsage = (): IProviderUsage => ({
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  sessions: 0,
  messages: 0,
});

export const createEmptyByProvider = (): TByProvider => ({
  claude: createEmptyProviderUsage(),
  codex: createEmptyProviderUsage(),
  grok: createEmptyProviderUsage(),
});

/** Claude rows carry no `provider` tag — only the merged codex and grok rows do. */
export const sumProviderModelTokens = (
  modelTokens: TModelTokens,
  provider: TStatsProvider,
): TProviderTokens => {
  const total: TProviderTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const entry of Object.values(modelTokens)) {
    if ((entry.provider ?? 'claude') !== provider) continue;
    total.inputTokens += entry.input;
    total.outputTokens += entry.output;
    total.cacheReadTokens += entry.cacheRead;
    total.cacheCreationTokens += entry.cacheCreation;
  }
  return total;
};

export const addProviderUsage = (
  byProvider: TByProvider,
  provider: TStatsProvider,
  delta: Partial<IProviderUsage>,
): TByProvider => {
  const current = byProvider[provider];
  return {
    ...byProvider,
    [provider]: {
      totalCost: current.totalCost + (delta.totalCost ?? 0),
      inputTokens: current.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: current.outputTokens + (delta.outputTokens ?? 0),
      cacheReadTokens: current.cacheReadTokens + (delta.cacheReadTokens ?? 0),
      cacheCreationTokens: current.cacheCreationTokens + (delta.cacheCreationTokens ?? 0),
      sessions: current.sessions + (delta.sessions ?? 0),
      messages: current.messages + (delta.messages ?? 0),
    },
  };
};
