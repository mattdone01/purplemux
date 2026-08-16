import { describe, expect, it } from 'vitest';
import { prependEntries, upsertEntry } from '@/lib/timeline-merge';
import type { ITimelineEntry } from '@/types/timeline';

const message = (id: string, seq: number, text = id): ITimelineEntry => ({
  id,
  seq,
  type: 'user-message',
  timestamp: 0,
  text,
});

describe('upsertEntry', () => {
  it('appends an entry the list does not hold yet', () => {
    const list = [message('a', 0)];

    upsertEntry(list, message('b', 10));

    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('replaces in place instead of appending a duplicate id', () => {
    const list = [message('a', 0), message('b', 10)];

    upsertEntry(list, message('a', 0, 'edited'));

    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(list[0]).toMatchObject({ type: 'user-message', text: 'edited' });
  });

  it('leaves no duplicate keys when a whole append batch is replayed', () => {
    const list: ITimelineEntry[] = [];
    const batch = [message('a', 0), message('b', 10), message('c', 20)];

    for (const entry of [...batch, ...batch]) upsertEntry(list, entry);

    expect(list).toHaveLength(3);
    expect(new Set(list.map((e) => e.id)).size).toBe(3);
  });
});

describe('prependEntries', () => {
  it('puts the backfill page in front of what is already rendered', () => {
    const result = prependEntries([message('a', 0), message('b', 10)], [message('c', 20)]);

    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops backfill entries the current list already holds', () => {
    const current = [message('b', 10), message('c', 20)];

    const result = prependEntries([message('a', 0), message('b', 10)], current);

    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(new Set(result.map((e) => e.id)).size).toBe(result.length);
  });

  it('keeps the rendered copy when a page overlaps it', () => {
    const current = [message('b', 10, 'rendered')];

    const result = prependEntries([message('b', 10, 'refetched')], current);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'user-message', text: 'rendered' });
  });
});
