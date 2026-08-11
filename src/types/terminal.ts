import type { TCliState } from '@/types/timeline';

export type TConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'session-ended';

export type TDisconnectReason = 'max-connections' | 'pty-error' | 'session-not-found' | 'reconnect-exhausted' | null;

export type TPanelType = 'terminal' | 'claude-code' | 'codex-cli' | 'agent-sessions' | 'web-browser' | 'diff';
export type TDiffViewMode = 'split' | 'unified';
export type TDiffTab = 'changes' | 'history';

export interface IDiffSettings {
  activeTab?: TDiffTab;
  viewMode?: TDiffViewMode;
  panelOpen?: boolean;
  panelSize?: number;
}

export interface IAgentState {
  providerId: string;
  sessionId: string | null;
  jsonlPath: string | null;
  summary: string | null;
}

export interface ITab {
  id: string;
  sessionName: string;
  name: string;
  order: number;
  title?: string;
  cwd?: string;
  panelType?: TPanelType;
  agentState?: IAgentState;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeSessionId?: string | null;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeJsonlPath?: string | null;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeSummary?: string | null;
  lastUserMessage?: string | null;
  lastCommand?: string | null;
  /**
   * Path globs this tab is expected to edit, relative to its cwd. The signal
   * engine reports an edit outside them as off-scope. purplemux never derives
   * this — a caller supplies it at tab create, so no workflow convention leaks
   * in here. Absent means the off-scope detector stays inert for this tab.
   */
  scope?: string[];
  cliState?: TCliState;
  dismissedAt?: number | null;
  webUrl?: string | null;
  terminalRatio?: number;
  terminalCollapsed?: boolean;
}

export interface ISplitNode {
  type: 'split';
  orientation: 'horizontal' | 'vertical';
  ratio: number;
  children: [TLayoutNode, TLayoutNode];
}

export interface IPaneNode {
  type: 'pane';
  id: string;
  tabs: ITab[];
  activeTabId: string | null;
}

export type TLayoutNode = ISplitNode | IPaneNode;

export interface ILayoutData {
  root: TLayoutNode;
  activePaneId: string | null;
  diffSettings?: IDiffSettings;
  updatedAt: string;
}

export interface IWorkspaceOrchestration {
  enabled: boolean;
  orchestratorTabId: string | null;
  kickoffTemplate?: string | null;
}

export interface IWorkspace {
  id: string;
  name: string;
  directories: string[];
  groupId?: string | null;
  orchestration?: IWorkspaceOrchestration;
  /**
   * Workspace ids permitted to reach INTO this one over the CLI API. Empty or
   * absent means no cross-workspace access, which is the default: an agent's
   * token is confined to the workspace whose tab it runs in.
   */
  allowedPeers?: string[];
}

export interface IWorkspaceGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface IWorkspacesData {
  workspaces: IWorkspace[];
  groups?: IWorkspaceGroup[];
  activeWorkspaceId?: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  updatedAt: string;
}
