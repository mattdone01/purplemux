// The tab inbox (ADR-0012): the one path a server-originated notice takes to an
// agent's composer.

export type TInboxKind = 'note' | 'watch' | 'deploy' | 'mission' | 'resume';

export type TInboxState = 'queued' | 'delivered' | 'held' | 'dropped';

export interface IInboxItem {
  /** `i-<nanoid>`. */
  id: string;
  kind: TInboxKind;
  targetWorkspaceId: string;
  targetTabId: string;
  dedupeKey: string;
  /** Rendered server-side from the kind's fixed template; carries no caller text. */
  line: string;
  createdAt: number;
  /** Not delivered before this time (backoff). */
  notBefore: number;
  /** Refusals so far. */
  attempts: number;
  lastAttemptAt: number | null;
  lastRefusal: string | null;
  state: TInboxState;
  deliveredAt: number | null;
  heldReason: string | null;
  droppedReason: string | null;
  /** A still-queued item is held at this time (24 h after creation). */
  expiresAt: number;
  /** Time of the last state change; terminal items are pruned 7 days after it. */
  transitionAt: number;
}

export interface IInboxState {
  items: IInboxItem[];
}

export type TInboxErrorCode = 'inbox-not-found' | 'inbox-not-held' | 'inbox-field-invalid';
