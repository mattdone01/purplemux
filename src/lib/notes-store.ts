import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { EPIC_SLUG } from '@/lib/lease-policy';
import type { INote, INoteParty, INoteTarget, INotesState, INoteView, TNoteErrorCode } from '@/types/note';

// Notes with acknowledgement (ADR-0013). Pure state transitions first, then the
// one file store. Routing and delivery live in notes-service.ts.

export class NoteError extends Error {
  constructor(readonly code: TNoteErrorCode, message: string) {
    super(message);
  }
}

export const NOTE_SUBJECT_MAX = 120;
export const NOTE_BODY_MAX_BYTES = 16 * 1024;
export const NOTE_COMMENT_MAX = 500;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** One reminder to the recipient this long after the notice reached its composer. */
export const NOTE_REMIND_MS = 30 * MIN;
/** One notice to the sender this long after the first routing, if still unacked; once per note. */
export const NOTE_SENDER_NOTICE_MS = 60 * MIN;
/** A note unacked (or undeliverable) this long after creation expires. */
export const NOTE_EXPIRE_MS = 14 * DAY;
/** Acked and expired notes are pruned this long after their transition. */
export const NOTE_PRUNE_MS = 14 * DAY;

export const OPEN_STATES = new Set(['queued', 'delivered', 'undeliverable']);
/** Open notes one sender may have at a time (queued, delivered or undeliverable). */
export const NOTE_OPEN_PER_SENDER = 50;
const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]{1,32}$/;
const NOTE_ID = /^n-[A-Za-z0-9_-]{4,32}$/;

export const isNoteId = (value: unknown): value is string => typeof value === 'string' && NOTE_ID.test(value);
export const isEpicSlug = (value: unknown): value is string => typeof value === 'string' && EPIC_SLUG.test(value);

/**
 * Control and format characters (newlines, escapes, bidi overrides) are removed
 * and whitespace collapsed. The subject is shown by list and show, never typed;
 * this keeps it one readable line wherever it is printed.
 */
export const cleanSubject = (raw: unknown): string => {
  if (typeof raw !== 'string') throw new NoteError('note-invalid', 'subject must be text');
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new NoteError('note-invalid', 'subject is required');
  return [...clean].slice(0, NOTE_SUBJECT_MAX).join('');
};

export const checkBody = (raw: unknown): string => {
  if (typeof raw !== 'string' || !raw.trim()) throw new NoteError('note-invalid', 'body is required');
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > NOTE_BODY_MAX_BYTES) {
    throw new NoteError('note-too-large', `body is ${bytes} bytes; the limit is ${NOTE_BODY_MAX_BYTES} (16 KiB)`);
  }
  return raw;
};

/** Exactly one of an epic slug or a workspace id. */
export const checkTarget = (toEpic: unknown, toWorkspace: unknown): INoteTarget => {
  const epic = toEpic === undefined || toEpic === null || toEpic === '' ? null : toEpic;
  const workspaceId = toWorkspace === undefined || toWorkspace === null || toWorkspace === '' ? null : toWorkspace;
  if ((epic === null) === (workspaceId === null)) {
    throw new NoteError('note-target-missing', 'exactly one of toEpic or toWorkspace is required');
  }
  // The lease grammar, so any holdable epic:<slug> is addressable.
  if (epic !== null && !isEpicSlug(epic)) throw new NoteError('note-target-missing', `toEpic must be an epic slug (${EPIC_SLUG.source}), got ${JSON.stringify(epic)}`);
  if (workspaceId !== null && (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId))) {
    throw new NoteError('note-target-missing', `toWorkspace must be a workspace id, got ${JSON.stringify(workspaceId)}`);
  }
  return { epic: epic as string | null, workspaceId: workspaceId as string | null };
};

export const newNoteId = (): string => `n-${nanoid(10)}`;

export const createNote = (
  input: { from: INoteParty; to: INoteTarget; subject: string; body: string },
  now: number,
  id: string,
): INote => ({
  id,
  from: input.from,
  to: input.to,
  subject: input.subject,
  body: input.body,
  createdAt: now,
  state: 'queued',
  deliveredTo: null,
  routedAt: null,
  deliveredAt: null,
  inboxItemId: null,
  ackedAt: null,
  ackedBy: null,
  ackComment: null,
  remindedAt: null,
  senderNotifiedAt: null,
  expiredAt: null,
  transitionAt: now,
});

// ─── transitions (pure: each returns a new note) ──────────────────────────

/**
 * A new delivery restarts the recipient's reminder clock (the recipient may be a different tab).
 * The sender's clock and its one notice belong to the note: a re-route keeps both (review round 2).
 */
export const routed = (note: INote, to: { workspaceId: string; tabId: string }, inboxItemId: string, now: number): INote => ({
  ...note,
  state: 'delivered',
  deliveredTo: to,
  routedAt: note.routedAt ?? now,
  deliveredAt: null,
  inboxItemId,
  remindedAt: null,
  transitionAt: now,
});

export const undeliverable = (note: INote, now: number): INote =>
  note.state === 'undeliverable' ? note : { ...note, state: 'undeliverable', transitionAt: now };

/** The recipient is gone (its notice dropped, its tab closed, or the epic changed hands): route again. */
export const requeued = (note: INote, now: number): INote => ({
  ...note,
  state: 'queued',
  deliveredTo: null,
  inboxItemId: null,
  deliveredAt: null,
  remindedAt: null,
  transitionAt: now,
});

export const reachedComposer = (note: INote, at: number): INote => ({ ...note, deliveredAt: at });
export const reminded = (note: INote, now: number): INote => ({ ...note, remindedAt: now });
export const senderNotified = (note: INote, now: number): INote => ({ ...note, senderNotifiedAt: now });
export const expired = (note: INote, now: number): INote => ({ ...note, state: 'expired', expiredAt: now, transitionAt: now });

export const acked = (note: INote, by: { workspaceId: string; tabId: string | null }, comment: string | null, now: number): INote => ({
  ...note,
  state: 'acked',
  ackedAt: now,
  ackedBy: by,
  ackComment: comment,
  transitionAt: now,
});

export const cleanComment = (raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new NoteError('note-invalid', 'comment must be text');
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean ? [...clean].slice(0, NOTE_COMMENT_MAX).join('') : null;
};

/** Acked notes 14 d after the ack, and expired notes 14 d after expiry, are gone. */
export const prune = (state: INotesState, now: number): INotesState => {
  const keep = state.notes.filter((n) => !((n.state === 'acked' || n.state === 'expired') && now - n.transitionAt >= NOTE_PRUNE_MS));
  return keep.length === state.notes.length ? state : { notes: keep };
};

// ─── who may see and act on a note ────────────────────────────────────────

/** The recipient workspace: where it was routed, else the workspace it was addressed to. */
export const recipientWorkspace = (note: INote): string | null => note.deliveredTo?.workspaceId ?? note.to.workspaceId;

export const canShow = (note: INote, caller: { workspaceId: string | null; admin: boolean }): boolean =>
  caller.admin
  || (caller.workspaceId !== null && (caller.workspaceId === recipientWorkspace(note) || caller.workspaceId === note.from.workspaceId));

/** Only the recipient's workspace acks, and only a note that was routed to it. */
export const canAck = (note: INote, caller: { workspaceId: string | null }): boolean =>
  caller.workspaceId !== null && note.deliveredTo !== null && caller.workspaceId === note.deliveredTo.workspaceId;

export const viewOf = (note: INote): INoteView => {
  const { body, ...rest } = note;
  return { ...rest, bodyBytes: Buffer.byteLength(body, 'utf8') };
};

// ─── the file store ───────────────────────────────────────────────────────

const g = globalThis as unknown as { __ptNotesLock?: Promise<void> };
if (!g.__ptNotesLock) g.__ptNotesLock = Promise.resolve();

export const notesFile = (): string => path.join(os.homedir(), '.purplemux', 'notes.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptNotesLock!;
  g.__ptNotesLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isNote = (value: unknown): value is INote => {
  if (!value || typeof value !== 'object') return false;
  const n = value as Record<string, unknown>;
  return isNoteId(n.id) && typeof n.state === 'string' && typeof n.body === 'string' && typeof n.subject === 'string'
    && !!n.from && typeof n.from === 'object' && !!n.to && typeof n.to === 'object';
};

/** Absent file = no notes; a file that is not `{ notes: [...] }` is refused, not read as empty. */
export const readNotesState = async (): Promise<INotesState> => {
  const file = notesFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { notes: [] };
    throw err;
  }
  const notes = (JSON.parse(raw) as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes)) throw new Error(`${file} has no "notes" array; notes are refused until it is repaired or moved aside`);
  // A malformed entry is refused, not skipped: the next write would erase it for good.
  const bad = notes.findIndex((n) => !isNote(n));
  if (bad !== -1) throw new Error(`${file} note ${bad} is malformed; notes are refused until it is repaired or moved aside`);
  return { notes: notes as INote[] };
};

const writeNotesState = async (state: INotesState): Promise<void> => {
  const file = notesFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Read, transform, write under the one notes lock. */
export const mutateNotes = async <T>(fn: (state: INotesState) => Promise<{ state: INotesState; value: T }> | { state: INotesState; value: T }): Promise<T> =>
  withLock(async () => {
    const before = await readNotesState();
    const { state, value } = await fn(before);
    if (state !== before) await writeNotesState(state);
    return value;
  });

export const replaceNote = (state: INotesState, note: INote): INotesState => ({
  notes: state.notes.map((n) => (n.id === note.id ? note : n)),
});
