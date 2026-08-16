import { describe, expect, it } from 'vitest';
import { assignEntryIdentity, entryIdFor, hashEntryId, renumberGroupEntries } from '@/lib/entry-identity';
import type { ITimelineEntry } from '@/types/timeline';

const message = (text: string): ITimelineEntry => ({
  id: '',
  type: 'user-message',
  timestamp: 0,
  text,
});

describe('entryIdFor', () => {
  it('returns the bare uuid for a record that yields one entry', () => {
    expect(entryIdFor({ uuid: 'u1', sessionId: 's', byteOffset: 0 }, 0, 1)).toBe('u1');
  });

  it('suffixes the ordinal for a record that yields several entries', () => {
    const origin = { uuid: 'u1', sessionId: 's', byteOffset: 0 };
    expect(entryIdFor(origin, 0, 3)).toBe('u1#0');
    expect(entryIdFor(origin, 2, 3)).toBe('u1#2');
  });

  it('accepts a named ordinal for entries that are not part of the record sequence', () => {
    expect(entryIdFor({ uuid: 'u1', sessionId: 's', byteOffset: 0 }, 'group')).toBe('u1#group');
  });

  it('falls back to a truncated sha1 when the record has no uuid', () => {
    const id = entryIdFor({ sessionId: 'sess', byteOffset: 128 }, 1, 2);
    expect(id).toBe(hashEntryId('sess', 128, 1));
    expect(id).toHaveLength(21);
  });
});

describe('hashEntryId', () => {
  it('changes when any of session, offset or ordinal changes', () => {
    const ids = new Set([
      hashEntryId('a', 0, 0),
      hashEntryId('b', 0, 0),
      hashEntryId('a', 1, 0),
      hashEntryId('a', 0, 1),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe('assignEntryIdentity', () => {
  it('numbers seq from the record byte offset', () => {
    const entries = [message('one'), message('two'), message('three')];

    assignEntryIdentity(entries, { uuid: 'u1', sessionId: 's', byteOffset: 512 });

    expect(entries.map((e) => e.id)).toEqual(['u1#0', 'u1#1', 'u1#2']);
    expect(entries.map((e) => e.seq)).toEqual([512, 513, 514]);
  });
});

describe('renumberGroupEntries', () => {
  it('numbers entries from 0 within their group', () => {
    const entries = [message('one'), message('two')];
    assignEntryIdentity(entries, { uuid: 'u1', sessionId: 's', byteOffset: 900 });

    renumberGroupEntries(entries);

    expect(entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(entries.map((e) => e.id)).toEqual(['u1#0', 'u1#1']);
  });
});
