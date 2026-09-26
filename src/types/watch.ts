export type TWatchKind = 'pr' | 'ref' | 'lease';
export type TWatchUntil = 'merged' | 'closed' | 'head-moved' | 'checks-settled' | 'moved' | 'free';
/** A server-classified failure; the raw `gh` text is shown by `watch list`, never typed. */
export type TWatchFailure = 'http-404' | 'http-403' | 'timeout' | 'auth' | 'gh-missing' | 'other';

export interface IWatch {
  /** `w-<nanoid>`. */
  id: string;
  workspaceId: string;
  tabId: string;
  kind: TWatchKind;
  /** `owner/repo#n`, `owner/repo@ref` or a lease name, grammar-checked. */
  target: string;
  until: TWatchUntil;
  /** The head sha (pr) or ref sha (ref) when the watch was made; null for a lease watch. */
  baseline: string | null;
  intervalS: number;
  createdAt: number;
  expiresAt: number;
  lastCheckedAt: number | null;
  /** Consecutive failures. */
  failures: number;
  /** True once the failing notice went out; reset by a success. */
  failingNotified: boolean;
  lastError: { code: TWatchFailure; message: string; at: number } | null;
  /** Caller text, ≤ 80 characters: shown by `watch list`, never typed. */
  label: string | null;
}

export interface IWatchesState {
  watches: IWatch[];
}

export interface IWatchView extends IWatch {
  ageSeconds: number;
  expiresInSeconds: number;
  /** live, closed or unknown (its workspace layout could not be read). */
  owner: 'live' | 'closed' | 'unknown';
}

export type TWatchErrorCode = 'watch-invalid' | 'watch-cap' | 'watch-not-found' | 'gh-unavailable' | 'forbidden' | 'caller-unresolved';
