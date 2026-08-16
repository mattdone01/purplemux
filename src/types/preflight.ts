export interface IToolStatus {
  installed: boolean;
  version: string | null;
}

export interface ICodexStatus extends IToolStatus {
  binaryPath: string | null;
}

/** grok reports the same shape as codex; aliased so the provider reads naturally. */
export type IGrokStatus = ICodexStatus;

export interface IAgentRuntimeToolStatus extends IToolStatus {
  binaryPath: string | null;
  loggedIn?: boolean;
}

export interface IPreflightResult {
  tmux: IToolStatus & { compatible: boolean };
  git: IToolStatus;
  brew?: IToolStatus;
  clt?: { installed: boolean };
}

export interface IRuntimePreflightResult {
  tmux: IToolStatus & { compatible: boolean };
  git: IToolStatus;
  claude: IAgentRuntimeToolStatus;
  codex: IAgentRuntimeToolStatus;
  grok: IAgentRuntimeToolStatus;
}

export const isRuntimeOk = (status: IRuntimePreflightResult): boolean =>
  status.tmux.installed && status.tmux.compatible && status.git.installed;
