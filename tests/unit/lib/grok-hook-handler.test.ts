import { describe, expect, it } from 'vitest';
import { processGrokHookPayload, shouldEmitGrokHookEvent } from '@/lib/providers/grok/hook-handler';
import {
  grokHookEvent,
  parseGrokToolActivity,
  translateGrokHookEvent,
  type IGrokHookPayload,
} from '@/lib/providers/grok/hook-payload';

const SESSION_ID = '01a008c3-8e98-7220-a0d3-e0b36fa3aa99';

/** The camelCase envelope grok pipes on stdin, with its snake_case event value. */
const payload = (over: Partial<IGrokHookPayload> = {}): IGrokHookPayload => ({
  sessionId: SESSION_ID,
  cwd: '/repo',
  workspaceRoot: '/repo',
  permissionMode: 'default',
  ...over,
});

describe('grokHookEvent', () => {
  it('reads the snake_case value grok actually sends', () => {
    expect(grokHookEvent('session_start')).toBe('session_start');
    expect(grokHookEvent('pre_compact')).toBe('pre_compact');
    expect(grokHookEvent('post_tool_use')).toBe('post_tool_use');
  });

  it('also accepts the PascalCase spelling the hook file registers under', () => {
    expect(grokHookEvent('StopCancelled')).toBe('stop_cancelled');
    expect(grokHookEvent('UserPromptSubmit')).toBe('user_prompt_submit');
  });

  it('returns null for an event purplemux does not map', () => {
    expect(grokHookEvent('permission_denied')).toBeNull();
    expect(grokHookEvent(undefined)).toBeNull();
  });
});

describe('translateGrokHookEvent', () => {
  const cases: Array<[string, unknown]> = [
    ['session_start', { kind: 'session-start' }],
    ['user_prompt_submit', { kind: 'prompt-submit' }],
    ['stop', { kind: 'stop' }],
    ['stop_failure', { kind: 'stop' }],
    ['stop_cancelled', { kind: 'interrupt' }],
    ['session_end', { kind: 'interrupt' }],
    ['pre_compact', { kind: 'pre-compact' }],
    ['post_compact', { kind: 'post-compact' }],
  ];

  it.each(cases)('maps %s', (event, expected) => {
    expect(translateGrokHookEvent(payload({ hookEventName: event }))).toEqual(expected);
  });

  it('maps a waiting permission prompt to needs-input', () => {
    expect(translateGrokHookEvent(payload({
      hookEventName: 'notification',
      notificationType: 'permission_prompt',
    }))).toEqual({ kind: 'notification', notificationType: 'permission_prompt' });
  });

  it('treats the idle and task-complete pings as a settle', () => {
    for (const notificationType of ['idle_prompt', 'task_complete']) {
      expect(translateGrokHookEvent(payload({ hookEventName: 'notification', notificationType })))
        .toEqual({ kind: 'stop' });
    }
  });

  it('ignores a notification type it does not recognise', () => {
    expect(translateGrokHookEvent(payload({ hookEventName: 'notification', notificationType: 'other' }))).toBeNull();
  });

  it('produces no work-state event for tool activity', () => {
    expect(translateGrokHookEvent(payload({ hookEventName: 'post_tool_use', toolName: 'search_replace' }))).toBeNull();
  });

  it('ignores every event that fired inside a subagent', () => {
    expect(translateGrokHookEvent(payload({ hookEventName: 'stop', subagentType: 'explore' }))).toBeNull();
  });
});

describe('processGrokHookPayload', () => {
  it('carries the session id on every event', () => {
    const { translation } = processGrokHookPayload(payload({ hookEventName: 'stop' }));
    expect(translation.meta).toMatchObject({ sessionId: SESSION_ID });
  });

  it('records the prompt as the tab summary and last user message', () => {
    const { translation } = processGrokHookPayload(payload({
      hookEventName: 'user_prompt_submit',
      prompt: 'migrate the provider',
    }));
    expect(translation.meta).toMatchObject({
      lastUserMessage: 'migrate the provider',
      agentSummary: 'migrate the provider',
    });
  });

  it('reports a running session with its cwd on session_start', () => {
    const { result, translation } = processGrokHookPayload(payload({ hookEventName: 'session_start' }));
    expect(result.ok).toBe(true);
    expect(translation.sessionInfo).toMatchObject({ status: 'running', sessionId: SESSION_ID, cwd: '/repo' });
  });

  it('reports a subagent event as skipped without a work-state event', () => {
    const { result, translation } = processGrokHookPayload(payload({
      hookEventName: 'stop',
      subagentType: 'explore',
    }));
    expect(result).toEqual({ ok: false, reason: 'subagent' });
    expect(translation.event).toBeUndefined();
  });

  it('reports an unmapped event as skipped', () => {
    const { result } = processGrokHookPayload(payload({ hookEventName: 'permission_denied' }));
    expect(result).toEqual({ ok: false, reason: 'unknown-event' });
  });
});

describe('shouldEmitGrokHookEvent', () => {
  it('settles on idle_prompt only while the tab is still busy', () => {
    const idle = payload({ hookEventName: 'notification', notificationType: 'idle_prompt' });
    expect(shouldEmitGrokHookEvent(idle, 'busy')).toBe(true);
    expect(shouldEmitGrokHookEvent(idle, 'ready-for-review')).toBe(false);
    expect(shouldEmitGrokHookEvent(idle, 'idle')).toBe(false);
  });

  it('always emits a real turn end', () => {
    expect(shouldEmitGrokHookEvent(payload({ hookEventName: 'stop' }), 'idle')).toBe(true);
    expect(shouldEmitGrokHookEvent(payload({ hookEventName: 'stop_cancelled' }), 'idle')).toBe(true);
  });

  it('always emits a permission prompt', () => {
    const perm = payload({ hookEventName: 'notification', notificationType: 'permission_prompt' });
    expect(shouldEmitGrokHookEvent(perm, 'idle')).toBe(true);
  });
});

describe('parseGrokToolActivity', () => {
  it('reads the camelCase tool fields grok sends', () => {
    expect(parseGrokToolActivity({
      hookEventName: 'post_tool_use',
      toolName: 'search_replace',
      toolInput: { file_path: 'note.txt', old_string: 'world', new_string: 'grok' },
      toolResult: { type: 'SearchReplace' },
    })).toMatchObject({ tool: 'search_replace', paths: ['note.txt'], failed: false });
  });

  it('reads the read tool\'s own path field name', () => {
    expect(parseGrokToolActivity({ toolName: 'read_file', toolInput: { target_file: 'note.txt' } }))
      .toMatchObject({ paths: ['note.txt'] });
  });

  it('carries a command identity for a shell call and reports its exit code', () => {
    const activity = parseGrokToolActivity({
      toolName: 'run_terminal_command',
      toolInput: { command: 'wc  -l   note.txt' },
      toolResult: { exit_code: 1 },
    });
    expect(activity).toMatchObject({ tool: 'run_terminal_command', failed: true, commandPreview: '$ wc -l note.txt'.slice(2) });
    expect(activity?.commandKey).toHaveLength(16);
  });

  it('treats an unrecognised result envelope as success rather than a false failure', () => {
    expect(parseGrokToolActivity({ toolName: 'grep', toolResult: { something: 'new' } })?.failed).toBe(false);
  });

  it('returns null when there is no tool name', () => {
    expect(parseGrokToolActivity({ hookEventName: 'stop' })).toBeNull();
  });
});
