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
