import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJsonlContent, readEntriesBefore, readTailEntries } from '@/lib/session-parser';
import { readHistoryPage, readLastSeq } from '@/lib/timeline-history';
import type { ITimelineEntry } from '@/types/timeline';

/**
 * Every chunked reader starts at an arbitrary byte, so its start regularly lands
 * inside a multi-byte character. The entries it returns must carry the same
 * `seq` and `id` a whole-file parse of the same records produces — that identity
 * is the whole point of the deterministic-id work, and the phone upserts on it.
 */

const CHUNK_SIZE = 256_000;
const TAIL_SCAN_BYTES = 65_536;

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

const record = (index: number, padChars: number, tail: string): string => JSON.stringify({
  uuid: `entry-${index}`,
  sessionId: 'multibyte-session',
  timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  type: index % 2 === 0 ? 'user' : 'assistant',
  message: index % 2 === 0
    ? { role: 'user', content: `中文 ${index} 😀 “curly” ${'語'.repeat(padChars)}${tail}` }
    : { role: 'assistant', content: [{ type: 'text', text: `答え ${index} 😀 ${'語'.repeat(padChars)}${tail}` }] },
});

/**
 * `shift` lengthens the LAST record only. A tail-anchored read starts at
 * `size - K`, so growing the file at its end walks that start through the
 * earlier — unchanged — records one byte at a time.
 */
const render = (lines: number, padChars: number, shift: number): string =>
  `${Array.from(
    { length: lines },
    (_, i) => record(i, padChars, i === lines - 1 ? 'x'.repeat(shift) : ''),
  ).join('\n')}\n`;

/**
 * Renders a fixture whose chunk start — `startOf(fileSize)` — falls inside a
 * multi-byte character. Lengthening the last record by `delta` moves that start
 * `delta` bytes further into the earlier, unchanged records, so the delta to the
 * next continuation byte is read off the unshifted rendering.
 */
const fixtureWithMidCharacterStart = (
  lines: number,
  padChars: number,
  startOf: (size: number) => number,
): { content: string; from: number } => {
  const base = Buffer.from(render(lines, padChars, 0), 'utf-8');
  const start = startOf(base.length);
  if (start <= 0) throw new Error('fixture is too small for this reader');

  let delta = 0;
  while (delta < 4096 && !isContinuationByte(base[start + delta])) delta++;
  if (delta >= 4096) throw new Error('no continuation byte near the chunk start');

  const content = render(lines, padChars, delta);
  const from = startOf(Buffer.byteLength(content, 'utf-8'));
  if (!isContinuationByte(Buffer.from(content, 'utf-8')[from])) {
    throw new Error('shifted chunk start did not land inside a multi-byte character');
  }
  return { content, from };
};

const identity = (entries: ITimelineEntry[]): { id: string; seq: number | undefined }[] =>
  entries.map((entry) => ({ id: entry.id, seq: entry.seq }));

const seqOf = (entry: ITimelineEntry): number => entry.seq ?? -1;

describe('chunked readers across a multi-byte character boundary', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-chunk-offsets-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, content: string): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, content, 'utf-8');
    return file;
  };

  it('readTailEntries returns whole-file ids and seqs when the tail chunk starts mid-character', async () => {
    const { content, from } = fixtureWithMidCharacterStart(900, 40, (size) => size - CHUNK_SIZE);
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(CHUNK_SIZE);
    expect(from).toBeGreaterThan(0);

    const file = await write('tail.jsonl', content);
    const whole = parseJsonlContent(content, 0);
    const { entries } = await readTailEntries(file, 50);

    expect(entries.length).toBe(50);
    expect(identity(entries)).toEqual(identity(whole.slice(-50)));
  });

  it('readEntriesBefore returns whole-file ids and seqs when the chunk starts mid-character', async () => {
    const content = render(900, 40, 0);
    const bytes = Buffer.from(content, 'utf-8');
    const file = await write('before.jsonl', content);

    let beforeByte = -1;
    for (let candidate = CHUNK_SIZE + 1; candidate < bytes.length; candidate++) {
      if (isContinuationByte(bytes[candidate - CHUNK_SIZE])) { beforeByte = candidate; break; }
    }
    expect(beforeByte).toBeGreaterThan(0);

    const whole = parseJsonlContent(content, 0);
    const { entries } = await readEntriesBefore(file, beforeByte, 50);

    expect(entries.length).toBeGreaterThan(0);
    // The window ends mid-record, so its final partial line is dropped; what is
    // returned must still be a contiguous run of the whole-file parse.
    const start = whole.findIndex((entry) => entry.id === entries[0].id);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(identity(entries)).toEqual(identity(whole.slice(start, start + entries.length)));
  });

  it('readLastSeq never overshoots the true max seq when the tail scan starts mid-character', async () => {
    const { content } = fixtureWithMidCharacterStart(400, 60, (size) => size - TAIL_SCAN_BYTES);
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(TAIL_SCAN_BYTES);

    const file = await write('lastseq.jsonl', content);
    const whole = parseJsonlContent(content, 0);
    const trueMax = whole.reduce((max, entry) => Math.max(max, seqOf(entry)), -1);

    const lastSeq = await readLastSeq(file, 'claude');

    expect(lastSeq).toBe(trueMax);
  });

  it('a windowed history page agrees with the whole-file parse on a session past the full-parse ceiling', async () => {
    const lines = 400;
    const padChars = 7000;
    const content = render(lines, padChars, 0);
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(8_388_608);

    const file = await write('windowed.jsonl', content);
    const whole = parseJsonlContent(content, 0);

    const paged: ITimelineEntry[] = [];
    let afterSeq = -1;
    for (let guard = 0; guard < 50; guard++) {
      const page = await readHistoryPage({ jsonlPath: file, provider: 'claude', afterSeq, limit: 60 });
      expect(page).not.toBeNull();
      paged.push(...page!.entries);
      afterSeq = page!.nextSeq;
      if (!page!.hasMore) break;
    }

    expect(identity(paged)).toEqual(identity(whole));
    expect(await readLastSeq(file, 'claude')).toBeLessThanOrEqual(
      whole.reduce((max, entry) => Math.max(max, seqOf(entry)), -1),
    );
  });
});
