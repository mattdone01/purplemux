import { createHash } from 'crypto';
import type { ITimelineEntry } from '@/types/timeline';

/**
 * Written by the entry constructors in both parsers and replaced by
 * `assignEntryIdentity` once the source record is known. Nothing reaches a
 * consumer holding it — the parsers assign identity to every entry they emit.
 */
export const PENDING_ENTRY_ID = '';

/** nanoid's default width, kept so ids stay the same size as the ones they replace. */
const HASHED_ID_LENGTH = 21;

export interface IEntryOrigin {
  /** Absolute byte offset of the record's line within the session file. */
  byteOffset: number;
  sessionId: string;
  /** Record uuid where the provider supplies one (Claude); absent for Codex. */
  uuid?: string;
}

export const hashEntryId = (sessionId: string, byteOffset: number, ordinal: number | string): string =>
  createHash('sha1')
    .update(`${sessionId}:${byteOffset}:${ordinal}`)
    .digest('hex')
    .slice(0, HASHED_ID_LENGTH);

export const entryIdFor = (origin: IEntryOrigin, ordinal: number | string, total = 1): string => {
  if (!origin.uuid) return hashEntryId(origin.sessionId, origin.byteOffset, ordinal);
  return total === 1 && ordinal === 0 ? origin.uuid : `${origin.uuid}#${ordinal}`;
};

/**
 * Stamps every entry a single record produced with its id and `seq`.
 *
 * `seq` is `byteOffset + ordinal`. That is strictly increasing across the
 * session because a record that yields k entries is itself far longer than k
 * bytes, so the next record's offset always clears the ordinals of this one.
 */
export const assignEntryIdentity = (entries: ITimelineEntry[], origin: IEntryOrigin): void => {
  entries.forEach((entry, ordinal) => {
    entry.id = entryIdFor(origin, ordinal, entries.length);
    entry.seq = origin.byteOffset + ordinal;
  });
};

/** Entries nested in an `agent-group` are numbered within their group (AC of story 02). */
export const renumberGroupEntries = (entries: ITimelineEntry[]): void => {
  entries.forEach((entry, index) => {
    entry.seq = index;
  });
};
