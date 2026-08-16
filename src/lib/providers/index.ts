import { claudeProvider } from '@/lib/providers/claude';
import { codexProvider } from '@/lib/providers/codex';
import { grokProvider } from '@/lib/providers/grok';
import { registerProvider } from '@/lib/providers/registry';

registerProvider(claudeProvider);
registerProvider(codexProvider);
registerProvider(grokProvider);

export {
  detectAnyActiveSession,
  isAnyAgentRunning,
} from '@/lib/providers/session-scan';
export type {
  IProviderSessionScan,
} from '@/lib/providers/session-scan';

export {
  getProvider,
  getProviderByPanelType,
  getProviderByProcessName,
  listProviders,
  registerProvider,
} from '@/lib/providers/registry';
export type {
  IAgentProvider,
  IAgentLaunchCommandOptions,
  IAgentResumeCommandOptions,
  IAgentSessionWatchOptions,
} from '@/lib/providers/types';
