import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { canLoadOlder } from '@/lib/timeline-paging';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('canLoadOlder', () => {
  it('allows paging only from a JSONL source with a byte cursor above the start', () => {
    expect(canLoadOlder('/home/me/.claude/projects/p/s.jsonl', 4096)).toBe(true);
    expect(canLoadOlder('/home/me/.claude/projects/p/s.jsonl', 0)).toBe(false);
  });

  it('refuses a source with no transcript path — grok pages from no byte offset', () => {
    expect(canLoadOlder(null, 4096)).toBe(false);
    expect(canLoadOlder(undefined, 4096)).toBe(false);
  });
});

/**
 * F6: a grok session past MAX_INIT_ENTRIES advertised `hasMore: true` with
 * `jsonlPath: null`, so the client armed a load-older control that returned
 * early forever. Both ends now ask the same question.
 */
describe('grok init never arms an inert load-older affordance', () => {
  const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf-8');

  it('gates the grok init payload on canLoadOlder', () => {
    const source = read('src/lib/timeline-server.ts');
    const grokInit = source.slice(source.indexOf('const subscribeToGrokSession'));

    expect(grokInit).toContain('canLoadOlder');
    expect(grokInit.slice(0, grokInit.indexOf('const flushGrokAppend'))).not.toMatch(/hasMore: init\.hasMore,/);
  });

  it('clears hasMore in the client when there is nothing to page', () => {
    const hook = read('src/hooks/use-timeline.ts');
    expect(hook).toContain('canLoadOlder');
  });
});
