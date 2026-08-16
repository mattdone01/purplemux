import type { TSearchableEntryType } from '@/lib/entry-text';

/** One searchable entry, extracted once per source revision and kept as plain text. */
export interface ISearchDoc {
  seq: number;
  entryId: string;
  type: TSearchableEntryType;
  timestamp: number;
  text: string;
}

/**
 * Budget for the extracted text of every session searched on this machine. A
 * scan is bounded by disk, not by this cache — an eviction costs a re-parse of
 * one session, never a wrong result.
 */
export const MAX_SEARCH_CACHE_BYTES = 200 * 1024 * 1024;

/**
 * One byte per character plus a flat allowance for the four scalar fields: V8
 * stores an ASCII string as a one-byte string, and transcript text is
 * overwhelmingly ASCII. A corpus of two-byte text is accounted at half its real
 * size — the budget is a bound on cache growth, not a memory guarantee.
 */
const DOC_OVERHEAD_BYTES = 64;

interface ICacheEntry {
  fingerprint: string;
  docs: ISearchDoc[];
  bytes: number;
}

interface ISearchCache {
  docs: Map<string, ICacheEntry>;
  bytes: number;
}

const g = globalThis as unknown as { __ptSearchCache?: ISearchCache };
if (!g.__ptSearchCache) g.__ptSearchCache = { docs: new Map(), bytes: 0 };
const cache = g.__ptSearchCache;

const sizeOf = (docs: ISearchDoc[]): number =>
  docs.reduce((total, doc) => total + doc.text.length + doc.entryId.length + DOC_OVERHEAD_BYTES, 0);

/**
 * Cached extraction for a source at one revision, or null when the source
 * changed since — the fingerprint is `mtime:size` for a file and the store's
 * own revision for a database, so a stale hit is impossible rather than
 * unlikely.
 */
export const readSearchDocs = (sourceId: string, fingerprint: string): ISearchDoc[] | null => {
  const entry = cache.docs.get(sourceId);
  if (!entry) return null;
  if (entry.fingerprint !== fingerprint) {
    cache.docs.delete(sourceId);
    cache.bytes -= entry.bytes;
    return null;
  }
  cache.docs.delete(sourceId);
  cache.docs.set(sourceId, entry);
  return entry.docs;
};

export const writeSearchDocs = (
  sourceId: string,
  fingerprint: string,
  docs: ISearchDoc[],
  maxBytes: number = MAX_SEARCH_CACHE_BYTES,
): void => {
  const previous = cache.docs.get(sourceId);
  if (previous) {
    cache.docs.delete(sourceId);
    cache.bytes -= previous.bytes;
  }

  const bytes = sizeOf(docs);
  cache.docs.set(sourceId, { fingerprint, docs, bytes });
  cache.bytes += bytes;

  while (cache.bytes > maxBytes && cache.docs.size > 1) {
    const oldest = cache.docs.keys().next().value;
    if (oldest === undefined) break;
    cache.bytes -= cache.docs.get(oldest)?.bytes ?? 0;
    cache.docs.delete(oldest);
  }
};

export const searchCacheStats = (): { sources: number; bytes: number } => ({
  sources: cache.docs.size,
  bytes: cache.bytes,
});

export const clearSearchCache = (): void => {
  cache.docs.clear();
  cache.bytes = 0;
};
