import { describe, expect, it } from 'vitest';
import { AGENT_STALL_WINDOW_MS, SHELL_STALL_BACKSTOP_MS, classifyTurnEnd, extractTurnMarker, isBackgroundWaitStalled } from '@/lib/turn-end';

const input = (tail: string | null | undefined, open = 0, jobs = 0, transcript = true) => ({
  tail,
  transcript,
  openBackgroundTasks: open,
  liveRegisteredJobs: jobs,
});

describe('extractTurnMarker', () => {
  it.each(['DONE: shipped', 'BLOCKED: gate red — needs X', 'NEEDS-DECISION: a or b — options a/b', 'READY-TO-MERGE: repo#1 @ abc'])(
    'returns the last line when it starts with a marker: %s',
    (line) => {
      expect(extractTurnMarker(`Report.\n\n${line}\n`)).toEqual([line]);
    },
  );

  it('ignores a marker that is not on the last non-empty line', () => {
    expect(extractTurnMarker('DONE: earlier\nstill working on the rest')).toBeNull();
  });

  it('ignores a marker word mid-line and lower-case forms', () => {
    expect(extractTurnMarker('the story is DONE: see above')).toBeNull();
    expect(extractTurnMarker('done: shipped')).toBeNull();
  });

  it('strips markdown emphasis and a quote marker around the line', () => {
    expect(extractTurnMarker('**DONE: shipped**')).toEqual(['DONE: shipped']);
    expect(extractTurnMarker('> `BLOCKED: x — needs y`')).toEqual(['BLOCKED: x — needs y']);
  });

  it('carries READY-TO-MERGE lines directly above DONE, at most five', () => {
    const ready = Array.from({ length: 7 }, (_, i) => `READY-TO-MERGE: repo#${i} @ sha${i}`);
    expect(extractTurnMarker(['intro', ...ready, 'DONE: all ready'].join('\n'))).toEqual([...ready.slice(2), 'DONE: all ready']);
    expect(extractTurnMarker(['READY-TO-MERGE: a#1', 'text between', 'DONE: x'].join('\n'))).toEqual(['DONE: x']);
  });

  it('caps a run that ends on READY-TO-MERGE at five lines in total', () => {
    const ready = Array.from({ length: 7 }, (_, i) => `READY-TO-MERGE: repo#${i}`);
    expect(extractTurnMarker(ready.join('\n'))).toEqual(ready.slice(2));
  });

  it('clips a marker line to 300 characters', () => {
    const [line] = extractTurnMarker(`DONE: ${'x'.repeat(400)}`)!;
    expect(line).toHaveLength(301);
    expect(line.endsWith('…')).toBe(true);
  });

  it('returns null for an empty or missing tail', () => {
    expect(extractTurnMarker(null)).toBeNull();
    expect(extractTurnMarker(undefined)).toBeNull();
    expect(extractTurnMarker('\n  \n')).toBeNull();
  });
});

describe('classifyTurnEnd', () => {
  it('lets a marker win over open background work', () => {
    expect(classifyTurnEnd(input('DONE: x', 2, 1))).toEqual({ kind: 'turn-marker', lines: ['DONE: x'] });
  });

  it('is waiting with no marker and an open provider task', () => {
    expect(classifyTurnEnd(input('Waiting on the gate.', 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 1, liveRegisteredJobs: 0 });
  });

  it('is waiting with no marker and a live registered tab bg job', () => {
    expect(classifyTurnEnd(input('Waiting.', 0, 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 0, liveRegisteredJobs: 1 });
  });

  it('is ready-for-review with no marker and nothing open', () => {
    expect(classifyTurnEnd(input('All good.'))).toEqual({ kind: 'ready-for-review', transcript: true });
  });

  it('marks the no-transcript fallback', () => {
    expect(classifyTurnEnd(input(undefined, 0, 0, false))).toEqual({ kind: 'ready-for-review', transcript: false });
  });
});

describe('isBackgroundWaitStalled (architect ruling C)', () => {
  const now = 10_000_000_000;
  const kinds = (shell: number, agent: number, monitor: number) => ({ shell, agent, monitor });

  it('leaves a tab with nothing open to the default rule', () => {
    expect(isBackgroundWaitStalled(undefined, null, now)).toBeNull();
    expect(isBackgroundWaitStalled(kinds(0, 0, 0), now - 1, now)).toBeNull();
  });

  it('stalls an open agent after 15 min without any activity, not before', () => {
    expect(isBackgroundWaitStalled(kinds(0, 1, 0), now - AGENT_STALL_WINDOW_MS + 1, now)).toBe(false);
    expect(isBackgroundWaitStalled(kinds(0, 1, 0), now - AGENT_STALL_WINDOW_MS, now)).toBe(true);
  });

  it('judges a tab with an agent and a shell by the agent window', () => {
    expect(isBackgroundWaitStalled(kinds(1, 1, 0), now - AGENT_STALL_WINDOW_MS, now)).toBe(true);
  });

  it('never stalls a silent shell inside the 90 min backstop, and stalls it after', () => {
    expect(isBackgroundWaitStalled(kinds(1, 0, 0), now - 40 * 60 * 1000, now)).toBe(false);
    expect(isBackgroundWaitStalled(kinds(1, 0, 1), now - SHELL_STALL_BACKSTOP_MS, now)).toBe(true);
  });

  it('never stalls on Monitors alone', () => {
    expect(isBackgroundWaitStalled(kinds(0, 0, 2), now - 10 * SHELL_STALL_BACKSTOP_MS, now)).toBe(false);
  });

  it('treats unknown activity as silence', () => {
    expect(isBackgroundWaitStalled(kinds(0, 1, 0), null, now)).toBe(true);
  });
});
