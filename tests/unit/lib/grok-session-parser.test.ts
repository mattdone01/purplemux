import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { describe, expect, it } from 'vitest';
import {
  GROK_COST_TICKS_PER_USD,
  createGrokParser,
  parseGrokContent,
  parseGrokUpdateLine,
  readGrokEntriesBefore,
} from '@/lib/session-parser-grok';
import type { ITimelineEntry } from '@/types/timeline';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const PLAIN = path.join(FIXTURES, 'grok-session');
const TOOLS = path.join(FIXTURES, 'grok-session-tools');

const PLAIN_SESSION_ID = '01a008c1-bb96-71d1-9769-b63ff478fd9f';
const TOOLS_SESSION_ID = '01a008c3-8e98-7220-a0d3-e0b36fa3aa99';

const readUpdates = (dir: string) => fs.readFile(path.join(dir, 'updates.jsonl'), 'utf-8');

const types = (entries: ITimelineEntry[]) => entries.map((entry) => entry.type);

describe('parseGrokUpdateLine', () => {
  it('reads both the standard and the x.ai extension method channels', async () => {
    const lines = (await readUpdates(PLAIN)).trim().split('\n');
    const parsed = lines.map((line, i) => parseGrokUpdateLine(line, i));

    expect(parsed.map((p) => p?.kind)).toEqual([
      'user_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'turn_completed',
    ]);
    expect(parsed.every((p) => p?.sessionId === PLAIN_SESSION_ID)).toBe(true);
  });

  it('prefers the millisecond agent timestamp over the second-resolution envelope', async () => {
    const [first] = (await readUpdates(PLAIN)).trim().split('\n');
    expect(parseGrokUpdateLine(first, 0)?.timestamp).toBe(1786853309420);
  });

  it('rejects a line that is not an ACP session update', () => {
    expect(parseGrokUpdateLine('not json', 0)).toBeNull();
    expect(parseGrokUpdateLine('{"params":{}}', 0)).toBeNull();
  });
});

describe('parseGrokContent — conversation fixture', () => {
  it('maps the recorded session to user / thinking / assistant entries', async () => {
    const entries = parseGrokContent(await readUpdates(PLAIN), PLAIN_SESSION_ID);

    expect(types(entries)).toEqual(['user-message', 'thinking', 'assistant-message']);
    expect(entries[0]).toMatchObject({
      id: `grok:${PLAIN_SESSION_ID}:0`,
      seq: 0,
      text: 'Reply with exactly the word OK and nothing else.',
    });
    expect(entries[2]).toMatchObject({ seq: 2, markdown: 'OK' });
  });

  it('attaches the turn_completed usage and model to the assistant message', async () => {
    const entries = parseGrokContent(await readUpdates(PLAIN), PLAIN_SESSION_ID);
    const assistant = entries.find((entry) => entry.type === 'assistant-message');

    expect(assistant).toMatchObject({
      model: 'grok-4.6-build',
      stopReason: 'end_turn',
      usage: {
        input_tokens: 19427,
        output_tokens: 39,
        cache_read_input_tokens: 128,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it('gives every entry a strictly increasing seq and a derived id', async () => {
    const entries = parseGrokContent(await readUpdates(PLAIN), PLAIN_SESSION_ID);
    const seqs = entries.map((entry) => entry.seq ?? -1);

    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(entries.every((entry) => entry.id === `grok:${PLAIN_SESSION_ID}:${entry.seq}`)).toBe(true);
  });
});

describe('parseGrokContent — tool-call fixture', () => {
  it('emits one tool-call per ACP tool_call and one result per terminal update', async () => {
    const entries = parseGrokContent(await readUpdates(TOOLS), TOOLS_SESSION_ID);

    expect(types(entries)).toEqual([
      'user-message',
      'thinking',
      'assistant-message',
      'tool-call',
      'tool-result',
      'thinking',
      'tool-call',
      'tool-call',
      'tool-result',
      'tool-result',
      'thinking',
      'assistant-message',
    ]);
  });

  it('maps grok tool names onto the timeline names the UI renders', async () => {
    const entries = parseGrokContent(await readUpdates(TOOLS), TOOLS_SESSION_ID);
    const calls = entries.filter((entry) => entry.type === 'tool-call');

    expect(calls.map((call) => call.toolName)).toEqual(['Read', 'Edit', 'Bash']);
    expect(calls[0].summary).toBe('Read note.txt');
    expect(calls[1].summary).toBe('Update note.txt (+1, -1)');
    expect(calls[2].summary).toBe('$ wc -l note.txt');
  });

  it('pairs each result with its call and does not settle one twice', async () => {
    const entries = parseGrokContent(await readUpdates(TOOLS), TOOLS_SESSION_ID);
    const callIds = entries.filter((e) => e.type === 'tool-call').map((e) => e.toolUseId);
    const resultIds = entries.filter((e) => e.type === 'tool-result').map((e) => e.toolUseId);

    expect(new Set(resultIds)).toEqual(new Set(callIds));
    expect(resultIds).toHaveLength(callIds.length);
    expect(entries.filter((e) => e.type === 'tool-result').every((e) => e.isError === false)).toBe(true);
  });

  it('ignores the non-terminal tool_call_update that only refines the title', async () => {
    const raw = await readUpdates(TOOLS);
    const nonTerminal = raw
      .trim()
      .split('\n')
      .map((line, i) => parseGrokUpdateLine(line, i))
      .filter((u) => u?.kind === 'tool_call_update' && !('status' in u.update));

    expect(nonTerminal.length).toBeGreaterThan(0);
    const entries = parseGrokContent(raw, TOOLS_SESSION_ID);
    expect(entries.filter((e) => e.type === 'tool-result')).toHaveLength(3);
  });

  it('keeps the two assistant messages separate rather than coalescing across tool calls', async () => {
    const entries = parseGrokContent(await readUpdates(TOOLS), TOOLS_SESSION_ID);
    const assistants = entries.filter((entry) => entry.type === 'assistant-message');

    expect(assistants.map((entry) => entry.markdown)).toEqual([
      'I\'ll make the one-word edit in `note.txt`, then run `wc -l` on it.',
      'DONE',
    ]);
  });
});

describe('chunk coalescing', () => {
  const line = (ordinal: number, kind: string, text: string) => JSON.stringify({
    timestamp: 1786853312,
    method: 'session/update',
    params: {
      sessionId: 'sid',
      update: { sessionUpdate: kind, content: { type: 'text', text } },
      _meta: { agentTimestampMs: 1786853312000 + ordinal },
    },
  });

  it('collapses consecutive chunks of one kind into a single entry at the first seq', () => {
    const content = [
      line(0, 'agent_message_chunk', 'Hello '),
      line(1, 'agent_message_chunk', 'there'),
      line(2, 'agent_message_chunk', '!'),
    ].join('\n');

    const entries = parseGrokContent(content, 'sid');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'assistant-message', seq: 0, markdown: 'Hello there!' });
  });

  it('starts a new entry when the chunk kind changes', () => {
    const content = [
      line(0, 'agent_thought_chunk', 'thinking'),
      line(1, 'agent_message_chunk', 'answer'),
    ].join('\n');

    expect(parseGrokContent(content, 'sid').map((e) => [e.type, e.seq])).toEqual([
      ['thinking', 0],
      ['assistant-message', 1],
    ]);
  });

  it('drops a run whose chunks carry no text', () => {
    expect(parseGrokContent(line(0, 'agent_message_chunk', '   '), 'sid')).toEqual([]);
  });

  it('ignores an unknown sessionUpdate kind instead of reporting an error entry', () => {
    const content = line(0, 'available_commands_update', 'x');
    expect(parseGrokContent(content, 'sid')).toEqual([]);
  });
});

describe('GrokParser incremental reads', () => {
  const withTempSession = async (fn: (jsonlPath: string) => Promise<void>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-parser-'));
    const sessionDir = path.join(dir, 'sid-1234');
    await fs.mkdir(sessionDir, { recursive: true });
    try {
      await fn(path.join(sessionDir, 'updates.jsonl'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  it('re-emits a growing message at the same seq so the client upserts it', async () => {
    await withTempSession(async (jsonlPath) => {
      const chunk = (text: string) => `${JSON.stringify({
        timestamp: 1,
        method: 'session/update',
        params: { sessionId: 'sid-1234', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      })}\n`;

      await fs.writeFile(jsonlPath, chunk('Hel'));
      const parser = createGrokParser(jsonlPath);
      const first = await parser.parseIncremental();
      expect(first.newEntries).toMatchObject([{ seq: 0, markdown: 'Hel' }]);

      await fs.appendFile(jsonlPath, chunk('lo'));
      const second = await parser.parseIncremental();
      expect(second.newEntries).toMatchObject([{ seq: 0, markdown: 'Hello' }]);
    });
  });

  it('re-parses from the head when the file shrinks under a rewind', async () => {
    await withTempSession(async (jsonlPath) => {
      const msg = (text: string) => `${JSON.stringify({
        timestamp: 1,
        method: 'session/update',
        params: { sessionId: 'sid-1234', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } },
      })}\n`;

      await fs.writeFile(jsonlPath, msg('one') + msg('two'));
      const parser = createGrokParser(jsonlPath);
      await parser.parseIncremental();

      await fs.writeFile(jsonlPath, msg('one'));
      const after = await parser.parseIncremental();
      expect(after.newEntries).toMatchObject([{ seq: 0, text: 'one' }]);
    });
  });

  it('holds back a torn trailing record until the rest of the line lands', async () => {
    await withTempSession(async (jsonlPath) => {
      const full = `${JSON.stringify({
        timestamp: 1,
        method: 'session/update',
        params: { sessionId: 'sid-1234', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } },
      })}\n`;

      await fs.writeFile(jsonlPath, full.slice(0, 40));
      const parser = createGrokParser(jsonlPath);
      expect((await parser.parseIncremental()).newEntries).toEqual([]);

      await fs.appendFile(jsonlPath, full.slice(40));
      expect((await parser.parseIncremental()).newEntries).toMatchObject([{ seq: 0, text: 'hi' }]);
    });
  });

  it('parseTail slices the newest entries and reports that more exist', async () => {
    const parser = createGrokParser(path.join(TOOLS, 'updates.jsonl'));
    const tail = await parser.parseTail(3);

    expect(tail.entries).toHaveLength(3);
    expect(tail.hasMore).toBe(true);
    expect(types(tail.entries)).toEqual(['tool-result', 'thinking', 'assistant-message']);
  });
});

describe('readGrokEntriesBefore', () => {
  it('pages backwards by seq and reports whether older entries remain', async () => {
    const jsonlPath = path.join(TOOLS, 'updates.jsonl');
    const page = await readGrokEntriesBefore(jsonlPath, 4, 2);

    expect(page.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(page.hasMore).toBe(true);
    expect(page.startByteOffset).toBe(2);
  });

  it('returns an empty page for a path that does not exist', async () => {
    expect((await readGrokEntriesBefore('/nope/updates.jsonl', 10, 5)).entries).toEqual([]);
  });
});

describe('cost ticks', () => {
  it('converts the recorded costUsdTicks to the dollars the headless run reported', () => {
    expect(100973200 / GROK_COST_TICKS_PER_USD).toBeCloseTo(0.01009732, 8);
  });
});

describe('GrokParser — a tail cut inside a multi-byte character', () => {
  const SESSION = 'sid-1234';

  const line = (kind: string, text: string) => `${JSON.stringify({
    timestamp: 1,
    method: 'session/update',
    params: { sessionId: SESSION, update: { sessionUpdate: kind, content: { type: 'text', text } } },
  })}\n`;

  const withTornFile = async (
    char: string,
    keptBytes: number,
    fn: (ctx: { jsonlPath: string; whole: Buffer; cut: number }) => Promise<void>,
  ) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-torn-'));
    const sessionDir = path.join(dir, SESSION);
    await fs.mkdir(sessionDir, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'updates.jsonl');

    const whole = Buffer.from(
      line('user_message_chunk', 'what is the price') + line('agent_message_chunk', `price 12${char} end`),
      'utf-8',
    );
    const cut = whole.indexOf(Buffer.from(char, 'utf-8')) + keptBytes;
    await fs.writeFile(jsonlPath, whole.subarray(0, cut));

    try {
      await fn({ jsonlPath, whole, cut });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  const CASES: Array<[string, string, number]> = [
    ['a euro sign with 2 of its 3 bytes on disk', '€', 2],
    ['a euro sign with 1 of its 3 bytes on disk', '€', 1],
    ['an e-acute with 1 of its 2 bytes on disk', 'é', 1],
    ['an emoji with 2 of its 4 bytes on disk', '😀', 2],
  ];

  it.each(CASES)('parseTail reports the real byte size for %s', async (_name, char, keptBytes) => {
    await withTornFile(char, keptBytes, async ({ jsonlPath, cut }) => {
      const tail = await createGrokParser(jsonlPath).parseTail(50);
      expect(tail.fileSize).toBe((await fs.stat(jsonlPath)).size);
      expect(tail.fileSize).toBe(cut);
      expect(tail.entries.map((entry) => entry.seq)).toEqual([0]);
    });
  });

  it.each(CASES)('the completing append restores the exact text for %s', async (_name, char, keptBytes) => {
    await withTornFile(char, keptBytes, async ({ jsonlPath, whole, cut }) => {
      const parser = createGrokParser(jsonlPath);
      const tail = await parser.parseTail(50);

      await fs.appendFile(jsonlPath, whole.subarray(cut));
      const live = await parser.parseIncremental();

      const fromWholeFile = parseGrokContent(whole.toString('utf-8'), SESSION);
      // The socket upserts on (id, seq), so the live timeline is the tail
      // followed by every incremental batch applied over it.
      const upserted = new Map(
        [...tail.entries, ...live.newEntries].map((entry) => [entry.id, entry]),
      );

      expect(live.newOffset).toBe((await fs.stat(jsonlPath)).size);
      expect([...upserted.values()]).toEqual(fromWholeFile);
      expect(upserted.get(`grok:${SESSION}:1`)).toMatchObject({
        type: 'assistant-message',
        seq: 1,
        markdown: `price 12${char} end`,
      });
    });
  });

  it.each(CASES)('readGrokEntriesBefore reports the real byte size for %s', async (_name, char, keptBytes) => {
    await withTornFile(char, keptBytes, async ({ jsonlPath }) => {
      const page = await readGrokEntriesBefore(jsonlPath, 99, 10);
      expect(page.fileSize).toBe((await fs.stat(jsonlPath)).size);
    });
  });

  it('never hands a replacement character to the live timeline', async () => {
    await withTornFile('é', 1, async ({ jsonlPath, whole, cut }) => {
      const parser = createGrokParser(jsonlPath);
      const tail = await parser.parseTail(50);
      await fs.appendFile(jsonlPath, whole.subarray(cut));
      const live = await parser.parseIncremental();

      const text = [...tail.entries, ...live.newEntries]
        .map((entry) => JSON.stringify(entry))
        .join('');
      expect(text).not.toContain('�');
    });
  });
});
