import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIncremental, parseJsonlContent } from '@/lib/session-parser';
import { createCodexParser } from '@/lib/session-parser-codex';
import type { ITimelineEntry } from '@/types/timeline';

/**
 * F9: an append can tear a multi-byte character in half. The remainder is
 * carried to the next read, so it must be carried as BYTES — decoding it first
 * turns the orphaned lead bytes into U+FFFD, which can never be re-joined with
 * the continuation bytes that arrive next, and which `Buffer.byteLength` then
 * charges 3 bytes, shifting every `seq` in the batch.
 */

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REPLACEMENT = '�';

const claudeRecord = (index: number, text: string): string => JSON.stringify({
  uuid: `entry-${index}`,
  sessionId: SESSION_ID,
  timestamp: `2026-08-16T00:00:${String(index).padStart(2, '0')}.000Z`,
  type: 'user',
  message: { role: 'user', content: text },
});

const codexMeta = (): string => JSON.stringify({
  timestamp: '2026-08-16T00:00:00.000Z',
  type: 'session_meta',
  payload: { id: SESSION_ID, timestamp: '2026-08-16T00:00:00.000Z', cwd: '/work/alpha' },
});

const codexUser = (index: number, text: string): string => JSON.stringify({
  timestamp: `2026-08-16T00:00:${String(index).padStart(2, '0')}.000Z`,
  type: 'event_msg',
  payload: { type: 'user_message', message: text },
});

/** The byte one past the start of a multi-byte character at or after `from`. */
const midCharacterByte = (bytes: Buffer, from: number): number => {
  for (let at = from; at < bytes.length; at++) {
    if (bytes[at] >= 0xc0) return at + 1;
  }
  throw new Error('fixture holds no multi-byte character after the split point');
};

const identity = (entries: ITimelineEntry[]) => entries.map((entry) => ({ id: entry.id, seq: entry.seq }));

const textOf = (entries: ITimelineEntry[]): string[] =>
  entries.flatMap((entry) => ('text' in entry && typeof entry.text === 'string' ? [entry.text] : []));

describe('a torn multi-byte append', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-torn-append-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeBytes = async (name: string, bytes: Buffer): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes);
    return file;
  };

  it('rejoins the character across two claude reads, byte-exact and with whole-file seqs', async () => {
    const first = claudeRecord(0, 'first line, plain ascii');
    const second = claudeRecord(1, '中文 😀 “curly” tail');
    const full = Buffer.from(`${first}\n${second}\n`, 'utf-8');
    const cut = midCharacterByte(full, Buffer.byteLength(`${first}\n`, 'utf-8'));

    const file = await writeBytes('claude-torn.jsonl', full.subarray(0, cut));
    const opening = await parseIncremental(file, 0);

    await fs.appendFile(file, full.subarray(cut));
    const closing = await parseIncremental(file, opening.newOffset, opening.pendingBuffer);

    const entries = [...opening.newEntries, ...closing.newEntries];
    const whole = parseJsonlContent(full.toString('utf-8'), 0);

    expect(identity(entries)).toEqual(identity(whole));
    expect(textOf(entries)).toEqual(textOf(whole));
    expect(textOf(entries)[1]).toContain('中文 😀 “curly”');
    expect(JSON.stringify(entries)).not.toContain(REPLACEMENT);
    expect(closing.newOffset).toBe(full.length);
  });

  it('rejoins the character across two codex reads, with the same ids and seqs', async () => {
    const meta = codexMeta();
    const one = codexUser(1, 'ascii only');
    const two = codexUser(2, '中文 😀 “curly” tail');
    const full = Buffer.from(`${meta}\n${one}\n${two}\n`, 'utf-8');
    const cut = midCharacterByte(full, Buffer.byteLength(`${meta}\n${one}\n`, 'utf-8'));

    const file = await writeBytes(`rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`, full.subarray(0, cut));

    const streaming = createCodexParser(file);
    const opening = await streaming.parseIncremental();
    await fs.appendFile(file, full.subarray(cut));
    const closing = await streaming.parseIncremental();
    const entries = [...opening.newEntries, ...closing.newEntries];

    const wholeFile = createCodexParser(file);
    const whole = await wholeFile.parseAll();

    expect(identity(entries)).toEqual(identity(whole.entries));
    expect(textOf(entries)).toEqual(textOf(whole.entries));
    expect(JSON.stringify(entries)).not.toContain(REPLACEMENT);
  });

  it('carries a torn tail through several reads until the character completes', async () => {
    const first = claudeRecord(0, 'ascii');
    const second = claudeRecord(1, '答え 😀 done');
    const full = Buffer.from(`${first}\n${second}\n`, 'utf-8');
    const cut = midCharacterByte(full, Buffer.byteLength(`${first}\n`, 'utf-8'));

    const file = await writeBytes('claude-drip.jsonl', full.subarray(0, cut));

    let offset = 0;
    let pending = undefined as Buffer | undefined;
    const entries: ITimelineEntry[] = [];
    const result = async () => {
      const page = await parseIncremental(file, offset, pending);
      offset = page.newOffset;
      pending = page.pendingBuffer;
      entries.push(...page.newEntries);
    };

    await result();
    for (let at = cut; at < full.length; at++) {
      await fs.appendFile(file, full.subarray(at, at + 1));
      await result();
    }

    const whole = parseJsonlContent(full.toString('utf-8'), 0);
    expect(identity(entries)).toEqual(identity(whole));
    expect(JSON.stringify(entries)).not.toContain(REPLACEMENT);
  });
});

/**
 * The smaller alternative fix — cut every read at its last newline — would have
 * deferred a finished record to whenever its newline lands. These assert the
 * timing so a later refactor cannot adopt it by accident.
 */
describe('a complete record with no trailing newline still emits on the append that finished it', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-early-emit-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('emits an unterminated claude record immediately, and does not repeat it', async () => {
    const first = claudeRecord(0, 'terminated');
    const second = claudeRecord(1, 'unterminated 中文');
    const file = path.join(dir, 'claude-early.jsonl');
    await fs.writeFile(file, `${first}\n`, 'utf-8');

    const opening = await parseIncremental(file, 0);
    expect(opening.newEntries).toHaveLength(1);

    await fs.appendFile(file, second, 'utf-8');
    const early = await parseIncremental(file, opening.newOffset, opening.pendingBuffer);

    expect(early.newEntries).toHaveLength(1);
    expect(textOf(early.newEntries)).toEqual(['unterminated 中文']);
    expect(early.pendingBuffer).toHaveLength(0);

    await fs.appendFile(file, '\n', 'utf-8');
    const afterNewline = await parseIncremental(file, early.newOffset, early.pendingBuffer);
    expect(afterNewline.newEntries).toHaveLength(0);
  });

  it('emits an unterminated codex record immediately', async () => {
    const file = path.join(dir, `rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${codexMeta()}\n`, 'utf-8');

    const streaming = createCodexParser(file);
    await streaming.parseIncremental();

    await fs.appendFile(file, codexUser(1, 'unterminated 中文'), 'utf-8');
    const early = await streaming.parseIncremental();

    expect(textOf(early.newEntries)).toEqual(['unterminated 中文']);
    expect(early.pendingBuffer).toHaveLength(0);

    await fs.appendFile(file, '\n', 'utf-8');
    expect((await streaming.parseIncremental()).newEntries).toHaveLength(0);
  });

  it('holds back a record whose JSON is not finished yet', async () => {
    const file = path.join(dir, 'claude-partial.jsonl');
    const record = claudeRecord(0, 'still writing');
    await fs.writeFile(file, record.slice(0, record.length - 5), 'utf-8');

    const held = await parseIncremental(file, 0);
    expect(held.newEntries).toHaveLength(0);
    expect(held.pendingBuffer.length).toBeGreaterThan(0);

    await fs.appendFile(file, `${record.slice(record.length - 5)}\n`, 'utf-8');
    const released = await parseIncremental(file, held.newOffset, held.pendingBuffer);
    expect(released.newEntries).toHaveLength(1);
  });
});
