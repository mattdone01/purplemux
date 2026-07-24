import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KICKOFF_TEMPLATE,
  resolveKickoffTemplate,
  buildNudgeMessage,
  nudgeKindForTransition,
  NUDGE_PREFIX,
} from '@/lib/orchestration';

describe('resolveKickoffTemplate', () => {
  it('fills all placeholders', () => {
    const resolved = resolveKickoffTemplate(DEFAULT_KICKOFF_TEMPLATE, {
      workspaceId: 'ws-abc123',
      workspaceName: 'my-epic',
      task: 'Build the thing',
      maxWorkers: 4,
    });
    expect(resolved).toContain('ws-abc123');
    expect(resolved).toContain('my-epic');
    expect(resolved).toContain('Build the thing');
    expect(resolved).toContain('Max 4 concurrent workers');
    expect(resolved).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('replaces repeated placeholders', () => {
    const resolved = resolveKickoffTemplate('{{WORKSPACE_ID}} {{WORKSPACE_ID}}', {
      workspaceId: 'ws-x',
      workspaceName: 'n',
    });
    expect(resolved).toBe('ws-x ws-x');
  });

  it('defaults task and maxWorkers', () => {
    const resolved = resolveKickoffTemplate('{{TASK}}|{{MAX_WORKERS}}', {
      workspaceId: 'ws-x',
      workspaceName: 'n',
    });
    expect(resolved).toBe('(described in the next message)|3');
  });
});

describe('nudgeKindForTransition', () => {
  it.each([
    ['busy', 'needs-input', false, 'needs-input'],
    ['busy', 'ready-for-review', false, 'ready-for-review'],
    ['busy', 'idle', false, 'turn-ended'],
    ['idle', 'inactive', false, 'inactive'],
    ['busy', 'inactive', true, 'inactive'],
  ] as const)('%s -> %s (silent=%s) yields %s', (prev, next, silent, expected) => {
    expect(nudgeKindForTransition(prev, next, silent)).toBe(expected);
  });

  it.each([
    ['idle', 'busy', false],
    ['inactive', 'idle', false],
    ['busy', 'idle', true],
    ['busy', 'needs-input', true],
    ['busy', 'ready-for-review', true],
    ['unknown', 'inactive', false],
  ] as const)('%s -> %s (silent=%s) yields null', (prev, next, silent) => {
    expect(nudgeKindForTransition(prev, next, silent)).toBeNull();
  });
});

describe('buildNudgeMessage', () => {
  it('includes prefix, tab id, and capture command for actionable kinds', () => {
    for (const kind of ['needs-input', 'ready-for-review', 'turn-ended', 'stuck'] as const) {
      const msg = buildNudgeMessage(kind, 'tab-1', 'story-06', 'ws-abc');
      expect(msg).toContain(NUDGE_PREFIX);
      expect(msg).toContain('tab-1');
      expect(msg).toContain('story-06');
      expect(msg).toContain('purplemux tab result -w ws-abc tab-1');
    }
  });

  it('handles inactive without a capture command and unnamed tabs', () => {
    const msg = buildNudgeMessage('inactive', 'tab-2', '', 'ws-abc');
    expect(msg).toContain(NUDGE_PREFIX);
    expect(msg).toContain('unnamed');
    expect(msg).toContain('INACTIVE');
  });
});
