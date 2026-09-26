import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  MONITOR_EXPIRY_GRACE_MS,
  __testing,
  applyBackgroundLine,
  createBackgroundLedger,
  latestBackgroundActivityAt,
  openBackgroundTasks,
  readBackgroundLedger,
} from '@/lib/providers/claude/background-ledger';

const FIXTURES = path.join(__dirname, '../../fixtures/claude-background');
const at = (iso: string) => Date.parse(iso);

const fixtureLines = async (name: string): Promise<string[]> =>
  (await fs.readFile(path.join(FIXTURES, name), 'utf-8')).split('\n').filter((l) => l.trim());

const ledgerOf = (lines: string[]) => {
  const ledger = createBackgroundLedger();
  for (const line of lines) applyBackgroundLine(ledger, line);
  return ledger;
};

const openIds = (lines: string[], now: number) =>
  openBackgroundTasks(ledgerOf(lines), now).map((t) => t.id).sort();

const toolResult = (tur: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user',
  isSidechain: false,
  timestamp: '2026-09-26T01:00:00.000Z',
  message: { content: [{ type: 'tool_result', content: 'x' }] },
  toolUseResult: tur,
  ...extra,
});

describe('background ledger — Claude Code 2.1.283 shapes', () => {
  it('keeps exactly the async agent and the live monitor open at the end of the recorded turn', async () => {
    const lines = await fixtureLines('shapes-2.1.283.jsonl');
    expect(openIds(lines, at('2026-09-26T02:35:00.000Z'))).toEqual(['aagent0001', 'bmon0001']);
  });

  it('closes the agent on a task notification delivered as a user message', async () => {
    const lines = [...await fixtureLines('shapes-2.1.283.jsonl'), ...await fixtureLines('agent-completed.jsonl')];
    expect(openIds(lines, at('2026-09-26T02:35:00.000Z'))).toEqual(['bmon0001']);
  });

  it('ends a monitor at its deadline plus grace even when no expiry notice was written', async () => {
    const lines = await fixtureLines('shapes-2.1.283.jsonl');
    const deadline = at('2026-09-26T02:04:00.000Z') + 30 * 60 * 1000;
    expect(openIds(lines, deadline + MONITOR_EXPIRY_GRACE_MS)).toContain('bmon0001');
    expect(openIds(lines, deadline + MONITOR_EXPIRY_GRACE_MS + 1)).not.toContain('bmon0001');
  });

  it('records a monitor event as activity without ending the monitor', async () => {
    const ledger = ledgerOf(await fixtureLines('shapes-2.1.283.jsonl'));
    expect(ledger.lastEventAt.get('bmon0001')).toBe(at('2026-09-26T02:10:00.000Z'));
  });

  it('counts the shell moved to the background on its timeout until its attachment notification', async () => {
    const lines = await fixtureLines('shapes-2.1.283.jsonl');
    const upToStart = lines.findIndex((l) => l.includes('bshell02')) + 1;
    expect(openIds(lines.slice(0, upToStart), at('2026-09-26T02:03:00.000Z'))).toContain('bshell02');
    expect(openIds(lines, at('2026-09-26T02:35:00.000Z'))).not.toContain('bshell02');
  });

  it('ends a shell stopped with TaskStop', async () => {
    const lines = await fixtureLines('shapes-2.1.283.jsonl');
    const beforeStop = lines.findIndex((l) => l.includes('Successfully stopped'));
    expect(openIds(lines.slice(0, beforeStop), at('2026-09-26T02:13:30.000Z'))).toContain('bshell03');
    expect(openIds(lines, at('2026-09-26T02:35:00.000Z'))).not.toContain('bshell03');
  });

  it('never opens a task from quoted text, a sidechain entry or assistant text', async () => {
    const ids = [...ledgerOf(await fixtureLines('shapes-2.1.283.jsonl')).open.keys()];
    expect(ids).not.toContain('bquoted1');
    expect(ids).not.toContain('aquoted1');
    expect(ids).not.toContain('bquoted2');
    expect(ids).not.toContain('bside01');
  });

  it('ignores a notification a person quotes inside a longer message', () => {
    const start = toolResult({ backgroundTaskId: 'bq1' });
    const quoted = JSON.stringify({
      type: 'user',
      message: { content: 'please look at <task-notification><task-id>bq1</task-id><status>completed</status></task-notification>' },
    });
    expect(openIds([start, quoted], 0)).toEqual(['bq1']);
  });

  it('reopens an agent resumed with SendMessage until it finishes again', async () => {
    const base = [...await fixtureLines('shapes-2.1.283.jsonl'), ...await fixtureLines('agent-completed.jsonl')];
    const resumed = [...base, ...await fixtureLines('agent-resumed.jsonl')];
    const now = at('2026-09-26T02:45:00.000Z');
    expect(openIds(base, now)).not.toContain('aagent0001');
    expect(openIds(resumed, now)).toContain('aagent0001');
    expect(openIds([...resumed, ...await fixtureLines('agent-finished-again.jsonl')], now)).not.toContain('aagent0001');
  });

  it('ignores the queue removing a notification it already delivered', () => {
    const start = toolResult({ backgroundTaskId: 'bz1' });
    const removed = JSON.stringify({
      type: 'queue-operation',
      operation: 'remove',
      content: '<task-notification>\n<task-id>bz1</task-id>\n<status>killed</status>\n</task-notification>',
    });
    expect(openIds([start, removed], 0)).toEqual(['bz1']);
  });

  it('does not end a Monitor whose event text quotes a status tag', () => {
    const start = toolResult({ taskId: 'bm1', timeoutMs: 10 ** 12 });
    const event = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification>\n<task-id>bm1</task-id>\n<summary>Monitor event</summary>\n<event>grep hit: <status>completed</status></event>\n</task-notification>',
    });
    expect(openIds([start, event], 0)).toEqual(['bm1']);
  });

  it('skips malformed lines and lines with no background hint', () => {
    expect(openIds(['{not json backgroundTaskId', '{"type":"user"}', ''], 0)).toEqual([]);
  });
});

describe('readBackgroundLedger — whole transcript, incremental', () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    __testing.ledgers.clear();
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('finds a start 20 turns and >1 MB before the stop (the 8 KB tail read 0 on 2026-09-26)', async () => {
    const dir = await tmp();
    const file = path.join(dir, 's.jsonl');
    const filler = JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(60_000) }] } });
    const lines = [toolResult({ backgroundTaskId: 'bearly1' })];
    for (let i = 0; i < 20; i++) lines.push(filler);
    await fs.writeFile(file, lines.join('\n') + '\n');
    const ledger = await readBackgroundLedger(file);
    expect(openBackgroundTasks(ledger, Date.now()).map((t) => t.id)).toEqual(['bearly1']);
  });

  it('reads only appended bytes and waits for a partial last line', async () => {
    const dir = await tmp();
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, toolResult({ backgroundTaskId: 'b1' }) + '\n');
    await readBackgroundLedger(file);
    const done = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' });
    await fs.appendFile(file, done.slice(0, 40));
    expect((await readBackgroundLedger(file)).open.has('b1')).toBe(true);
    await fs.appendFile(file, done.slice(40) + '\n');
    expect((await readBackgroundLedger(file)).open.has('b1')).toBe(false);
  });

  it('starts over when the file is truncated or replaced', async () => {
    const dir = await tmp();
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, toolResult({ backgroundTaskId: 'b1' }) + '\n' + toolResult({ backgroundTaskId: 'b2' }) + '\n');
    expect((await readBackgroundLedger(file)).open.size).toBe(2);
    await fs.writeFile(file, toolResult({ backgroundTaskId: 'b3' }) + '\n');
    expect([...(await readBackgroundLedger(file)).open.keys()]).toEqual(['b3']);
  });

  it('reports the newest activity across output files, subagent transcripts and monitor events', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'sess.jsonl');
    const tasks = path.join(dir, 'tasks');
    const subagents = path.join(dir, 'sess', 'subagents');
    await fs.mkdir(tasks, { recursive: true });
    await fs.mkdir(subagents, { recursive: true });
    await fs.writeFile(path.join(tasks, 'bshell.output'), '');
    await fs.writeFile(path.join(tasks, 'bmon.output'), '');
    await fs.writeFile(path.join(subagents, 'agent-a1.jsonl'), '');
    const start = (tur: Record<string, unknown>, text = 'x') => JSON.stringify({
      type: 'user', timestamp: '2026-09-26T01:00:00.000Z',
      message: { content: [{ type: 'tool_result', content: text }] }, toolUseResult: tur,
    });
    await fs.writeFile(file, [
      start({ backgroundTaskId: 'bshell' }, `Output is being written to: ${path.join(tasks, 'bshell.output')}. You will be notified`),
      start({ taskId: 'bmon', timeoutMs: 10 ** 12 }),
    ].join('\n') + '\n');
    const old = new Date('2026-09-26T01:00:00.000Z');
    await fs.utimes(file, old, old);
    await fs.utimes(path.join(tasks, 'bshell.output'), old, old);
    await fs.utimes(path.join(subagents, 'agent-a1.jsonl'), old, old);
    const newer = new Date('2026-09-26T01:30:00.000Z');
    await fs.utimes(path.join(tasks, 'bmon.output'), newer, newer);

    const ledger = await readBackgroundLedger(file);
    const now = at('2026-09-26T02:00:00.000Z');
    expect(await latestBackgroundActivityAt(file, ledger, now)).toBe(newer.getTime());

    const newest = new Date('2026-09-26T01:45:00.000Z');
    await fs.utimes(path.join(subagents, 'agent-a1.jsonl'), newest, newest);
    expect(await latestBackgroundActivityAt(file, ledger, now)).toBe(newest.getTime());
  });
});

// Story 37: tab-dTsAzt got four READY nudges on 2026-09-26 while three shells ran.
// A subagent's foreground Bash, moved to the background on its timeout just before
// the subagent returned, is recorded only in `<session>/subagents/agent-<id>.jsonl`
// (sidechain lines); its completion lands later in the main transcript.
describe('readBackgroundLedger — shells a subagent started (story 37)', () => {
  const FIXTURE = path.join(FIXTURES, 'subagent-shells', 'sess-1.jsonl');
  afterEach(() => __testing.ledgers.clear());

  const openAt = async (file: string, iso: string) =>
    openBackgroundTasks(await readBackgroundLedger(file), at(iso)).map((t) => `${t.kind}:${t.id}`).sort();

  /** The fixture session as the server saw it at `iso`: every file cut to the lines written by then. */
  const replayAt = async (iso: string): Promise<string[]> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-'));
    try {
      const upTo = (text: string) => text.split('\n').filter((l) => l.trim() && Date.parse(JSON.parse(l).timestamp) <= at(iso)).map((l) => `${l}\n`).join('');
      const srcSub = path.join(path.dirname(FIXTURE), 'sess-1', 'subagents');
      const sub = path.join(dir, 'sess-1', 'subagents');
      await fs.mkdir(sub, { recursive: true });
      await fs.writeFile(path.join(dir, 'sess-1.jsonl'), upTo(await fs.readFile(FIXTURE, 'utf-8')));
      for (const name of await fs.readdir(srcSub)) {
        const text = await fs.readFile(path.join(srcSub, name), 'utf-8');
        await fs.writeFile(path.join(sub, name), name.endsWith('.jsonl') ? upTo(text) : text);
      }
      return await openAt(path.join(dir, 'sess-1.jsonl'), iso);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  it('replays tab-dTsAzt: 3 open shells at the 15:49:47 and 15:52:55 nudges, none from the main agent', async () => {
    // Only the main file: the defect (every start is in a subagent file).
    const mainOnly = ledgerOf(await fixtureLines('subagent-shells/sess-1.jsonl'));
    expect(openBackgroundTasks(mainOnly, at('2026-09-26T15:52:55.000Z'))).toEqual([]);
    expect(await replayAt('2026-09-26T15:49:47.000Z')).toEqual(['shell:b1tu3atis', 'shell:b6qc6fwtg', 'shell:bqk1wfdeb']);
    expect(await replayAt('2026-09-26T15:52:55.000Z')).toEqual(['shell:b1tu3atis', 'shell:bchsaon9x', 'shell:bqk1wfdeb']);
    // Before any subagent shell, only the resumed agent a749e9c8 is open.
    expect(await replayAt('2026-09-26T15:40:00.000Z')).toEqual(['agent:a749e9c84f6955c4c']);
  });

  it('a subagent shell closes on its completion in the main transcript', async () => {
    // b6qc6fwtg ended at 15:50:30 in both files; the main-file end alone closes it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-'));
    try {
      const file = path.join(dir, 's.jsonl');
      const sub = path.join(dir, 's', 'subagents');
      await fs.mkdir(sub, { recursive: true });
      await fs.writeFile(path.join(sub, 'agent-a1.jsonl'), JSON.stringify({
        type: 'user', isSidechain: true, agentId: 'a1', timestamp: '2026-09-26T01:00:00.000Z',
        message: { content: [{ type: 'tool_result', content: 'moved to the background' }] }, toolUseResult: { backgroundTaskId: 'bsub1' },
      }) + '\n');
      await fs.writeFile(file, '');
      expect(await openAt(file, '2026-09-26T01:05:00.000Z')).toEqual(['shell:bsub1']);
      await fs.appendFile(file, JSON.stringify({
        type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-26T01:10:00.000Z',
        content: '<task-notification>\n<task-id>bsub1</task-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n');
      expect(await openAt(file, '2026-09-26T01:11:00.000Z')).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a subagent file\'s own harness notification (prefixed, origin task-notification) ends the task', () => {
    const ledger = createBackgroundLedger();
    applyBackgroundLine(ledger, JSON.stringify({
      type: 'user', isSidechain: true, timestamp: '2026-09-26T01:00:00.000Z',
      message: { content: [{ type: 'tool_result', content: 'x' }] }, toolUseResult: { backgroundTaskId: 'bs' },
    }), 'subagent');
    expect([...ledger.open.keys()]).toEqual(['bs']);
    applyBackgroundLine(ledger, JSON.stringify({
      type: 'user', isSidechain: true, isMeta: true, timestamp: '2026-09-26T01:01:00.000Z', origin: { kind: 'task-notification' },
      message: { content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nautomated.\n\n<task-notification>\n<task-id>bs</task-id>\n<status>completed</status>\n</task-notification>' },
    }), 'subagent');
    expect(ledger.open.size).toBe(0);
    expect(ledger.endedAt.get('bs')).toBe(at('2026-09-26T01:01:00.000Z'));
  });

  it('a person quoting a notification (no harness origin) still ends nothing', () => {
    const ledger = createBackgroundLedger();
    applyBackgroundLine(ledger, toolResult({ backgroundTaskId: 'bq' }));
    applyBackgroundLine(ledger, JSON.stringify({
      type: 'user', timestamp: '2026-09-26T01:02:00.000Z',
      message: { content: 'look: <task-notification><task-id>bq</task-id><status>completed</status></task-notification>' },
    }));
    expect([...ledger.open.keys()]).toEqual(['bq']);
  });

  it('the main file still ignores sidechain lines; a subagent file reads them', () => {
    const line = JSON.stringify({
      type: 'user', isSidechain: true, timestamp: '2026-09-26T01:00:00.000Z',
      message: { content: [{ type: 'tool_result', content: 'x' }] }, toolUseResult: { backgroundTaskId: 'bside' },
    });
    const main = createBackgroundLedger();
    applyBackgroundLine(main, line);
    expect(main.open.size).toBe(0);
    const sub = createBackgroundLedger();
    applyBackgroundLine(sub, line, 'subagent');
    expect([...sub.open.keys()]).toEqual(['bside']);
  });

  it('an agent resumed after its end (same id) is open again; an end in another file before the resume does not close it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-'));
    try {
      const file = path.join(dir, 's.jsonl');
      const sub = path.join(dir, 's', 'subagents');
      await fs.mkdir(sub, { recursive: true });
      const note = (ts: string) => JSON.stringify({
        type: 'user', isSidechain: true, timestamp: ts, origin: { kind: 'task-notification' },
        message: { content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><task-id>aX</task-id><status>completed</status></task-notification>' },
      });
      // An earlier end of aX recorded in a subagent file (01:00), then a resume in main (02:00).
      await fs.writeFile(path.join(sub, 'agent-a2.jsonl'), note('2026-09-26T01:00:00.000Z') + '\n');
      await fs.writeFile(file, toolResult({ resumedAgentId: 'aX' }, { timestamp: '2026-09-26T02:00:00.000Z' }) + '\n');
      expect(await openAt(file, '2026-09-26T02:05:00.000Z')).toEqual(['agent:aX']);
      // Its next end (03:00), wherever it is written, closes it.
      await fs.appendFile(path.join(sub, 'agent-a2.jsonl'), note('2026-09-26T03:00:00.000Z') + '\n');
      expect(await openAt(file, '2026-09-26T03:05:00.000Z')).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a subagent file added after the first read is picked up; files are read incrementally', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-'));
    try {
      const file = path.join(dir, 's.jsonl');
      await fs.writeFile(file, '');
      expect(await openAt(file, '2026-09-26T01:05:00.000Z')).toEqual([]);
      const sub = path.join(dir, 's', 'subagents');
      await fs.mkdir(sub, { recursive: true });
      const start = JSON.stringify({
        type: 'user', isSidechain: true, timestamp: '2026-09-26T01:00:00.000Z',
        message: { content: [{ type: 'tool_result', content: 'x' }] }, toolUseResult: { backgroundTaskId: 'blate' },
      });
      await fs.writeFile(path.join(sub, 'agent-a3.jsonl'), start + '\n');
      await fs.writeFile(path.join(sub, 'agent-a3.meta.json'), '{}');
      expect(await openAt(file, '2026-09-26T01:05:00.000Z')).toEqual(['shell:blate']);
      expect(__testing.ledgers.has(path.join(sub, 'agent-a3.jsonl'))).toBe(true);
      expect(__testing.ledgers.has(path.join(sub, 'agent-a3.meta.json'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
