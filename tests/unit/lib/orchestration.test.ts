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

  it('builds liveness nudges with detail and capture command', () => {
    const stalled = buildNudgeMessage('stalled', 'tab-3', 'drain', 'ws-abc', 'probe "drain" reports no progress for ~19 min (threshold 15 min)');
    expect(stalled).toContain('STALLED');
    expect(stalled).toContain('no progress for ~19 min');
    expect(stalled).toContain('purplemux tab result -w ws-abc tab-3');

    const died = buildNudgeMessage('bg-died', 'tab-3', 'drain', 'ws-abc', 'pid 4242 exited with code 137');
    expect(died).toContain('BACKGROUND JOB DIED');
    expect(died).toContain('pid 4242 exited with code 137');

    const failing = buildNudgeMessage('probe-failed', 'tab-3', 'drain', 'ws-abc', 'probe "drain" failed 3x in a row');
    expect(failing).toContain('PROBE FAILING');
    expect(failing).toContain('failed 3x');
    expect(failing).toContain('not a green light');
  });

  it('falls back to generic detail for liveness nudges', () => {
    for (const kind of ['stalled', 'probe-failed', 'bg-died'] as const) {
      const msg = buildNudgeMessage(kind, 'tab-3', 'drain', 'ws-abc');
      expect(msg).toContain(NUDGE_PREFIX);
      expect(msg.length).toBeGreaterThan(50);
    }
  });
});

describe('kickoff template liveness doctrine', () => {
  it('tells the orchestrator to arm both watchers at dispatch', () => {
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('TWO watchers AT DISPATCH');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('purplemux tab probe set');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('purplemux tab bg add');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('BACKGROUND JOB DIED');
    expect(DEFAULT_KICKOFF_TEMPLATE).toContain('needsHuman=true');
  });
});
