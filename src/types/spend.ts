export type TSpendProvider = 'claude' | 'codex' | 'grok';
export type TSpendBy = 'tab' | 'day' | 'model' | 'role' | 'workspace';
export type TSpendPeriod = 'today' | '7d' | '30d';

/** Contract: architecture.md §4.5 (ADR-0030). */
export interface ISpendRow { key: string; label: string; providerId: 'claude' | 'codex' | 'grok' | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number;
  sidechainTokens: number; costUsd: number | null; unpricedTokens: number }
export interface ISpendView { workspaceId: string | 'all'; from: string; to: string; by: 'tab' | 'day' | 'model' | 'role' | 'workspace';
  generatedAt: number; totals: ISpendRow; rows: ISpendRow[]; unattributed: ISpendRow | null;
  roleBasis?: 'current-orchestrator'; dayBasis: { claude: 'message'; codex: 'session-start'; grok: 'session-start' };
  index: { state: 'ready' | 'indexing' | 'unavailable'; filesIndexed: number; filesTotal: number;
           indexedThrough: number | null; error?: string } }

export type ISpendIndexStatus = ISpendView['index'];

/** One burndown day's tokens for the burndown's workspace (`GET /api/mission-control/burndown`). */
export interface ISpendTokensByDay {
  day: string;
  totalTokens: number;
  sidechainTokens: number;
}

/**
 * One indexed usage figure: a Claude bucket (day, model, session, file kind) or a
 * Codex or Grok session. `workspaceId` is `global` for `~/.claude`, and null when
 * only a binding can name the workspace.
 */
export interface ISpendUsage {
  providerId: TSpendProvider;
  workspaceId: string | null;
  sessionId: string;
  day: string;
  model: string;
  sidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  /** Codex and Grok carry their own reader's cost; Claude's comes from `calculateCost`. null = no known price. */
  costUsd?: number | null;
}
