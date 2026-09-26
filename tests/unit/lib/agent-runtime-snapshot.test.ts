import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readClaudeRuntimeSnapshot } from '@/lib/providers/claude/runtime-snapshot';
import { readCodexRuntimeSnapshot } from '@/lib/providers/codex/runtime-snapshot';
import { summarizeGrokEntries } from '@/lib/providers/grok/runtime-snapshot';

const writeJsonl = async (lines: unknown[]): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-runtime-snapshot-'));
  const filePath = path.join(dir, 'session.jsonl');
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
  return filePath;
};

describe('agent runtime snapshots', () => {
  it('keeps Claude JSONL snapshot behavior behind the Claude provider', async () => {
    const jsonlPath = await writeJsonl([
      {
        timestamp: '2026-05-02T07:37:01.000Z',
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Claude finished the task.' }],
          stop_reason: 'end_turn',
        },
      },
    ]);

    const snapshot = await readClaudeRuntimeSnapshot(jsonlPath);

    expect(snapshot).toMatchObject({
      idle: true,
      stale: false,
      lastAssistantSnippet: 'Claude finished the task.',
      currentAction: { toolName: null, summary: 'Claude finished the task.' },
    });
  });

  it('reads Codex assistant snippets from event_msg agent_message records', async () => {
    const jsonlPath = await writeJsonl([
      {
        timestamp: '2026-05-02T07:37:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'implement it' },
      },
      {
        timestamp: '2026-05-02T07:37:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Codex finished the task.' },
      },
      {
        timestamp: '2026-05-02T07:37:03.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
    ]);

    const snapshot = await readCodexRuntimeSnapshot(jsonlPath);

    expect(snapshot).toMatchObject({
      idle: true,
      stale: false,
      lastAssistantSnippet: 'Codex finished the task.',
      currentAction: null,
      reset: false,
    });
  });

  it('reports Codex in-flight command actions from unmatched exec begin events', async () => {
    const jsonlPath = await writeJsonl([
      {
        timestamp: '2026-05-02T07:38:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'run tests' },
      },
      {
        timestamp: '2026-05-02T07:38:02.000Z',
        type: 'event_msg',
        payload: { type: 'exec_command_begin', call_id: 'exec-1', command: 'pnpm test' },
      },
    ]);

    const snapshot = await readCodexRuntimeSnapshot(jsonlPath);

    expect(snapshot.idle).toBe(false);
    expect(snapshot.currentAction).toEqual({ toolName: 'Bash', summary: '$ pnpm test' });
  });

  it('marks Codex snapshots as reset when a user message follows the last assistant output', async () => {
    const jsonlPath = await writeJsonl([
      {
        timestamp: '2026-05-02T07:39:01.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Previous answer.' },
      },
      {
        timestamp: '2026-05-02T07:39:02.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'next task' },
      },
    ]);

    const snapshot = await readCodexRuntimeSnapshot(jsonlPath);

    expect(snapshot.reset).toBe(true);
    expect(snapshot.lastAssistantSnippet).toBe('Previous answer.');
    expect(snapshot.currentAction).toBeNull();
  });
});

describe('Claude snapshot — background work and turn tail', () => {
  const started = (id: string) => ({
    type: 'user',
    timestamp: '2026-09-26T05:00:00.000Z',
    message: { content: [{ type: 'tool_result', content: `Command running in background with ID: ${id}.` }] },
    toolUseResult: { backgroundTaskId: id },
  });
  const endTurn = (text: string) => ({
    type: 'assistant',
    timestamp: '2026-09-26T05:01:00.000Z',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  });
  const done = (id: string) => ({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-09-26T05:02:00.000Z',
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
  });

  it('counts a background shell started 20 turns and >8 KB earlier', async () => {
    const turns = Array.from({ length: 20 }, (_, i) => endTurn(`turn ${i} ${'x'.repeat(2000)}`));
    const jsonlPath = await writeJsonl([started('bfar1'), ...turns]);
    const snapshot = await readClaudeRuntimeSnapshot(jsonlPath, { force: true });
    expect(snapshot.openBackgroundTasks).toBe(1);
    expect(snapshot.backgroundActivityAt).toEqual(expect.any(Number));
  });

  it('keeps the count on a cache hit and drops it once the task ends', async () => {
    const jsonlPath = await writeJsonl([started('b1'), endTurn('waiting')]);
    await readClaudeRuntimeSnapshot(jsonlPath);
    expect((await readClaudeRuntimeSnapshot(jsonlPath)).openBackgroundTasks).toBe(1);
    await fs.appendFile(jsonlPath, JSON.stringify(done('b1')) + '\n');
    const after = await readClaudeRuntimeSnapshot(jsonlPath);
    expect(after.openBackgroundTasks).toBe(0);
    expect(after.backgroundActivityAt).toBeNull();
  });

  it('returns the END of the last message as the tail, where the head snippet cuts it off', async () => {
    const text = `${'Long report line.\n'.repeat(40)}\nBLOCKED: gate red — needs X`;
    const jsonlPath = await writeJsonl([endTurn(text)]);
    const snapshot = await readClaudeRuntimeSnapshot(jsonlPath, { force: true });
    expect(snapshot.lastAssistantSnippet).not.toContain('BLOCKED:');
    expect(snapshot.lastAssistantTail?.endsWith('BLOCKED: gate red — needs X')).toBe(true);
    expect(snapshot.lastAssistantTail!.length).toBeLessThanOrEqual(600);
  });

  it('reads the tail of a final message longer than the 8 KB window', async () => {
    const text = `${'y'.repeat(20_000)}\nDONE: shipped`;
    const jsonlPath = await writeJsonl([endTurn('earlier'), endTurn(text)]);
    const snapshot = await readClaudeRuntimeSnapshot(jsonlPath, { force: true });
    expect(snapshot.lastAssistantTail?.endsWith('DONE: shipped')).toBe(true);
  });

  it('has no tail once a new prompt follows the last answer', async () => {
    const jsonlPath = await writeJsonl([
      endTurn('DONE: old'),
      { type: 'user', timestamp: '2026-09-26T05:03:00.000Z', message: { content: 'next task' } },
    ]);
    expect((await readClaudeRuntimeSnapshot(jsonlPath, { force: true })).lastAssistantTail).toBeNull();
  });
});

describe('Codex and Grok turn tails', () => {
  it('returns the current turn\'s last Codex agent_message, newlines kept', async () => {
    const jsonlPath = await writeJsonl([
      { timestamp: '2026-09-26T05:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: '2026-09-26T05:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Gate is red.\n\nBLOCKED: gate red — needs X' } },
      { timestamp: '2026-09-26T05:01:01.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ]);
    const snapshot = await readCodexRuntimeSnapshot(jsonlPath);
    expect(snapshot.lastAssistantTail?.split('\n').at(-1)).toBe('BLOCKED: gate red — needs X');
  });

  it('has no Codex tail when the last event is a new user message', async () => {
    const jsonlPath = await writeJsonl([
      { timestamp: '2026-09-26T05:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'DONE: old' } },
      { timestamp: '2026-09-26T05:02:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'next' } },
    ]);
    expect((await readCodexRuntimeSnapshot(jsonlPath)).lastAssistantTail ?? null).toBeNull();
  });

  it('returns the Grok turn\'s last assistant message and none after a new prompt', () => {
    const base = { seq: 0, id: 'x' };
    const ended = summarizeGrokEntries([
      { ...base, type: 'user-message', timestamp: 1, text: 'go' },
      { ...base, type: 'assistant-message', timestamp: 2, markdown: 'Work done.\n\nBLOCKED: gate red — needs X' },
    ] as never, 3);
    expect(ended.lastAssistantTail?.split('\n').at(-1)).toBe('BLOCKED: gate red — needs X');
    const next = summarizeGrokEntries([
      { ...base, type: 'assistant-message', timestamp: 2, markdown: 'DONE: old' },
      { ...base, type: 'user-message', timestamp: 3, text: 'next' },
    ] as never, 4);
    expect(next.lastAssistantTail).toBeNull();
  });
});
