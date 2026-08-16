import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  parseIncremental,
  parseSessionFile,
  readEntriesBefore,
  readTailEntries,
} from '@/lib/session-parser';
import { hashEntryId } from '@/lib/entry-identity';
import type { ITimelineEntry } from '@/types/timeline';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const userLine = (uuid: string, text: string) => JSON.stringify({
  uuid,
  sessionId: SESSION_ID,
  timestamp: '2026-08-16T00:00:00.000Z',
  type: 'user',
  message: { role: 'user', content: text },
});

const assistantLine = (uuid: string, content: unknown[]) => JSON.stringify({
  uuid,
  sessionId: SESSION_ID,
  timestamp: '2026-08-16T00:00:01.000Z',
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-5', content },
});

const multiEntryContent = (n: number) => [
  { type: 'thinking', thinking: `thought ${n}` },
  { type: 'text', text: `answer ${n}` },
  { type: 'tool_use', id: `toolu_${n}`, name: 'Read', input: { file_path: `/tmp/f${n}.txt` } },
];

const writeSession = async (lines: string[]): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ids-'));
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

const identity = (entries: ITimelineEntry[]) => entries.map((e) => ({ id: e.id, seq: e.seq }));

describe('Claude entry identity', () => {
  it('uses the record uuid as the id when a record yields a single entry', async () => {
    const file = await writeSession([userLine('uuid-user-1', 'hello')]);

    const { entries } = await parseSessionFile(file);

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('uuid-user-1');
    expect(entries[0].seq).toBe(0);
  });

  it('suffixes the id with the ordinal when one record yields several entries', async () => {
    const file = await writeSession([assistantLine('uuid-a-1', multiEntryContent(1))]);

    const { entries } = await parseSessionFile(file);

    expect(entries.map((e) => e.id)).toEqual(['uuid-a-1#0', 'uuid-a-1#1', 'uuid-a-1#2']);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('derives a deterministic hashed id when the record carries no uuid', async () => {
    const line = JSON.stringify({
      sessionId: SESSION_ID,
      timestamp: '2026-08-16T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: 'no uuid here' },
    });
    const file = await writeSession([line]);

    const { entries } = await parseSessionFile(file);

    expect(entries[0].id).toBe(hashEntryId(SESSION_ID, 0, 0));
    expect(entries[0].id).toHaveLength(21);
  });

  it('produces identical ids and seqs when the same file is parsed twice', async () => {
    const file = await writeSession([
      userLine('u1', 'first'),
      assistantLine('a1', multiEntryContent(1)),
      userLine('u2', 'second'),
      assistantLine('a2', multiEntryContent(2)),
    ]);

    const first = await parseSessionFile(file);
    const second = await parseSessionFile(file);

    expect(identity(second.entries)).toEqual(identity(first.entries));
    expect(new Set(first.entries.map((e) => e.id)).size).toBe(first.entries.length);
  });

  it('keeps seq strictly increasing in file order', async () => {
    const file = await writeSession(
      Array.from({ length: 12 }, (_, i) => (i % 2 === 0
        ? userLine(`u${i}`, `message ${i}`)
        : assistantLine(`a${i}`, multiEntryContent(i)))),
    );

    const { entries } = await parseSessionFile(file);
    const seqs = entries.map((e) => e.seq ?? -1);

    expect(seqs[0]).toBe(0);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('gives readTailEntries the same identity a whole-file parse produces', async () => {
    const file = await writeSession(
      Array.from({ length: 10 }, (_, i) => userLine(`u${i}`, `message ${i}`)),
    );

    const full = await parseSessionFile(file);
    const tail = await readTailEntries(file, 4);

    expect(identity(tail.entries)).toEqual(identity(full.entries.slice(-4)));
  });

  it('pages readEntriesBefore backwards with monotonic, non-overlapping seqs', async () => {
    const file = await writeSession(
      Array.from({ length: 20 }, (_, i) => userLine(`u${i}`, `message ${i}`)),
    );

    const full = await parseSessionFile(file);
    const pages: ITimelineEntry[][] = [];
    let before = (await readTailEntries(file, 5)).startByteOffset;
    while (before > 0) {
      const page = await readEntriesBefore(file, before, 5);
      if (page.entries.length === 0) break;
      pages.unshift(page.entries);
      before = page.startByteOffset;
    }

    const paged = pages.flat();
    expect(paged.length).toBeGreaterThan(0);
    expect(identity(paged)).toEqual(identity(full.entries.slice(0, paged.length)));

    const seqs = paged.map((e) => e.seq ?? -1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    expect(new Set(paged.map((e) => e.id)).size).toBe(paged.length);
  });

  it('gives parseIncremental the same identity as a whole-file parse', async () => {
    const head = [userLine('u1', 'first'), assistantLine('a1', multiEntryContent(1))];
    const tail = [userLine('u2', 'second'), assistantLine('a2', multiEntryContent(2))];
    const file = await writeSession(head);
    const headSize = (await fs.stat(file)).size;
    await fs.appendFile(file, `${tail.join('\n')}\n`, 'utf-8');

    const full = await parseSessionFile(file);
    const incremental = await parseIncremental(file, headSize);

    expect(identity(incremental.newEntries)).toEqual(identity(full.entries.slice(head.length + 2)));
  });

  it('resumes identity correctly when a partial line was buffered', async () => {
    const complete = [userLine('u1', 'first')];
    const file = await writeSession(complete);
    const partial = userLine('u2', 'second');
    const split = Math.floor(partial.length / 2);
    await fs.appendFile(file, partial.slice(0, split), 'utf-8');

    const firstPass = await parseIncremental(file, (await fs.stat(file)).size - split);
    expect(firstPass.newEntries).toHaveLength(0);
    expect(firstPass.pendingBuffer).toBe(partial.slice(0, split));

    await fs.appendFile(file, `${partial.slice(split)}\n`, 'utf-8');
    const secondPass = await parseIncremental(file, firstPass.newOffset, firstPass.pendingBuffer);
    const full = await parseSessionFile(file);

    expect(identity(secondPass.newEntries)).toEqual(identity(full.entries.slice(1)));
  });

  it('assigns every entry an id and a seq across the full record vocabulary', async () => {
    const toolCall = assistantLine('a-tool', [
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls -la' } },
    ]);
    const toolResult = JSON.stringify({
      uuid: 'u-result',
      sessionId: SESSION_ID,
      timestamp: '2026-08-16T00:00:03.000Z',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
      },
    });
    const interrupt = JSON.stringify({
      uuid: 'u-interrupt',
      sessionId: SESSION_ID,
      timestamp: '2026-08-16T00:00:04.000Z',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    });
    const turnEnd = JSON.stringify({
      uuid: 'u-system',
      sessionId: SESSION_ID,
      timestamp: '2026-08-16T00:00:05.000Z',
      type: 'system',
      subtype: 'turn_duration',
    });
    const attachment = JSON.stringify({
      uuid: 'u-attachment',
      sessionId: SESSION_ID,
      timestamp: '2026-08-16T00:00:06.000Z',
      type: 'attachment',
      attachment: { type: 'plan_file_reference', planFilePath: '/tmp/plan.md', planContent: '# plan' },
    });
    const file = await writeSession([
      userLine('u0', 'start'),
      toolCall,
      toolResult,
      interrupt,
      turnEnd,
      attachment,
    ]);

    const { entries } = await parseSessionFile(file);

    expect(entries.length).toBeGreaterThan(6);
    for (const entry of entries) {
      expect(entry.id).not.toBe('');
      expect(typeof entry.seq).toBe('number');
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(entries.map((e) => e.type)).toContain('turn-end');
    expect(entries.map((e) => e.type)).toContain('interrupt');
    expect(entries.map((e) => e.type)).toContain('plan');
  });

  it('numbers agent-group children within the group and the group itself in the parent session', async () => {
    const agentCall = assistantLine('a-agent', [
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'Explore', description: 'look around' } },
    ]);
    const sidechain = (uuid: string, text: string) => JSON.stringify({
      uuid,
      sessionId: SESSION_ID,
      timestamp: '2026-08-16T00:00:02.000Z',
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: text },
    });
    const file = await writeSession([
      userLine('u0', 'kick off'),
      agentCall,
      sidechain('s1', 'sub one'),
      sidechain('s2', 'sub two'),
      userLine('u1', 'done'),
    ]);

    const { entries } = await parseSessionFile(file);
    const group = entries.find((e) => e.type === 'agent-group');

    expect(group).toBeDefined();
    if (group?.type !== 'agent-group') throw new Error('expected an agent-group');
    expect(group.id).toBe('s1#group');
    expect(group.entries.map((e) => e.id)).toEqual(['s1', 's2']);
    expect(group.entries.map((e) => e.seq)).toEqual([0, 1]);

    const parentSeqs = entries.map((e) => e.seq ?? -1);
    for (let i = 1; i < parentSeqs.length; i++) {
      expect(parentSeqs[i]).toBeGreaterThan(parentSeqs[i - 1]);
    }
  });
});
