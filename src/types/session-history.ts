export type TSessionHistoryProvider = 'claude' | 'codex' | 'grok';

export interface ISessionHistoryEntry {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceDir: string | null;
  tabId: string;
  providerId: TSessionHistoryProvider;
  agentSessionId: string | null;
  /** @deprecated read-only back-compat for legacy entries on disk; new writes must use agentSessionId. */
  claudeSessionId?: string | null;
  prompt: string | null;
  result: string | null;
  startedAt: number;
  completedAt: number;
  duration: number;
  dismissedAt: number | null;
  toolUsage: Record<string, number>;
  touchedFiles: string[];
  cancelled?: boolean;
}

export interface ISessionHistoryData {
  version: 1;
  entries: ISessionHistoryEntry[];
}
