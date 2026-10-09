export interface IBurndownDoneEvent {
  at: string;
  points: number;
}

export interface IBurndownEpic {
  slug: string;
  name: string;
  stories: number;
  unpointed: number;
  total: number;
  burned: number;
  remaining: number;
  pct: number;
  in_progress: number;
  blocked: number;
  done_events: IBurndownDoneEvent[];
  undated_burned: number;
}

export interface IBurndownHistoryRow {
  at: string;
  slug: string;
  total: number;
  burned: number;
  remaining: number;
  pct: number;
  stories: number;
  unpointed: number;
}

/** The Scrum Master generator's `burndown.json`, field names as it writes them. */
export interface IBurndownSnapshot {
  generated_at: string;
  epics: IBurndownEpic[];
  history: IBurndownHistoryRow[];
}

export interface IBurndownRecord {
  workspaceId: string;
  receivedAt: number;
  snapshot: IBurndownSnapshot;
}

export interface IMissionBurndownResponse {
  workspaceId: string | null;
  burndown: IBurndownRecord | null;
}
