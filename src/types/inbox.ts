// The tab inbox (ADR-0012): the one path a server-originated notice takes to an
// agent's composer.

export type TInboxKind = 'note' | 'watch' | 'deploy' | 'mission' | 'resume' | 'message';

export type TInboxState = 'queued' | 'delivered' | 'held' | 'dropped';

/**
 * What a sender reads for one message (ADR-0050): the stored state, with `dropped` split into
 * `expired` (its TTL passed) and `refused` (every other final refusal, superseded included).
 */
export type TDeliveryState = 'queued' | 'delivered' | 'held' | 'refused' | 'expired';

/**
 * A `tab send` body queued for a busy agent tab (ADR-0050). It is typed below the item's fixed header line only when
 * the sender workspace is the target workspace (the ADR-0012 amendment).
 */
export interface IInboxMessage {
  fromWorkspaceId: string;
  /** Null for a workspace token that names no tab. */
  fromTabId: string | null;
  body: string;
  /** The tmux session the send resolved; a replaced session refuses the item `target-changed`. */
  targetSessionName: string;
  supersedeKey: string | null;
  /** Set under the store lock, inside the dispatch lock, just before the paste: a claimed item is typed at most once. */
  claimedAt: number | null;
}

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
  /**
   * Optional: a queued or held item is dropped (`stale`) at this time instead of typed, because its
   * line would be untrue after it (a deploy notice after its restart window). Absent: never stale.
   */
  staleAt?: number | null;
  /** Time of the last state change; terminal items are pruned 7 days after it. */
  transitionAt: number;
  /** Present on the kind `message` only. */
  message?: IInboxMessage;
}

export interface IInboxState {
  items: IInboxItem[];
}

export type TInboxErrorCode = 'inbox-not-found' | 'inbox-not-held' | 'inbox-field-invalid' | 'inbox-not-retryable'
  | 'message-queue-full' | 'message-workspace-mismatch';

/** A hold the human retry refuses (ADR-0029 §7, consult Q1): the leading token of its `heldReason`. */
export type THumanRetryRefusal = 'stranded-in-composer' | 'transport-uncertain' | 'target-not-agent';
