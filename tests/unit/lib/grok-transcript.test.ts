import { afterEach, describe, expect, it } from 'vitest';
import { openGrokDatabase } from '@/lib/providers/grok/db';
import {
  GROK_SEQ_STRIDE,
  mapGrokMessageRow,
  readGrokEntries,
  readGrokMaxMessageSeq,
  readGrokSession,
  unwrapGrokToolOutput,
} from '@/lib/providers/grok/transcript';
import { createGrokFixtureDb, removeGrokFixtureDb } from '../../helpers/grok-fixture-db';

const SESSION = 'a1b2c3d4e5f6';

let dbPath: string | null = null;

const buildDb = (...args: Parameters<typeof createGrokFixtureDb>) => {
  dbPath = createGrokFixtureDb(...args);
  const db = openGrokDatabase(dbPath);
  if (!db) throw new Error('fixture grok.db could not be opened');
  return db;
};

afterEach(() => {
  if (dbPath) removeGrokFixtureDb(dbPath);
  dbPath = null;
});

describe('mapGrokMessageRow', () => {
  it('gives a single-entry message the bare grok-native id', () => {
    const entries = mapGrokMessageRow(SESSION, {
      seq: 3,
      role: 'user',
      message_json: JSON.stringify({ role: 'user', content: 'ship it' }),
      created_at: '2026-08-16T00:00:01.000Z',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'user-message',
      id: `grok:${SESSION}:${3 * GROK_SEQ_STRIDE}`,
      seq: 3 * GROK_SEQ_STRIDE,
      text: 'ship it',
    });
  });

  it('splits an assistant message into thinking, text and tool calls with #n ids', () => {
    const entries = mapGrokMessageRow(SESSION, {
      seq: 4,
      role: 'assistant',
      message_json: JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'weigh the options' },
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: { file_path: '/tmp/a.ts' } },
        ],
      }),
      created_at: '2026-08-16T00:00:02.000Z',
    });

    expect(entries.map((entry) => entry.type)).toEqual(['thinking', 'assistant-message', 'tool-call']);
    expect(entries.map((entry) => entry.id)).toEqual([
      `grok:${SESSION}:4000#0`,
      `grok:${SESSION}:4001#1`,
      `grok:${SESSION}:4002#2`,
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([4000, 4001, 4002]);
    expect(entries[2]).toMatchObject({ toolUseId: 'call-1', summary: 'Read /tmp/a.ts' });
  });

  it('keeps ids stable across repeated mapping of the same row', () => {
    const row = {
      seq: 7,
      role: 'user' as const,
      message_json: JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'again' }] }),
      created_at: '2026-08-16T00:00:03.000Z',
    };
    expect(mapGrokMessageRow(SESSION, row)[0].id).toBe(mapGrokMessageRow(SESSION, row)[0].id);
  });

  it('emits an error-notice rather than dropping an unreadable message', () => {
    const entries = mapGrokMessageRow(SESSION, {
      seq: 1,
      role: 'assistant',
      message_json: '{not json',
      created_at: '2026-08-16T00:00:04.000Z',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'error-notice', severity: 'error' });
  });
});

describe('unwrapGrokToolOutput', () => {
  it('unwraps the grok tool result envelope', () => {
    expect(unwrapGrokToolOutput({ success: true, output: 'done' })).toEqual({ text: 'done', isError: false });
    expect(unwrapGrokToolOutput({ success: false, error: 'nope' })).toEqual({ text: 'nope', isError: true });
    expect(unwrapGrokToolOutput({ type: 'text', value: 'plain' })).toEqual({ text: 'plain', isError: false });
    expect(unwrapGrokToolOutput({ type: 'error-text', value: 'boom' })).toEqual({ text: 'boom', isError: true });
    expect(unwrapGrokToolOutput({ type: 'json', value: { success: true, output: 'inner' } }))
      .toEqual({ text: 'inner', isError: false });
  });
});

describe('readGrokEntries', () => {
  it('maps a whole session from the SQLite store in seq order', () => {
    const db = buildDb([{
      id: SESSION,
      messages: [
        { seq: 0, role: 'user', message: { role: 'user', content: 'add a test' } },
        {
          seq: 1,
          role: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'On it.' },
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'Bash', input: { command: 'pnpm test' } },
            ],
          },
        },
        {
          seq: 2,
          role: 'tool',
          message: {
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'Bash', output: { success: true, output: 'ok' } }],
          },
        },
      ],
      toolCalls: [{ messageSeq: 1, toolCallId: 'call-1', toolName: 'Bash', output: { success: true, output: 'ok' } }],
      usage: [{ messageSeq: 1, model: 'grok-4.20', inputTokens: 120, outputTokens: 34, costMicros: 4500 }],
    }]);

    const entries = readGrokEntries(db, SESSION);
    db.close();

    expect(entries.map((entry) => entry.type)).toEqual([
      'user-message',
      'assistant-message',
      'tool-call',
      'tool-result',
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1000, 1001, 2000]);
    expect(entries[1]).toMatchObject({ model: 'grok-4.20', usage: { input_tokens: 120, output_tokens: 34 } });
    expect(entries[3]).toMatchObject({ toolUseId: 'call-1', isError: false });
  });

  it('marks a failed tool result as an error', () => {
    const db = buildDb([{
      id: SESSION,
      messages: [{
        seq: 0,
        role: 'tool',
        message: {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'call-9', toolName: 'Bash', output: { success: false, error: 'exit 1' } }],
        },
      }],
      toolCalls: [{ messageSeq: 0, toolCallId: 'call-9', toolName: 'Bash', output: { success: false, error: 'exit 1' }, success: false }],
    }]);

    const entries = readGrokEntries(db, SESSION);
    db.close();
    expect(entries[0]).toMatchObject({ type: 'tool-result', isError: true, summary: 'error' });
  });

  it('places a compaction immediately before the first message it kept', () => {
    const db = buildDb([{
      id: SESSION,
      messages: [
        { seq: 0, role: 'user', message: { role: 'user', content: 'first' } },
        { seq: 5, role: 'user', message: { role: 'user', content: 'after compaction' } },
      ],
      compactions: [{ firstKeptSeq: 5, summary: 'earlier turns', tokensBefore: 90_000 }],
    }]);

    const entries = readGrokEntries(db, SESSION);
    db.close();

    expect(entries.map((entry) => entry.type)).toEqual(['user-message', 'context-compacted', 'user-message']);
    expect(entries[1]).toMatchObject({ seq: 4999, beforeTokens: 90_000, id: `grok:${SESSION}:4999` });
  });

  it('reads only the tail after a message seq', () => {
    const db = buildDb([{
      id: SESSION,
      messages: [
        { seq: 0, role: 'user', message: { role: 'user', content: 'one' } },
        { seq: 1, role: 'user', message: { role: 'user', content: 'two' } },
      ],
    }]);

    const entries = readGrokEntries(db, SESSION, { afterMessageSeq: 0 });
    db.close();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: 'two', seq: 1000 });
  });

  it('reports session metadata and the highest message seq', () => {
    const db = buildDb([{
      id: SESSION,
      cwd: '/home/dev/purplemux',
      title: 'grok provider',
      messages: [{ seq: 2, role: 'user', message: { role: 'user', content: 'hi' } }],
    }]);

    expect(readGrokSession(db, SESSION)).toMatchObject({ id: SESSION, title: 'grok provider', cwd_last: '/home/dev/purplemux' });
    expect(readGrokMaxMessageSeq(db, SESSION)).toBe(2);
    expect(readGrokMaxMessageSeq(db, 'missing')).toBe(-1);
    db.close();
  });
});
