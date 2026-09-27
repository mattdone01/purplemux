import { describe, expect, it } from 'vitest';
import {
  AGENT_STALL_WINDOW_MS,
  IDLE_NUDGE_DEFAULT_MS,
  SHELL_STALL_BACKSTOP_MS,
  classifyTurnEnd,
  extractTurnMarker,
  holdsOffStall,
  isBackgroundWaitStalled,
  parseIdleNudgeMinutes,
} from '@/lib/turn-end';

const input = (tail: string | null | undefined, open = 0, jobs = 0, transcript = true, watches = 0) => ({
  tail,
  transcript,
  openBackgroundTasks: open,
  liveRegisteredJobs: jobs,
  armedWatches: watches,
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
    expect(classifyTurnEnd(input('Waiting on the gate.', 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 1, liveRegisteredJobs: 0, armedWatches: 0 });
  });

  it('is waiting with no marker and a live registered tab bg job', () => {
    expect(classifyTurnEnd(input('Waiting.', 0, 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 0, liveRegisteredJobs: 1, armedWatches: 0 });
  });

  it('is waiting with no marker and an armed purplemux watch (L49)', () => {
    expect(classifyTurnEnd(input('Watching the PR.', 0, 0, true, 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 0, liveRegisteredJobs: 0, armedWatches: 1 });
  });

  it('lets a marker win over an armed watch', () => {
    expect(classifyTurnEnd(input('DONE: merged', 0, 0, true, 2))).toEqual({ kind: 'turn-marker', lines: ['DONE: merged'] });
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

describe('idle nudge window (L49)', () => {
  it('defaults to 15 min', () => {
    expect(IDLE_NUDGE_DEFAULT_MS).toBe(15 * 60 * 1000);
  });

  it.each([
    ['15', 15 * 60 * 1000],
    ['5', 5 * 60 * 1000],
    [' 30 ', 30 * 60 * 1000],
    ['0.05', 3000],
    ['1440', 1440 * 60 * 1000],
  ])('reads %j minutes', (raw, ms) => {
    expect(parseIdleNudgeMinutes(raw)).toBe(ms);
  });

  it.each([null, undefined, '', '0', '0.0', '-5', '1441', 'abc', '15m', '1e3', 'Infinity', 'NaN'])('refuses %j (the caller keeps the default)', (raw) => {
    expect(parseIdleNudgeMinutes(raw)).toBeNull();
  });
});

describe('holdsOffStall (L49)', () => {
  it('holds while a registered job lives or a watch is armed, and not otherwise', () => {
    expect(holdsOffStall(1, 0)).toBe(true);
    expect(holdsOffStall(0, 1)).toBe(true);
    expect(holdsOffStall(0, 0)).toBe(false);
  });
});

describe('derived watchdog timers (review r1 findings 2 and 4)', () => {
  const stop = { name: 'stop', seq: 4 };
  const ready = { kind: 'ready-for-review', at: 1_000, seq: 4 };

  it('idle nudge: due once the window passed on the stop that is still the latest event, and not after it was sent', async () => {
    const { idleNudgeDue } = await import('@/lib/turn-end');
    expect(idleNudgeDue(ready, stop, 'ready-for-review', 900, 1_899)).toBe(false);
    expect(idleNudgeDue(ready, stop, 'ready-for-review', 900, 1_900)).toBe(true);
    expect(idleNudgeDue({ ...ready, idleNudgeSentSeq: 4 }, stop, 'ready-for-review', 900, 5_000)).toBe(false);
    expect(idleNudgeDue({ ...ready, idleNudgeSentSeq: 3 }, stop, 'ready-for-review', 900, 5_000)).toBe(true);
    expect(idleNudgeDue(ready, { name: 'prompt-submit', seq: 5 }, 'busy', 900, 5_000)).toBe(false);
    expect(idleNudgeDue(ready, { name: 'stop', seq: 5 }, 'ready-for-review', 900, 5_000)).toBe(false);
    expect(idleNudgeDue(ready, stop, 'idle', 900, 5_000)).toBe(false);
    expect(idleNudgeDue({ ...ready, kind: 'turn-marker' }, stop, 'ready-for-review', 900, 5_000)).toBe(false);
    expect(idleNudgeDue(null, stop, 'ready-for-review', 900, 5_000)).toBe(false);
  });

  it('long wait: due on a WAITING stop past the backstop, once per stop', async () => {
    const { longWaitDue } = await import('@/lib/turn-end');
    const waiting = { kind: 'waiting', at: 1_000, seq: 4 };
    expect(longWaitDue(waiting, stop, 'busy', 900, 1_899)).toBe(false);
    expect(longWaitDue(waiting, stop, 'busy', 900, 1_900)).toBe(true);
    expect(longWaitDue({ ...waiting, longWaitSentSeq: 4 }, stop, 'busy', 900, 9_000)).toBe(false);
    expect(longWaitDue(waiting, { name: 'prompt-submit', seq: 5 }, 'busy', 900, 9_000)).toBe(false);
  });

  it.each([['4', 4 * 3_600_000], ['0.5', 1_800_000], ['168', 168 * 3_600_000]])('reads %j backstop hours', async (raw, ms) => {
    const { parseWaitBackstopHours } = await import('@/lib/turn-end');
    expect(parseWaitBackstopHours(raw)).toBe(ms);
  });

  it.each([null, '', '0', '169', 'x', '-1'])('refuses %j backstop hours', async (raw) => {
    const { parseWaitBackstopHours, WAIT_BACKSTOP_DEFAULT_MS } = await import('@/lib/turn-end');
    expect(parseWaitBackstopHours(raw)).toBeNull();
    expect(WAIT_BACKSTOP_DEFAULT_MS).toBe(4 * 3_600_000);
  });
});
