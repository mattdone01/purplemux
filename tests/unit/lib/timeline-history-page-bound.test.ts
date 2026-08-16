import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHistoryPage } from '@/lib/timeline-history';
import { parseGrokContent } from '@/lib/session-parser-grok';
import type { ITimelineEntry } from '@/types/timeline';

const SESSION_ID = '01a00000-0000-7000-8000-0000000000ff';
const ENTRY_COUNT = 40;
const LIMIT = 5;

/**
 * grok numbers entries by update ordinal, so an alternating conversation is
 * naturally consecutive — the shape `takePage`'s run extension was never meant
 * to be handed.
 */
const transcript = (): string => Array.from({ length: ENTRY_COUNT }, (_, i) => JSON.stringify({
  timestamp: 1786853300 + i,
  method: 'session/update',
  params: {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: i % 2 === 0 ? 'user_message_chunk' : 'agent_message_chunk',
      content: { type: 'text', text: `message ${i}` },
    },
  },
})).join('\n') + '\n';

describe('readHistoryPage bounds a grok page', () => {
  let dir: string;
  let jsonlPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-page-bound-'));
    const sessionDir = path.join(dir, SESSION_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    jsonlPath = path.join(sessionDir, 'updates.jsonl');
    await fs.writeFile(jsonlPath, transcript());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not return the whole session for a small limit', async () => {
    const page = await readHistoryPage({ jsonlPath, provider: 'grok', afterSeq: -1, limit: LIMIT });

    expect(page?.entries.length).toBeGreaterThanOrEqual(LIMIT);
    expect(page?.entries.length).toBeLessThanOrEqual(LIMIT * 2);
    expect(page?.hasMore).toBe(true);
  });

  it('still pages the whole session without skipping or repeating an entry', async () => {
    const collected: ITimelineEntry[] = [];
    let afterSeq = -1;

    for (let guard = 0; guard < 20; guard++) {
      const page = await readHistoryPage({ jsonlPath, provider: 'grok', afterSeq, limit: LIMIT });
      if (!page) break;
      collected.push(...page.entries);
      afterSeq = page.nextSeq - 1;
      if (!page.hasMore) break;
    }

    expect(collected).toEqual(parseGrokContent(await fs.readFile(jsonlPath, 'utf-8'), SESSION_ID));
  });
});
