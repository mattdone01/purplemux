// Notes with acknowledgement (ADR-0013): a body the recipient pulls. Only the
// inbox's fixed one-line notice is ever typed into the recipient's tab.

export type TNoteState = 'queued' | 'delivered' | 'acked' | 'undeliverable' | 'expired';

export interface INoteParty {
  /** null for an admin-token sender. */
  workspaceId: string | null;
  tabId: string | null;
  verified: boolean;
  /** Set only when the sender's tab held `epic:<slug>` at send time. */
  epic: string | null;
}

export interface INoteTarget {
  epic: string | null;
  workspaceId: string | null;
}

export interface INote {
  /** `n-<nanoid>`. */
  id: string;
  from: INoteParty;
  to: INoteTarget;
  /** ≤ 120 characters, control characters removed. Shown by list/show, never typed. */
  subject: string;
  /** ≤ 16 KiB UTF-8. Shown by show only. */
  body: string;
  createdAt: number;
  state: TNoteState;
  /** The tab the note was last routed to. */
  deliveredTo: { workspaceId: string; tabId: string } | null;
  /** When the note was FIRST routed (its inbox notice queued): the sender's clock. A re-route keeps it. */
  routedAt: number | null;
  /** When the notice reached the recipient's composer (the inbox item delivered). */
  deliveredAt: number | null;
  inboxItemId: string | null;
  ackedAt: number | null;
  ackedBy: { workspaceId: string; tabId: string | null } | null;
  ackComment: string | null;
  remindedAt: number | null;
  /** The inbox item of the reminder to the current recipient, so a re-route can withdraw it. Absent in notes stored before it existed. */
  reminderItemId?: string | null;
  senderNotifiedAt: number | null;
  expiredAt: number | null;
  transitionAt: number;
}

export interface INotesState {
  notes: INote[];
}

/** A note without its body: what `note list` returns. */
export type INoteView = Omit<INote, 'body'> & { bodyBytes: number };

export type TNoteErrorCode = 'note-not-found' | 'note-too-large' | 'note-target-missing' | 'forbidden' | 'note-invalid' | 'note-cap';
