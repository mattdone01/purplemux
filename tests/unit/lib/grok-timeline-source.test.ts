import { afterEach, describe, expect, it } from 'vitest';
import { closeGrokDatabase } from '@/lib/providers/grok/db';
import {
  buildGrokSessionStats,
  readGrokTimelineInit,
  readGrokTimelineTail,
} from '@/lib/providers/grok/timeline-source';
import { buildSessionKey, parseSessionKey } from '@/lib/session-key';
import { createGrokFixtureDb, removeGrokFixtureDb } from '../../helpers/grok-fixture-db';

const SESSION = 'abcdef012345';

let dbPath: string | null = null;

const fixture = (...args: Parameters<typeof createGrokFixtureDb>) => {
  dbPath = createGrokFixtureDb(...args);
  return dbPath;
};

afterEach(() => {
  closeGrokDatabase();
  if (dbPath) removeGrokFixtureDb(dbPath);
  dbPath = null;
});

const userMessage = (seq: number, text: string, createdAt?: string) => ({
  seq,
  role: 'user',
  message: { role: 'user', content: text },
  ...(createdAt ? { createdAt } : {}),
});

describe('readGrokTimelineInit', () => {
  it('returns the session as an init payload with a message-seq cursor', () => {
    const path = fixture([{
      id: SESSION,
      title: 'grok provider',
      createdAt: '2026-08-16T00:00:00.000Z',
      messages: [
        userMessage(0, 'first', '2026-08-16T00:00:00.000Z'),
        {
          seq: 1,
          role: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          createdAt: '2026-08-16T00:00:05.000Z',
        },
      ],
      usage: [{ messageSeq: 1, model: 'grok-4.20', inputTokens: 200, outputTokens: 50, costMicros: 12_000 }],
    }]);

    const init = readGrokTimelineInit(SESSION, 128, path);

    expect(init.entries.map((entry) => entry.type)).toEqual(['user-message', 'assistant-message']);
    expect(init.lastMessageSeq).toBe(1);
    expect(init.hasMore).toBe(false);
    expect(init.summary).toBe('grok provider');
    expect(init.meta).toMatchObject({ userCount: 1, assistantCount: 1, customTitle: 'grok provider' });
    expect(init.sessionStats).toMatchObject({
      sessionId: SESSION,
      inputTokens: 200,
      outputTokens: 50,
      cost: 0.012,
      model: 'grok-4.20',
    });
  });

  it('truncates to the newest entries and reports hasMore', () => {
    const path = fixture([{
      id: SESSION,
      messages: Array.from({ length: 6 }, (_, i) => userMessage(i, `m${i}`)),
    }]);

    const init = readGrokTimelineInit(SESSION, 2, path);
    expect(init.hasMore).toBe(true);
    expect(init.totalEntries).toBe(2);
    expect(init.entries.map((entry) => entry.seq)).toEqual([4000, 5000]);
    expect(init.lastMessageSeq).toBe(5);
  });

  it('aggregates every usage row of a message instead of keeping the last', () => {
    const path = fixture([{
      id: SESSION,
      messages: [{
        seq: 0,
        role: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two model calls' }] },
      }],
      usage: [
        { messageSeq: 0, model: 'grok-4.20', inputTokens: 100, outputTokens: 10 },
        { messageSeq: 0, model: 'grok-4.20-fast', inputTokens: 40, outputTokens: 5 },
      ],
    }]);

    const [entry] = readGrokTimelineInit(SESSION, 128, path).entries;

    expect(entry).toMatchObject({
      type: 'assistant-message',
      model: 'grok-4.20-fast',
      usage: { input_tokens: 140, output_tokens: 15 },
    });
  });

  it('reports an empty session rather than throwing', () => {
    const path = fixture([{ id: SESSION }]);
    const init = readGrokTimelineInit(SESSION, 128, path);
    expect(init.entries).toEqual([]);
    expect(init.lastMessageSeq).toBe(-1);
    expect(init.sessionStats).toMatchObject({ cost: null });
  });

  it('degrades to an empty payload when the store does not exist', () => {
    const init = readGrokTimelineInit(SESSION, 128, '/nonexistent/grok.db');
    expect(init).toMatchObject({ entries: [], lastMessageSeq: -1, sessionStats: null });
  });
});

describe('readGrokTimelineTail', () => {
  it('returns only entries recorded after the cursor', () => {
    const path = fixture([{
      id: SESSION,
      messages: [userMessage(0, 'one'), userMessage(1, 'two'), userMessage(2, 'three')],
    }]);

    const tail = readGrokTimelineTail(SESSION, 1, path);
    expect(tail.entries.map((entry) => entry.seq)).toEqual([2000]);
    expect(tail.lastMessageSeq).toBe(2);
  });

  it('returns nothing when the cursor is already current', () => {
    const path = fixture([{ id: SESSION, messages: [userMessage(0, 'one')] }]);
    expect(readGrokTimelineTail(SESSION, 0, path).entries).toEqual([]);
  });
});

describe('the shared grok store handle', () => {
  it('survives a caller that closes its wrapper — the next get is not a dead handle', async () => {
    const { getGrokDatabase } = await import('@/lib/providers/grok/db');
    const path = fixture([{ id: SESSION, messages: [userMessage(0, 'one')] }]);

    const first = getGrokDatabase(path);
    expect(first).not.toBeNull();
    first!.close();

    const second = getGrokDatabase(path);
    expect(second).not.toBeNull();
    expect(second!.all<{ id: string }>('SELECT id FROM sessions')).toEqual([{ id: SESSION }]);
  });
});

describe('grok session keys', () => {
  it('always scopes grok sessions globally — grok has no per-workspace store', () => {
    const key = buildSessionKey({ provider: 'grok', workspaceId: null, sessionId: SESSION });
    expect(key).toBe(`grok:global:${SESSION}`);
    expect(parseSessionKey(key)).toEqual({ provider: 'grok', workspaceId: null, sessionId: SESSION });
  });
});

describe('buildGrokSessionStats', () => {
  it('sums usage_events and converts cost_micros to a currency amount', () => {
    const stats = buildGrokSessionStats(SESSION, [
      { message_seq: 1, model: 'grok-4.20', input_tokens: 100, output_tokens: 10, total_tokens: 110, cost_micros: 1_500_000 },
      { message_seq: 3, model: 'grok-4.20-fast', input_tokens: 40, output_tokens: 5, total_tokens: 45, cost_micros: 500_000 },
    ], 'grok-4.20');

    expect(stats).toEqual({
      sessionId: SESSION,
      inputTokens: 140,
      outputTokens: 15,
      cost: 2,
      model: 'grok-4.20-fast',
    });
  });

  it('reports no cost when the session recorded no usage', () => {
    expect(buildGrokSessionStats(SESSION, [], 'grok-4.20').cost).toBeNull();
  });
});
