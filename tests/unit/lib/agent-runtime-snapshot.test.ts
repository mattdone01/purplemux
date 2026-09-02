import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readClaudeRuntimeSnapshot, __testing } from '@/lib/providers/claude/runtime-snapshot';
import { readCodexRuntimeSnapshot } from '@/lib/providers/codex/runtime-snapshot';

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

describe('countOpenBackgroundTasks', () => {
  const { countOpenBackgroundTasks } = __testing;
  const user = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
  const notify = (id: string) => JSON.stringify({ type: 'user', message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } });

  it('counts a background command until its task notification arrives', () => {
    const lines = [user('Command running in background with ID: bx3bq. Output is being written to /tmp/x')];
    expect(countOpenBackgroundTasks(lines)).toBe(1);
    expect(countOpenBackgroundTasks([...lines, notify('bx3bq')])).toBe(0);
  });

  it('counts an async subagent the same way', () => {
    const lines = [user('Async agent launched successfully.\nagentId: a44c861f (internal ID)')];
    expect(countOpenBackgroundTasks(lines)).toBe(1);
    expect(countOpenBackgroundTasks([...lines, notify('a44c861f')])).toBe(0);
  });

  it('ignores sidechain entries, assistant text and a notification with no seen start', () => {
    const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Command running in background with ID: fake' }] } });
    const side = JSON.stringify({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: side1' }] } });
    expect(countOpenBackgroundTasks([assistant, side, notify('unseen')])).toBe(0);
  });
});
