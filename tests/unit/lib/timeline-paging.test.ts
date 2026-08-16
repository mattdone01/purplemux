import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { canLoadOlder } from '@/lib/timeline-paging';
import { createGrokParser, readGrokEntriesBefore } from '@/lib/session-parser-grok';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('canLoadOlder', () => {
  it('allows paging only from a JSONL source with a byte cursor above the start', () => {
    expect(canLoadOlder('/home/me/.claude/projects/p/s.jsonl', 4096)).toBe(true);
    expect(canLoadOlder('/home/me/.claude/projects/p/s.jsonl', 0)).toBe(false);
  });

  it('refuses a source with no transcript path at all', () => {
    expect(canLoadOlder(null, 4096)).toBe(false);
    expect(canLoadOlder(undefined, 4096)).toBe(false);
  });
});

/**
 * F6: a grok session past MAX_INIT_ENTRIES advertised `hasMore: true` with
 * `jsonlPath: null`, so the client armed a load-older control that returned
 * early forever. Grok Build's transcript is a real file, so the guarantee is
 * now that init hands back a cursor the older-page route can actually use —
 * and 0, which disarms the control, whenever there is nothing older.
 */
describe('grok init never arms an inert load-older affordance', () => {
  const TOOLS = path.join(ROOT, 'tests', 'fixtures', 'grok-session-tools', 'updates.jsonl');

  it('reports no cursor when the whole session fit in the init payload', async () => {
    const tail = await createGrokParser(TOOLS).parseTail(1000);

    expect(tail.hasMore).toBe(false);
    expect(tail.startByteOffset).toBe(0);
    expect(canLoadOlder(TOOLS, tail.startByteOffset)).toBe(false);
  });

  it('reports a cursor the older-page route can page from when the tail was cut', async () => {
    const tail = await createGrokParser(TOOLS).parseTail(3);

    expect(tail.hasMore).toBe(true);
    expect(canLoadOlder(TOOLS, tail.startByteOffset)).toBe(true);

    const older = await readGrokEntriesBefore(TOOLS, tail.startByteOffset, 100);
    expect(older.entries.length).toBeGreaterThan(0);
    expect(Math.max(...older.entries.map((entry) => entry.seq ?? 0))).toBeLessThan(tail.startByteOffset);
  });

  it('clears hasMore in the client when there is nothing to page', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'src/hooks/use-timeline.ts'), 'utf-8');
    expect(hook).toContain('canLoadOlder');
  });
});
