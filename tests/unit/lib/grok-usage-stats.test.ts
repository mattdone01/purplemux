import { afterEach, describe, expect, it } from 'vitest';
import { closeGrokDatabase } from '@/lib/providers/grok/db';
import { readGrokUsage } from '@/lib/stats/grok-usage';
import { createGrokFixtureDb, removeGrokFixtureDb } from '../../helpers/grok-fixture-db';

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

const iso = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

describe('readGrokUsage', () => {
  it('sums cost in micros and divides once, so per-row rounding cannot drift', () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004; 300_000 micros
    // divided once is exactly 0.3.
    const path = fixture([{
      id: 'cccccccccccc',
      createdAt: iso(2_000),
      usage: [
        { messageSeq: 1, model: 'grok-4.20', inputTokens: 1, outputTokens: 1, costMicros: 100_000, createdAt: iso(1_000) },
        { messageSeq: 2, model: 'grok-4.20', inputTokens: 1, outputTokens: 1, costMicros: 200_000, createdAt: iso(1_000) },
      ],
    }]);

    const { sessions } = readGrokUsage('all', path);

    expect(sessions[0].cost).toBe(0.3);
  });

  it('aggregates tokens, cost and messages per session', () => {
    const path = fixture([
      {
        id: 'aaaaaaaaaaaa',
        model: 'grok-4.20',
        createdAt: iso(60_000),
        messages: [
          { seq: 0, role: 'user', message: { role: 'user', content: 'hi' }, createdAt: iso(60_000) },
          { seq: 1, role: 'assistant', message: { role: 'assistant', content: 'yo' }, createdAt: iso(59_000) },
          { seq: 2, role: 'user', message: { role: 'user', content: 'again' }, createdAt: iso(58_000) },
        ],
        usage: [
          { messageSeq: 1, model: 'grok-4.20', inputTokens: 100, outputTokens: 20, costMicros: 1_000_000, createdAt: iso(59_000) },
          { messageSeq: 3, model: 'grok-4.20-fast', inputTokens: 30, outputTokens: 5, costMicros: 250_000, createdAt: iso(57_000) },
        ],
      },
    ]);

    const usage = readGrokUsage('all', path);

    expect(usage.sessions).toHaveLength(1);
    expect(usage.sessions[0]).toMatchObject({
      sessionId: 'aaaaaaaaaaaa',
      model: 'grok-4.20-fast',
      inputTokens: 130,
      outputTokens: 25,
      cost: 1.25,
      messageCount: 2,
    });
    expect(usage.messageTimestamps).toHaveLength(2);
  });

  it('counts a session with no usage_events at zero rather than dropping it', () => {
    const path = fixture([{ id: 'bbbbbbbbbbbb', model: 'grok-4.20', createdAt: iso(1000) }]);
    const usage = readGrokUsage('all', path);
    expect(usage.sessions[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 });
  });

  it('filters by period on the session and message timestamps', () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const path = fixture([
      {
        id: 'cccccccccccc',
        createdAt: old,
        messages: [{ seq: 0, role: 'user', message: { role: 'user', content: 'ancient' }, createdAt: old }],
      },
      {
        id: 'dddddddddddd',
        createdAt: iso(1000),
        messages: [{ seq: 0, role: 'user', message: { role: 'user', content: 'recent' }, createdAt: iso(1000) }],
      },
    ]);

    expect(readGrokUsage('all', path).sessions).toHaveLength(2);
    const recent = readGrokUsage('7d', path);
    expect(recent.sessions.map((session) => session.sessionId)).toEqual(['dddddddddddd']);
    expect(recent.messageTimestamps).toHaveLength(1);
  });

  it('returns an empty summary when grok was never run', () => {
    expect(readGrokUsage('all', '/nonexistent/grok.db')).toEqual({ sessions: [], messageTimestamps: [] });
  });
});
