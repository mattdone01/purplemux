// The `tab restart` answer (ADR-0028; architecture §4.3). The CLI route and the
// cookie route answer the same body; the phone mirrors it (story 15).

/** `cwd-lost`: the tab's cwd was gone, so the session started in a parent directory and the agent started fresh. */
export type TRestartResumeSkipped = 'clear' | 'no-session' | 'remote' | 'cwd-lost';

export interface IRestartReaped {
  killed: number;
  survivors: number;
}

export interface IRestartTabAnswer {
  ok: true;
  workspaceId: string;
  tabId: string;
  resumed: boolean;
  resumeSkipped?: TRestartResumeSkipped;
  identity: 'launch' | 'hook' | 'none';
  reaped: IRestartReaped;
  launchState?: 'active' | 'held';
}
