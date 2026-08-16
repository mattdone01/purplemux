import type { ITimelineEntry } from '@/types/timeline';

/**
 * Entry ids are stable across re-parses, so the same entry can arrive twice —
 * a bounded re-read after a late `timeline:init`, or a backfill page that
 * overlaps what the socket already delivered. React keys on `id`, so a
 * duplicate is a rendering bug, not a cosmetic one.
 */
export const upsertEntry = (list: ITimelineEntry[], entry: ITimelineEntry): void => {
  const index = list.findIndex((existing) => existing.id === entry.id);
  if (index === -1) list.push(entry);
  else list[index] = entry;
};

/** Prepends a backfill page, dropping entries the current list already holds. */
export const prependEntries = (
  older: ITimelineEntry[],
  current: ITimelineEntry[],
): ITimelineEntry[] => {
  const present = new Set(current.map((entry) => entry.id));
  return [...older.filter((entry) => !present.has(entry.id)), ...current];
};
