import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSearchCache,
  readSearchDocs,
  searchCacheStats,
  writeSearchDocs,
  type ISearchDoc,
} from '@/lib/search-cache';

const docs = (text: string): ISearchDoc[] => [
  { seq: 0, entryId: 'e0', type: 'user-message', timestamp: 1, text },
];

describe('search-cache', () => {
  beforeEach(() => {
    clearSearchCache();
  });

  it('returns the extraction only for the fingerprint it was written under', () => {
    writeSearchDocs('/a.jsonl', '10:200', docs('alpha'));

    expect(readSearchDocs('/a.jsonl', '10:200')?.[0].text).toBe('alpha');
    expect(readSearchDocs('/a.jsonl', '11:260')).toBeNull();
    expect(searchCacheStats().sources).toBe(0);
  });

  it('evicts least-recently-read sources once the byte budget is exceeded', () => {
    const budget = 2500;
    writeSearchDocs('/a.jsonl', 'f', docs('a'.repeat(1000)), budget);
    writeSearchDocs('/b.jsonl', 'f', docs('b'.repeat(1000)), budget);
    readSearchDocs('/a.jsonl', 'f');
    writeSearchDocs('/c.jsonl', 'f', docs('c'.repeat(1000)), budget);

    expect(readSearchDocs('/b.jsonl', 'f')).toBeNull();
    expect(readSearchDocs('/a.jsonl', 'f')).not.toBeNull();
    expect(readSearchDocs('/c.jsonl', 'f')).not.toBeNull();
  });

  it('keeps the byte total in step with rewrites of one source', () => {
    writeSearchDocs('/a.jsonl', 'f1', docs('x'.repeat(500)));
    const first = searchCacheStats().bytes;
    writeSearchDocs('/a.jsonl', 'f2', docs('x'.repeat(500)));

    expect(searchCacheStats().sources).toBe(1);
    expect(searchCacheStats().bytes).toBe(first);
  });
});
