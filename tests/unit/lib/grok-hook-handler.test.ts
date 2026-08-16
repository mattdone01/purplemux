import { describe, expect, it } from 'vitest';
import {
  isGrokPermissionNotification,
  parseGrokToolActivity,
  translateGrokHookEvent,
} from '@/lib/providers/grok/hook-payload';
import { processGrokHookPayload, shouldEmitGrokHookEvent } from '@/lib/providers/grok/hook-handler';

describe('translateGrokHookEvent', () => {
  const cases: Array<[string, unknown]> = [
    ['SessionStart', { kind: 'session-start' }],
    ['UserPromptSubmit', { kind: 'prompt-submit' }],
    ['Stop', { kind: 'stop' }],
    ['StopFailure', { kind: 'stop' }],
    ['SessionEnd', { kind: 'interrupt' }],
    ['PreCompact', { kind: 'pre-compact' }],
    ['PostCompact', { kind: 'post-compact' }],
    ['PostToolUse', null],
    ['SubagentStop', null],
    ['CwdChanged', null],
  ];

  it.each(cases)('maps %s', (event, expected) => {
    expect(translateGrokHookEvent({ hook_event_name: event })).toEqual(expected);
  });

  it('leaves a background-delegation Notification out of the work-state machine', () => {
    expect(translateGrokHookEvent({
      hook_event_name: 'Notification',
      message: 'Delegation explore-3 finished',
    })).toBeNull();
  });

  it('maps a permission-style Notification to needs-input', () => {
    expect(translateGrokHookEvent({
      hook_event_name: 'Notification',
      message: 'Grok needs your permission to run bash',
    })).toEqual({ kind: 'notification', notificationType: 'permission_prompt' });
  });
});

describe('isGrokPermissionNotification', () => {
  it('only matches operator-facing requests', () => {
    expect(isGrokPermissionNotification('Approval required for edit_file')).toBe(true);
    expect(isGrokPermissionNotification('Background task done')).toBe(false);
    expect(isGrokPermissionNotification(null)).toBe(false);
  });
});

describe('processGrokHookPayload', () => {
  it('carries the prompt into meta and never patches a jsonl path', () => {
    const { result, translation } = processGrokHookPayload({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'a1b2c3d4e5f6',
      user_prompt: 'Add the grok provider',
      cwd: '/home/dev/purplemux',
    });

    expect(result).toEqual({ ok: true });
    expect(translation.event).toEqual({ kind: 'prompt-submit' });
    expect(translation.meta).toEqual({
      sessionId: 'a1b2c3d4e5f6',
      lastUserMessage: 'Add the grok provider',
      agentSummary: 'Add the grok provider',
    });
    expect(translation.meta?.jsonlPath).toBeUndefined();
  });

  it('publishes session info on SessionStart with a null transcript path', () => {
    const { translation } = processGrokHookPayload({
      hook_event_name: 'SessionStart',
      session_id: 'a1b2c3d4e5f6',
      source: 'resume',
      cwd: '/home/dev/purplemux',
    });

    expect(translation.sessionInfo).toEqual({
      status: 'running',
      sessionId: 'a1b2c3d4e5f6',
      jsonlPath: null,
      pid: null,
      startedAt: null,
      cwd: '/home/dev/purplemux',
    });
  });

  it('reports an unmapped event without losing the session id', () => {
    const { result, translation } = processGrokHookPayload({
      hook_event_name: 'PostToolUse',
      session_id: 'a1b2c3d4e5f6',
    });

    expect(result).toEqual({ ok: false, reason: 'unknown-event' });
    expect(translation.meta).toEqual({ sessionId: 'a1b2c3d4e5f6' });
  });
});

describe('shouldEmitGrokHookEvent', () => {
  it('drops a late SessionStart on a tab that is already working', () => {
    const payload = { hook_event_name: 'SessionStart', source: 'startup' };
    expect(shouldEmitGrokHookEvent(payload, 'busy')).toBe(false);
    expect(shouldEmitGrokHookEvent(payload, 'inactive')).toBe(true);
    expect(shouldEmitGrokHookEvent(payload, 'unknown')).toBe(true);
  });

  it('never re-idles a tab on a resume SessionStart', () => {
    expect(shouldEmitGrokHookEvent({ hook_event_name: 'SessionStart', source: 'resume' }, 'inactive')).toBe(false);
  });

  it('always emits terminal events', () => {
    expect(shouldEmitGrokHookEvent({ hook_event_name: 'Stop' }, 'busy')).toBe(true);
    expect(shouldEmitGrokHookEvent({ hook_event_name: 'SessionEnd' }, 'busy')).toBe(true);
  });
});

describe('parseGrokToolActivity', () => {
  it('collects grok path arguments and a command fingerprint', () => {
    const activity = parseGrokToolActivity({
      tool_name: 'edit_file',
      tool_input: { path: 'src/app.ts' },
      tool_output: { success: true, output: 'ok' },
    });

    expect(activity).toMatchObject({ tool: 'edit_file', paths: ['src/app.ts'], failed: false });
    expect(activity?.commandKey).toBeUndefined();
  });

  it('fingerprints a bash command without retaining it verbatim', () => {
    const activity = parseGrokToolActivity({
      tool_name: 'bash',
      tool_input: { command: 'pnpm   test' },
      tool_output: { success: false, error: 'exit 1' },
    });

    expect(activity).toMatchObject({ tool: 'bash', failed: true, commandPreview: 'pnpm test' });
    expect(activity?.commandKey).toHaveLength(16);
  });

  it('treats an error envelope as a failure and an unknown one as success', () => {
    expect(parseGrokToolActivity({ tool_name: 'bash', tool_output: { type: 'error-text', value: 'boom' } }))
      .toMatchObject({ failed: true });
    expect(parseGrokToolActivity({ tool_name: 'bash', tool_output: { weird: true } }))
      .toMatchObject({ failed: false });
  });

  it('ignores a payload with no tool name', () => {
    expect(parseGrokToolActivity({ tool_input: {} })).toBeNull();
  });
});
