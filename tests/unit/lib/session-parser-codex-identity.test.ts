import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CodexParser,
  codexSessionIdFromJsonlPath,
  readCodexEntriesBefore,
} from '@/lib/session-parser-codex';
import { hashEntryId } from '@/lib/entry-identity';
import type { ITimelineEntry } from '@/types/timeline';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const userLine = (idx: number) => JSON.stringify({
  timestamp: `2026-08-16T00:00:${String(idx).padStart(2, '0')}.000Z`,
  type: 'event_msg',
  payload: { type: 'user_message', message: `message ${idx}` },
});

const agentLine = (idx: number) => JSON.stringify({
  timestamp: `2026-08-16T00:01:${String(idx).padStart(2, '0')}.000Z`,
  type: 'event_msg',
  payload: { type: 'agent_message', message: `reply ${idx}` },
});

const writeSession = async (lines: string[]): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-codex-ids-'));
  const file = path.join(dir, `rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

const identity = (entries: ITimelineEntry[]) => entries.map((e) => ({ id: e.id, seq: e.seq }));

const conversation = (count: number) =>
  Array.from({ length: count }, (_, i) => (i % 2 === 0 ? userLine(i) : agentLine(i)));

describe('codexSessionIdFromJsonlPath', () => {
  it('reads the session uuid out of the rollout filename', () => {
    expect(codexSessionIdFromJsonlPath(`/tmp/rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`))
      .toBe(SESSION_ID);
  });

  it('returns an empty id for a filename with no uuid', () => {
    expect(codexSessionIdFromJsonlPath('/tmp/not-a-rollout.jsonl')).toBe('');
  });
});

describe('Codex entry identity', () => {
  it('derives ids from sha1(sessionId:byteOffset:ordinal), truncated to 21 chars', async () => {
    const lines = conversation(3);
    const file = await writeSession(lines);

    const { entries } = await new CodexParser(file).parseAll();

    let offset = 0;
    for (const [idx, line] of lines.entries()) {
      expect(entries[idx].id).toBe(hashEntryId(SESSION_ID, offset, 0));
      expect(entries[idx].id).toHaveLength(21);
      expect(entries[idx].seq).toBe(offset);
      offset += Buffer.byteLength(line, 'utf-8') + 1;
    }
  });

  it('assigns every entry an id and a seq across a mixed record vocabulary', async () => {
    const lines = [
      userLine(0),
      JSON.stringify({
        timestamp: '2026-08-16T00:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: '/tmp/a.txt' }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-16T00:02:01.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
      }),
      JSON.stringify({
        timestamp: '2026-08-16T00:02:02.000Z',
        type: 'event_msg',
        payload: { type: 'exec_command_begin', call_id: 'exec-1', command: ['ls'], cwd: '/tmp' },
      }),
      JSON.stringify({
        timestamp: '2026-08-16T00:02:03.000Z',
        type: 'event_msg',
        payload: { type: 'exec_command_end', call_id: 'exec-1', exit_code: 0, duration: '1ms' },
      }),
      JSON.stringify({
        timestamp: '2026-08-16T00:02:04.000Z',
        type: 'event_msg',
        payload: { type: 'context_compacted' },
      }),
      agentLine(1),
    ];
    const file = await writeSession(lines);

    const { entries } = await new CodexParser(file).parseAll();

    expect(entries.length).toBeGreaterThan(4);
    for (const entry of entries) {
      expect(entry.id).not.toBe('');
      expect(typeof entry.seq).toBe('number');
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('gives flushed in-flight entries stable ids keyed on the call id', async () => {
    const file = await writeSession([
      userLine(0),
      JSON.stringify({
        timestamp: '2026-08-16T00:03:00.000Z',
        type: 'event_msg',
        payload: { type: 'exec_command_begin', call_id: 'exec-never-ends', command: ['sleep'], cwd: '/tmp' },
      }),
    ]);

    const first = new CodexParser(file);
    await first.parseAll();
    const flushed = first.flushStale(1_000);

    expect(flushed.length).toBeGreaterThan(0);
    for (const entry of flushed) {
      expect(entry.id).not.toBe('');
      expect(typeof entry.seq).toBe('number');
    }
    expect(new Set(flushed.map((e) => e.id)).size).toBe(flushed.length);

    const second = new CodexParser(file);
    await second.parseAll();
    expect(identity(second.flushStale(1_000))).toEqual(identity(flushed));
  });

  it('produces identical ids and seqs when the same file is parsed twice', async () => {
    const file = await writeSession(conversation(8));

    const first = await new CodexParser(file).parseAll();
    const second = await new CodexParser(file).parseAll();

    expect(identity(second.entries)).toEqual(identity(first.entries));
    expect(new Set(first.entries.map((e) => e.id)).size).toBe(first.entries.length);
  });

  it('keeps seq strictly increasing in file order', async () => {
    const file = await writeSession(conversation(10));

    const { entries } = await new CodexParser(file).parseAll();
    const seqs = entries.map((e) => e.seq ?? -1);

    expect(seqs[0]).toBe(0);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('gives parseTail the same identity a whole-file parse produces', async () => {
    const file = await writeSession(conversation(10));

    const full = await new CodexParser(file).parseAll();
    const tail = await new CodexParser(file).parseTail(4);

    expect(identity(tail.entries)).toEqual(identity(full.entries.slice(-4)));
  });

  it('gives readCodexEntriesBefore identity that matches a whole-file parse', async () => {
    const file = await writeSession(conversation(12));

    const full = await new CodexParser(file).parseAll();
    const tail = await new CodexParser(file).parseTail(4);
    const page = await readCodexEntriesBefore(file, tail.startByteOffset, 4);

    expect(page.entries.length).toBeGreaterThan(0);
    const byId = new Map(full.entries.map((e) => [e.id, e.seq]));
    for (const entry of page.entries) {
      expect(byId.has(entry.id)).toBe(true);
      expect(entry.seq).toBe(byId.get(entry.id));
    }

    const seqs = page.entries.map((e) => e.seq ?? -1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('gives parseIncremental the same identity as a whole-file parse', async () => {
    const head = conversation(4);
    const tail = conversation(4).map((_, i) => userLine(100 + i));
    const file = await writeSession(head);

    const parser = new CodexParser(file);
    const initial = await parser.parseAll();
    await fs.appendFile(file, `${tail.join('\n')}\n`, 'utf-8');
    const appended = await parser.parseIncremental();

    const full = await new CodexParser(file).parseAll();
    expect(identity([...initial.entries, ...appended.newEntries])).toEqual(identity(full.entries));
  });

  it('resumes identity correctly when a partial line was buffered', async () => {
    const file = await writeSession(conversation(2));
    const parser = new CodexParser(file);
    await parser.parseAll();

    const partial = userLine(50);
    const split = Math.floor(partial.length / 2);
    await fs.appendFile(file, partial.slice(0, split), 'utf-8');
    const firstPass = await parser.parseIncremental();
    expect(firstPass.newEntries).toHaveLength(0);

    await fs.appendFile(file, `${partial.slice(split)}\n`, 'utf-8');
    const secondPass = await parser.parseIncremental();

    const full = await new CodexParser(file).parseAll();
    expect(identity(secondPass.newEntries)).toEqual(identity(full.entries.slice(2)));
  });
});
