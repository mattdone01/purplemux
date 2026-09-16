import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexParser, parseCodexContent } from '@/lib/session-parser-codex';

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({
  timestamp: '2026-09-09T08:00:00.000Z', type, payload,
}) + '\n';
const response = (text: string, extra: Record<string, unknown> = {}) => line('response_item', {
  type: 'message', role: 'assistant', phase: 'commentary',
  content: [{ type: 'output_text', text }], ...extra,
});
const event = (text: string) => line('event_msg', { type: 'agent_message', message: text });
const messages = (content: string) => parseCodexContent(content)
  .filter((entry) => entry.type === 'assistant-message').map((entry) => entry.markdown);

describe('Codex public response messages', () => {
  it('shows modern progress and final responses without event_msg duplicates', () => {
    expect(messages(response('Checking the parser.') + response('Fixed and tested.', { phase: 'final_answer' })))
      .toEqual(['Checking the parser.', 'Fixed and tested.']);
  });

  it('supports older assistant response items with no phase', () => {
    expect(messages(response('Done.', { phase: undefined }))).toEqual(['Done.']);
  });

  it('does not surface instructions, analysis, tool-directed messages or encrypted content', () => {
    const content = response('Private', { role: 'developer' })
      + response('Context', { role: 'user' })
      + response('Private', { channel: 'analysis' })
      + response('Private', { phase: 'analysis' })
      + response('Internal tool input', { recipient: 'functions.exec' })
      + response('', { content: [{ type: 'encrypted_content', encrypted_content: 'secret' }] })
      + line('response_item', { type: 'agent_message', author: '/root/worker', content: [{ type: 'input_text', text: 'Internal handoff' }] });
    expect(messages(content)).toEqual([]);
  });

  it.each(['event-first', 'response-first'])('deduplicates legacy paired envelopes (%s)', (order) => {
    const pair = order === 'event-first' ? event('Checking.') + response('Checking.') : response('Checking.') + event('Checking.');
    expect(messages(pair)).toEqual(['Checking.']);
  });

  it('preserves repeated text in separate steps, turns, and same-source messages', () => {
    expect(messages(response('Checking.') + response('Checking.'))).toEqual(['Checking.', 'Checking.']);
    const boundary = line('event_msg', { type: 'task_started' });
    expect(messages(response('Checking.') + boundary + event('Checking.'))).toEqual(['Checking.', 'Checking.']);
    const tool = line('response_item', { type: 'function_call', name: 'read_file', call_id: 'c1', arguments: '{"path":"README.md"}' });
    expect(messages(response('Checking.') + tool + event('Checking.'))).toEqual(['Checking.', 'Checking.']);
  });

  it('deduplicates a paired message split across incremental reads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-public-messages-'));
    try {
      const file = path.join(dir, 'session.jsonl');
      await fs.writeFile(file, event('Checking.'));
      const parser = new CodexParser(file);
      expect((await parser.parseAll()).entries).toHaveLength(1);
      await fs.appendFile(file, response('Checking.') + response('Done.', { phase: 'final_answer' }));
      const increment = await parser.parseIncremental();
      expect(increment.newEntries).toHaveLength(1);
      expect(increment.newEntries[0]).toMatchObject({ type: 'assistant-message', markdown: 'Done.' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('appends a response-item-only commentary message during a live parse', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-commentary-'));
    try {
      const file = path.join(dir, 'session.jsonl');
      await fs.writeFile(file, response('Earlier progress.'));
      const parser = new CodexParser(file);
      await parser.parseAll();

      const commentary = response(
        'DEV is working again.\n\nI’m finishing the persistent helper fix.',
        {
          internal_chat_message_metadata_passthrough: {
            turn_id: 'turn-1',
            content_item_kinds: ['unknown'],
          },
        },
      );
      await fs.appendFile(file, commentary);

      const increment = await parser.parseIncremental();

      expect(increment.newEntries).toHaveLength(1);
      expect(increment.newEntries[0]).toMatchObject({
        type: 'assistant-message',
        markdown: 'DEV is working again.\n\nI’m finishing the persistent helper fix.',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('previews code-mode tool activity without running the source', () => {
    const entries = parseCodexContent(line('response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'c1',
      input: '// @exec: {"max_output_tokens": 1000}\ntext(await tools.exec_command({cmd:"pnpm test"}));\n' + 'x'.repeat(200),
    }));
    expect(entries[0]).toMatchObject({ type: 'tool-call', toolName: 'exec', status: 'pending' });
    if (entries[0].type !== 'tool-call') throw new Error('Expected tool call');
    expect(entries[0].summary).toContain('pnpm test');
    expect(entries[0].summary).not.toContain('@exec');
    expect(entries[0].summary.length).toBeLessThanOrEqual(166);
  });

  it('shows async user questions from their delivered message and suppresses protocol rows', () => {
    const callId = 'call-question-1';
    const prompt = 'Please run the route command, then reply “done”.\n- Done\n- Cannot run it now';
    const content = response('Before the question.')
      + line('response_item', {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: callId,
        arguments: JSON.stringify({
          questions: [{
            title: 'Please run the route command, then reply “done”.',
            options: ['Done', 'Cannot run it now'],
          }],
        }),
      })
      + line('event_msg', {
        type: 'item_completed',
        item: {
          type: 'AgentMessage',
          id: callId,
          content: [{ type: 'Text', text: prompt }],
          phase: 'final_answer',
          delivery: 'async',
          questions: [{
            title: 'Please run the route command, then reply “done”.',
            options: ['Done', 'Cannot run it now'],
          }],
        },
      })
      + line('response_item', {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ accepted: true }),
      })
      + response(prompt, { phase: 'final_answer' })
      + response('After the question.');

    const entries = parseCodexContent(content);

    expect(entries.map((entry) => entry.type)).toEqual([
      'assistant-message',
      'assistant-message',
      'assistant-message',
    ]);
    expect(messages(content)).toEqual([
      'Before the question.',
      prompt,
      'After the question.',
    ]);
  });

  it('suppresses an async-question acknowledgement when a chunk starts after its call', () => {
    const content = line('response_item', {
      type: 'function_call_output',
      call_id: 'call-before-chunk',
      output: JSON.stringify({ accepted: true }),
    });

    expect(parseCodexContent(content)).toEqual([]);
  });

  it('does not surface internal completed agent items as public chat', () => {
    const content = line('event_msg', {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: 'internal-message',
        content: [{ type: 'Text', text: 'Internal handoff' }],
        phase: 'analysis',
        delivery: 'internal',
      },
    });

    expect(parseCodexContent(content)).toEqual([]);
  });
});
